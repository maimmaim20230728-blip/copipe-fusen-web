'use strict';
/* 便利クリップメモ・そよぎ content script
   - 通常ページ: Shadow DOM のオーバーレイパネル(常に最前面・ドラッグ移動・リサイズ可)
   - panel.html(拡張ページ): 同じUIを全画面で表示(chrome:// などへの逃げ道)
   - ページ上のコピー/カット操作を拾って履歴に送る(パスワード欄は除外)
   利用者の文字は必ず textContent で描画する(innerHTML に入れない)。 */
(function () {

  if (window.__soyogiFusenLoaded) return;
  window.__soyogiFusenLoaded = true;

  var L = (typeof self !== 'undefined' && self.SoyogiFusenLogic) || window.SoyogiFusenLogic;
  if (!L) return;

  /* Web版(copipe_fusen_web)はこのフラグを立ててから読み込む */
  var IS_WEB_APP = window.__SOYOGI_FUSEN_WEB === true;
  var IS_PAGE_MODE = location.protocol === 'chrome-extension:' || IS_WEB_APP;
  /* iframe内ではコピー捕捉だけを行い、パネルUIはトップフレームのみ */
  var IS_TOP = IS_PAGE_MODE || (function () {
    try { return window === window.top; } catch (e) { return false; }
  })();

  /* ---------- 状態 ---------- */
  var host = null, shadow = null, panelEl = null, listEl = null, toastEl = null;
  var tabClipsEl = null, tabMemosEl = null, btnImportEl = null, btnNewMemoEl = null;
  var sortBoxEl = null, fileInputEl = null;
  var visible = false;
  var currentTab = 'clips';           // 'clips' | 'memos'
  var sortMode = { clips: 'new', memos: 'new' };   // タブごとに覚える
  var data = { clips: [], memos: [] };
  var savedPanelState = null;         // {left, top, width, height, tab}
  var editingId = null;               // 編集はcomposerと同じく状態駆動で描画する
  var editKind = null;                // 'clip' | 'memo'
  var editDraft = '';
  var editFocusPending = false;
  var editSaving = false;             // 保存の返事を待っている間(二重に送らない)
  var composerOpen = false;
  var composerDraft = '';
  var composerFocusPending = false;
  var composerSaving = false;
  var paletteOpenId = null;
  var confirmDeleteId = null;
  var confirmDeleteAt = 0;            // 「削除する」に切り替えた時刻
  var confirmDeleteTimer = null;
  var reorderDragging = false;        // 掴んで動かしている間は再描画しない
  var pendingRender = false;
  var focusBeforeOpen = null;         // パネルを開く前にフォーカスがあった場所(閉じたら戻す)
  var toastTimer = null;
  var saveStateTimer = null;
  var resizeClampTimer = null;

  var SAVE_FAIL_MSG = '保存できませんでした。ページを再読み込みしてください';
  /* 🗑️をダブルクリックすると、2打目が切り替わった「削除する」に当たって素通りする。
     切り替わってからこの間のクリックは受け付けない */
  var CONFIRM_GUARD_MS = 600;
  var CONFIRM_RESET_MS = 5000;        // 「削除する」を自動で🗑️に戻すまで
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  var COMPOSER_KEY = '__composer__';  // 新しいメモの入力カードのフォーカス目印

  /* ---------- スタイル ---------- */
  /* 🔴 パネルの最小サイズ。CSSと位置復元の両方で使う(片方だけ直すと、
        縮めても再表示で元に戻る不具合になる) */
  var MIN_W = 100, MIN_H = 170;

  var CSS = [
    '* { box-sizing: border-box; margin: 0; padding: 0;',
    '    font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Meiryo", sans-serif; }',
    'button { -webkit-appearance: none; appearance: none; }',
    '.panel {',
    '  position: fixed; top: 16px; right: 16px; width: 380px; height: 540px;',
    /* 狭くしても使えるよう、下の @container で表示を詰める */
    '  min-width: ' + MIN_W + 'px; min-height: ' + MIN_H + 'px;',
    '  max-width: 96vw; max-height: 94vh;',
    '  container-type: inline-size;',
    '  background: #ffffff; border: 1px solid #c8d2cc; border-radius: 12px;',
    '  box-shadow: 0 8px 28px rgba(0,0,0,.28);',
    '  display: flex; flex-direction: column; overflow: hidden; resize: both;',
    '  color: #1b1b1b; font-size: 14px; line-height: 1.55; text-align: left;',
    '}',
    /* アイコンで開いたときにフォーカスを置く先。枠は出さない(中のボタンには下で枠を出す) */
    '.panel:focus { outline: none; }',
    /* 100vh だとSafariでツールバーが出ている間に下が隠れるので 100dvh で上書きする
       (100dvh を知らないブラウザは前の 100vh のまま) */
    '.panel.page-mode {',
    '  position: static; width: 100%; height: 100vh; height: 100dvh; max-width: none; max-height: none;',
    '  border: none; border-radius: 0; box-shadow: none; resize: none;',
    '  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);',
    '}',
    '.hdr { display: flex; align-items: center; gap: 7px; padding: 10px 12px;',
    '  background: #e8f5ec; border-bottom: 1px solid #d0e2d6; cursor: grab;',
    '  user-select: none; touch-action: none; flex: none; }',
    '.panel.page-mode .hdr { cursor: default; }',
    '.hdr .ttl { font-weight: 700; font-size: 14px; color: #1b1b1b; flex: 1;',
    '  white-space: nowrap; overflow: hidden; }',
    /* タイトルを隠す幅でも操作ボタンが右端に寄るようまとめておく */
    '.hdr-actions { display: flex; gap: 4px; margin-left: auto; flex: none; }',
    '.iconbtn { border: none; background: rgba(255,255,255,.6); width: 30px; height: 28px;',
    '  border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1; padding: 0;',
    '  display: inline-flex; align-items: center; justify-content: center; color: #333; flex: none; }',
    '.iconbtn:hover { background: rgba(255,255,255,.95); }',
    /* 🔴 白文字の緑・赤は WCAG AA(4.5:1)を満たす濃さ。#2e9e5b(3.4:1)・#d9534f(4.0:1)に戻さない */
    '.iconbtn.on { background: #23804a; }',
    '.iconbtn.danger { background: #c9302c; color: #fff; font-size: 12px; font-weight: 700;',
    '  width: auto; padding: 0 10px; }',
    '.tabs { display: flex; background: #f7faf8; border-bottom: 1px solid #ddd; flex: none; }',
    '.tab { flex: 1; border: none; background: none; padding: 10px 4px; text-align: center;',
    '  cursor: pointer; font-size: 13px; color: #555; border-bottom: 3px solid transparent; }',
    '.tab.on { border-bottom-color: #23804a; color: #1b6b3d; font-weight: 700; background: #fff; }',
    '.toolbar { padding: 8px 10px; display: flex; gap: 8px; flex: none; background: #fff;',
    '  align-items: stretch; }',
    '.sortbox { flex: none; max-width: 46%; border: 1px solid #c8d2cc; border-radius: 8px;',
    '  background: #f7faf8; color: #1b6b3d; font-size: 12px; font-weight: 600;',
    '  padding: 0 4px; cursor: pointer; }',
    '.lbl-min { display: none; }',
    '.btn { flex: 1; border: none; background: #23804a; color: #fff; font-size: 13px;',
    '  font-weight: 600; padding: 9px 10px; border-radius: 8px; cursor: pointer; }',
    '.btn:hover { background: #1d6f40; }',
    '.btn.small { flex: none; padding: 6px 16px; font-size: 12px; }',
    '.btn.sub { background: #e3efe7; color: #1b6b3d; }',
    '.btn.sub:hover { background: #d2e5d9; }',
    '.list { flex: 1; overflow-y: auto; padding: 8px 10px 14px; display: flex;',
    '  flex-direction: column; gap: 8px; background: #fafcfb; }',
    '.card { border-radius: 10px; border: 1px solid rgba(0,0,0,.14); padding: 9px 10px;',
    '  box-shadow: 0 1px 3px rgba(0,0,0,.12); flex: none; }',
    '.card .txt { white-space: pre-wrap; word-break: break-word; cursor: pointer;',
    '  font-size: 13px; }',
    '.card .txt.clamp { display: -webkit-box; -webkit-line-clamp: 4;',
    '  -webkit-box-orient: vertical; overflow: hidden; }',
    '.card textarea { width: 100%; min-height: 76px; border: 1px solid rgba(0,0,0,.3);',
    '  border-radius: 6px; padding: 7px; font-size: 13px; line-height: 1.5;',
    '  background: rgba(255,255,255,.92); color: #1b1b1b; resize: vertical; }',
    '.meta { display: flex; align-items: center; gap: 3px; margin-top: 7px; }',
    /* 時刻は付箋の色の上に重なる。いちばん暗い紫・ピンクの上でも 4.5:1 を超える濃さ */
    '.meta .time { font-size: 11px; color: rgba(0,0,0,.72); flex: 1; }',
    /* 掴んで並べ替えるための取っ手(「自分の並び」のときだけ出る)。
       🔴 指で掴めるよう当たり判定は24px以上。キーボードでは Alt+上下 で動かす */
    '.grip { flex: none; cursor: grab; touch-action: none; user-select: none;',
    '  border: none; background: none; min-width: 24px; min-height: 24px; padding: 0;',
    '  margin-right: 2px; border-radius: 6px; display: inline-flex; align-items: center;',
    '  justify-content: center; font-size: 14px; color: rgba(0,0,0,.62); line-height: 1; }',
    '.grip:hover { background: rgba(255,255,255,.6); }',
    '.grip:active { cursor: grabbing; }',
    '.card.dragging { opacity: .85; box-shadow: 0 6px 18px rgba(0,0,0,.32);',
    '  outline: 2px solid #23804a; outline-offset: 1px; }',
    '.list.reordering { cursor: grabbing; }',
    '.list.reordering .txt { cursor: grabbing; }',
    '.editrow { display: flex; gap: 6px; margin-top: 7px; justify-content: flex-end; }',
    '.palette { display: none; flex-wrap: wrap; gap: 6px; margin-top: 8px; padding-top: 8px;',
    '  border-top: 1px dashed rgba(0,0,0,.25); align-items: center; }',
    '.palette.open { display: flex; }',
    '.sw { width: 24px; height: 24px; border-radius: 50%; border: 2px solid rgba(0,0,0,.28);',
    '  cursor: pointer; padding: 0; flex: none; }',
    '.sw.on { outline: 2px solid #1b6b3d; outline-offset: 1px; }',
    '.sw.txtsw { border-radius: 5px; display: inline-flex; align-items: center;',
    '  justify-content: center; font-size: 13px; font-weight: 700; line-height: 1; }',
    '.palette .sep { width: 1px; height: 20px; background: rgba(0,0,0,.25); margin: 0 3px; }',
    '.empty { text-align: center; color: #5a6b60; padding: 30px 10px; font-size: 13px;',
    '  white-space: pre-line; }',
    '.toast { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);',
    '  background: #333; color: #fff; padding: 6px 16px; border-radius: 16px; font-size: 12px;',
    '  opacity: 0; transition: opacity .2s; pointer-events: none;',
    /* 🔴 nowrap+幅無制限だと狭いパネルで左右が切れて読めなくなる。折り返させる。
          🔴 width:max-content が無いと left:50% 起点で使える幅が半分と見なされ、
             細長く潰れて何行にもなる */
    '  width: max-content; max-width: calc(100% - 24px);',
    '  white-space: normal; word-break: break-word;',
    '  text-align: center; line-height: 1.5; }',
    '.toast.show { opacity: .95; }',
    /* キーボードで動かしたときの目印。付箋のどの色の上でも見えるよう白と濃い青の二重の輪にする
       (外側に出すと端のタブがパネルの縁で切れるので、タブだけ内側に描く) */
    'button:focus-visible, select:focus-visible, textarea:focus-visible {',
    '  outline: none; box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #174ea6; }',
    '.tab:focus-visible { box-shadow: inset 0 0 0 3px #174ea6; }',

    /* 🔴 @container は詳細度を上げないので、上書きしたい通常ルールより「後ろ」に
          置かないと効かない。必ずCSSの最後に置くこと(前に置くと半分死ぬ) */
    '@container (max-width: 330px) {',
    '  .lbl-full { display: none; }',
    '  .lbl-min { display: inline; }',
    '  .toolbar { padding: 6px 7px; gap: 6px; }',
    '  .btn { padding: 8px 6px; font-size: 12px; }',
    '  .sortbox { font-size: 11px; }',
    '  .hdr { padding: 7px 8px; gap: 5px; }',
    '  .tab { padding: 8px 2px; font-size: 12px; }',
    '  .list { padding: 6px 7px 10px; gap: 6px; }',
    '  .card { padding: 7px 8px; }',
    '  .meta .time { font-size: 10px; }',
    '  .iconbtn { width: 26px; height: 25px; font-size: 13px; }',
    '}',
    '@container (max-width: 240px) {',
    '  .hdr .ttl { display: none; }',
    '  .meta { flex-wrap: wrap; }',
    '  .meta .time { flex: 1 0 100%; margin-bottom: 3px; }',
    '}',
    /* 極細(半分幅)。ボタンが横に並ばないので縦積みにし、操作アイコンは折り返す */
    '@container (max-width: 165px) {',
    '  .toolbar { flex-direction: column; gap: 4px; padding: 5px 5px; }',
    '  .btn { width: 100%; padding: 7px 4px; font-size: 11px; }',
    '  .sortbox { max-width: none; width: 100%; font-size: 11px; padding: 3px 2px; }',
    '  .tab { font-size: 11px; padding: 7px 1px; }',
    '  .hdr { padding: 5px 6px; }',
    '  .list { padding: 5px 5px 8px; gap: 5px; }',
    '  .card { padding: 6px 6px; }',
    '  .card .txt { font-size: 12px; }',
    '  .card .txt.clamp { -webkit-line-clamp: 3; }',
    /* 22pxなら100px幅でも3つ並ぶ(24pxだと2つで折り返して3段になる) */
    '  .meta { gap: 2px; justify-content: flex-end; margin-top: 5px; }',
    '  .iconbtn { width: 22px; height: 21px; font-size: 11px; }',
    '  .toast { padding: 5px 8px; font-size: 11px; bottom: 8px; }',
    /* この幅でバックアップや窓の切り替えはしないので隠す(広げれば出る) */
    '  .bak, .win { display: none; }',
    '}'
  ].join('\n');

  /* ---------- 小道具 ---------- */
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /* act はフォーカスを戻すための目印(render()で作り直しても同じボタンに戻れる) */
  function iconBtn(glyph, title, onClick, on, act) {
    var b = el('button', 'iconbtn' + (on ? ' on' : ''));
    b.textContent = glyph;
    b.title = title;
    /* 絵文字だけだと読み上げで意味が伝わらないので、title と同じ名前を付ける */
    b.setAttribute('aria-label', title);
    if (act) b.dataset.act = act;
    b.addEventListener('click', onClick);
    return b;
  }

  function textBtn(label, onClick, extraClass, act) {
    var b = el('button', 'btn small' + (extraClass ? ' ' + extraClass : ''));
    b.textContent = label;
    if (act) b.dataset.act = act;
    b.addEventListener('click', onClick);
    return b;
  }

  /* 狭いときは短い方の文字だけがCSSで見える(@container) */
  function setTabLabel(node, full, min) {
    node.textContent = '';
    var f = el('span', 'lbl-full');
    f.textContent = full;
    var m = el('span', 'lbl-min');
    m.textContent = min;
    node.appendChild(f);
    node.appendChild(m);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 長い知らせ(保存できなかった・整理した件数など)は読み切れるよう長めに出す */
  function toast(msg) {
    if (!toastEl) return;
    var text = String(msg);
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); },
      Math.min(6000, Math.max(1700, text.length * 110)));
  }

  /* 拡張が更新・再読み込みされると、古いタブに残ったこのスクリプトは拡張と話せなくなる
     (chrome.runtime.id が消える)。Web版は自前のアダプタなので常に話せる */
  function extAlive() {
    if (IS_WEB_APP) return true;
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  /* 書き込みを頼み、保存できたら返事(res)で resolve、できなければ画面に出す文言で reject する。
     🔴 下書きを消すのは、ここが resolve してから(先に消すと失敗したとき文字が失われる) */
  function saveOp(op) {
    return new Promise(function (resolve, reject) {
      if (!extAlive()) { reject(SAVE_FAIL_MSG); return; }
      var p;
      try {
        p = chrome.runtime.sendMessage(Object.assign({ type: 'soyogi-fusen-op' }, op));
      } catch (e) { reject(SAVE_FAIL_MSG); return; }
      if (!p || !p.then) { reject(SAVE_FAIL_MSG); return; }
      p.then(function (res) {
        if (res && res.ok) resolve(res);
        else reject((res && res.message) || SAVE_FAIL_MSG);
      }, function () { reject(SAVE_FAIL_MSG); });
    });
  }

  /* 返事を待たない操作(ピン・色・削除・コピーの記録など)。失敗したときだけ知らせる */
  function sendOp(op) {
    return saveOp(op).then(null, function (msg) { toast(msg); });
  }

  /* 楽観的に並べ替えた画面が保存に失敗したとき、保存されている中身に戻す */
  function reloadLists() {
    try {
      chrome.storage.local.get({ clips: [], memos: [] }, function (res) {
        data.clips = res.clips || [];
        data.memos = res.memos || [];
        if (visible) scheduleRender();
      });
    } catch (e) {}
  }

  /* ---------- コピー/カットの自動記録 ---------- */
  function deepActiveElement() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  /* 記録してはいけない欄か。type=password だけでなく、
     ・autocomplete が current-password / new-password / one-time-code / cc-〜(カード情報)
     ・-webkit-text-security で文字を伏せている欄(独自のパスワード欄)
     ・name か id に pass / pwd / otp / cvv / cvc を含む欄
     も除く。🔴 迷ったら記録しない側に倒す(記録されないだけで害はない) */
  var SENSITIVE_AC = /^(current-password|new-password|one-time-code|cc-)/;
  var SENSITIVE_NAME = /pass|pwd|otp|cvv|cvc/i;

  function isSensitiveField(node) {
    if (!node || !node.tagName) return false;
    var tag = String(node.tagName).toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA' && !node.isContentEditable) return false;
    if (String(node.type || '').toLowerCase() === 'password') return true;
    var ac = '';
    try { ac = String((node.getAttribute && node.getAttribute('autocomplete')) || ''); } catch (e) {}
    var tokens = ac.toLowerCase().split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      if (SENSITIVE_AC.test(tokens[i])) return true;
    }
    if (SENSITIVE_NAME.test(String(node.name || '') + ' ' + String(node.id || ''))) return true;
    try {
      var cs = window.getComputedStyle(node);
      var sec = cs && (cs.getPropertyValue('-webkit-text-security') || cs.webkitTextSecurity);
      if (sec && sec !== 'none') return true;
    } catch (e2) {}
    return false;
  }

  function grabCopiedText(e) {
    try {
      var path = e.composedPath ? e.composedPath() : [];
      if (host && path.indexOf(host) >= 0) return '';   // 自分のパネル内の操作は拾わない
      var ae = deepActiveElement();
      if (ae) {
        if (isSensitiveField(ae)) return '';            // パスワード等の欄は絶対に記録しない
        var tag = (ae.tagName || '').toUpperCase();
        if (tag === 'INPUT') {
          try {
            if (typeof ae.selectionStart === 'number' && ae.selectionEnd > ae.selectionStart) {
              return String(ae.value).substring(ae.selectionStart, ae.selectionEnd);
            }
          } catch (err) { /* email/number 型は selectionStart 参照で例外になる */ }
        } else if (tag === 'TEXTAREA') {
          if (ae.selectionEnd > ae.selectionStart) {
            return String(ae.value).substring(ae.selectionStart, ae.selectionEnd);
          }
        }
      }
      var sel = window.getSelection ? window.getSelection() : null;
      return sel ? sel.toString() : '';
    } catch (err2) { return ''; }
  }

  function onCopyOrCut(e) {
    var t = grabCopiedText(e);
    if (!t || !t.trim()) return;
    sendOp({ op: 'addClip', text: t });
  }

  document.addEventListener('copy', onCopyOrCut, true);
  document.addEventListener('cut', onCopyOrCut, true);

  /* ---------- クリップボード操作 ---------- */
  /* 🔴 できたときだけ「コピーしました」。両方のやり方でだめなら、そう伝える */
  function copyText(text) {
    var ok = function () { toast('コピーしました'); };
    var ng = function () { toast('コピーできませんでした'); };
    var viaFallback = function () { if (fallbackCopy(text)) ok(); else ng(); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, viaFallback);
    } else {
      viaFallback();
    }
  }

  /* 古いやり方でのコピー。できたかどうかを返す */
  function fallbackCopy(text) {
    var back = null;
    try { back = shadow && shadow.activeElement; } catch (e) {}
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    panelEl.appendChild(ta);
    ta.focus();
    ta.select();
    var done = false;
    try { done = document.execCommand('copy') === true; } catch (e2) { done = false; }
    ta.remove();
    /* 押したボタンへフォーカスを戻す(キーボードで続けて操作できるように) */
    if (back && back.focus) { try { back.focus({ preventScroll: true }); } catch (e3) {} }
    return done;
  }

  function importClipboard() {
    var fail = function () { toast('読み取れませんでした'); };
    if (!extAlive()) { toast(SAVE_FAIL_MSG); return; }
    try {
      chrome.runtime.sendMessage({ type: 'soyogi-fusen-read-clipboard' }).then(function (res) {
        if (res && res.ok && res.text && res.text.trim()) {
          saveOp({ op: 'addClip', text: res.text }).then(function () {
            toast('取り込みました');
          }, toast);
        } else if (res && res.ok) {
          toast('クリップボードに文字がありません');
        } else {
          fail();
        }
      }, fail);
    } catch (e) { fail(); }
  }

  /* ---------- 掴んで並べ替え(「自分の並び」のとき) ---------- */

  /* 押した瞬間に掴むと、スクロールやボタン操作と取り合いになる。
     取っ手(⋮⋮)からだけ開始し、動かしている間は他のカードを押しのけて場所を作る */
  function beginDrag(e, card, grip, kind) {
    if (e.button !== undefined && e.button !== 0) return;
    if (editingId || composerOpen) return;
    e.preventDefault();
    var startY = e.clientY;
    var dragging = false;
    var ph = null;   // 抜いた場所に置く同じ高さの空白

    var move = function (ev) {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 5) return;   // 触れただけでは動かさない
        dragging = true;
        /* 🔴 動かしている間に再描画が走るとカードと空白が一覧から外れ、離したときに例外になる。
              その間の再描画は pendingRender に回し、離してからまとめて描く */
        reorderDragging = true;
        var r = card.getBoundingClientRect();
        ph = el('div', 'card');
        ph.style.height = r.height + 'px';
        ph.style.background = 'rgba(0,0,0,.06)';
        ph.style.border = '1px dashed rgba(0,0,0,.3)';
        ph.style.boxShadow = 'none';
        listEl.insertBefore(ph, card);
        card.classList.add('dragging');
        card.style.position = 'fixed';
        card.style.width = r.width + 'px';
        card.style.left = r.left + 'px';
        card.style.zIndex = '10';
        card.style.top = r.top + 'px';
        listEl.classList.add('reordering');
      }
      card.style.top = (ev.clientY - 14) + 'px';

      /* 画面の端に近づいたら自動でスクロール */
      var lr = listEl.getBoundingClientRect();
      if (ev.clientY < lr.top + 28) listEl.scrollTop -= 12;
      else if (ev.clientY > lr.bottom - 28) listEl.scrollTop += 12;

      /* いまの指の位置に一番近い隙間へ空白を移す */
      var cards = [];
      for (var i = 0; i < listEl.children.length; i++) {
        var c = listEl.children[i];
        if (c !== card && c !== ph && c.dataset && c.dataset.id) cards.push(c);
      }
      var placed = false;
      for (var j = 0; j < cards.length; j++) {
        var cr = cards[j].getBoundingClientRect();
        if (ev.clientY < cr.top + cr.height / 2) {
          listEl.insertBefore(ph, cards[j]);
          placed = true;
          break;
        }
      }
      if (!placed) listEl.appendChild(ph);
    };

    var up = function () {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!dragging) return;
      if (ph.parentNode === listEl) listEl.insertBefore(card, ph);
      ph.remove();
      card.classList.remove('dragging');
      card.style.position = '';
      card.style.width = '';
      card.style.left = '';
      card.style.top = '';
      card.style.zIndex = '';
      listEl.classList.remove('reordering');
      /* いま見えている順番をそのまま保存する */
      var ids = [];
      for (var i = 0; i < listEl.children.length; i++) {
        var c = listEl.children[i];
        if (c.dataset && c.dataset.id) ids.push(c.dataset.id);
      }
      reorderDragging = false;
      saveOrder(kind, ids);
      if (pendingRender) render();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /* 並びを手元のデータにも先に反映してから保存する(保存の返事を待つ間に描き直しても戻らない)。
     保存できなかったら知らせて、保存されている並びに戻す */
  function saveOrder(kind, ids) {
    var key = kind === 'memo' ? 'memos' : 'clips';
    data[key] = L.applyManualOrder(data[key], ids);
    saveOp({ op: 'setOrder', kind: kind, ids: ids }).then(null, function (msg) {
      toast(msg);
      reloadLists();
    });
  }

  /* 取っ手にフォーカスがあるとき Alt+上 / Alt+下 で1つずつ動かす(マウスが使えない人向け) */
  function moveByKey(item, kind, dir) {
    var key = kind === 'memo' ? 'memos' : 'clips';
    var ids = L.sortForDisplay(data[key], 'manual').map(function (it) { return it.id; });
    var i = ids.indexOf(item.id);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids[i] = ids[j];
    ids[j] = item.id;
    saveOrder(kind, ids);
    render();   // フォーカスは動かしたカードの取っ手に戻る
    toast((j + 1) + '番目に動かしました');
  }

  /* ---------- 小窓で開く ---------- */

  /* ブラウザのタブから独立した小さな窓に移す。
     この窓はPWAと違って幅の下限に縛られないので、細長い付箋として置ける */
  function openSmallWindow() {
    try {
      var p = chrome.runtime.sendMessage({ type: 'soyogi-fusen-open-window' });
      if (p && p.then) {
        p.then(function (res) {
          if (res && res.ok) hidePanel();
          else toast('小窓を開けませんでした');
        }, function () { toast('小窓を開けませんでした'); });
      } else {
        hidePanel();
      }
    } catch (e) {
      toast('小窓を開けませんでした');
    }
  }

  /* ---------- バックアップ(書き出し・読み込み) ---------- */

  function ymd(d) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function doExport() {
    try {
      var now = new Date();
      var text = JSON.stringify(L.buildBackup(data.clips, data.memos, now.toISOString()), null, 2);
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'benri-clip-memo-backup-' + ymd(now) + '.json';
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      toast('書き出しました');
    } catch (e) {
      toast('書き出せませんでした');
    }
  }

  /* 読み込みは「今の中身に足す」。
     🔴 ただし足して50件を超えた分は、ピン止めしていない古いものから整理される
        (元からあった項目も対象)。整理した件数は必ず画面に出す */
  function onImportFile() {
    var f = fileInputEl.files && fileInputEl.files[0];
    if (!f) return;
    /* バックアップは大きくても数MB。それより桁違いに大きいものは読まずに弾く */
    if (f.size > MAX_IMPORT_BYTES) {
      toast('ファイルが大きすぎます');
      fileInputEl.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = null;
      try {
        parsed = L.parseBackup(String(reader.result), Date.now());
      } catch (e) {
        toast(String((e && e.message) || 'このファイルは読み込めません'));
        fileInputEl.value = '';
        return;
      }
      fileInputEl.value = '';
      saveOp({ op: 'importItems', clips: parsed.clips, memos: parsed.memos }).then(function (res) {
        var a = (res && res.addedClips) || 0;
        var b = (res && res.addedMemos) || 0;
        var d = (res && res.dropped) || 0;
        var msg = a + b === 0
          ? '新しく増えるものはありませんでした'
          : '読み込みました（履歴' + a + '件・メモ' + b + '件）';
        if (d > 0) msg += '。上限のため古い' + d + '件を整理しました';
        toast(msg);
      }, toast);
    };
    reader.onerror = function () {
      toast('ファイルを開けませんでした');
      fileInputEl.value = '';
    };
    reader.readAsText(f);
  }

  /* ---------- データ読み込み・監視 ---------- */
  function loadData(cb) {
    try {
      chrome.storage.local.get({ clips: [], memos: [], panelState: null }, function (res) {
        data.clips = res.clips || [];
        data.memos = res.memos || [];
        savedPanelState = res.panelState || null;
        if (savedPanelState && (savedPanelState.tab === 'clips' || savedPanelState.tab === 'memos')) {
          currentTab = savedPanelState.tab;
        }
        if (savedPanelState && savedPanelState.sort) {
          if (L.isSortMode(savedPanelState.sort.clips)) sortMode.clips = savedPanelState.sort.clips;
          if (L.isSortMode(savedPanelState.sort.memos)) sortMode.memos = savedPanelState.sort.memos;
        }
        if (cb) cb();
      });
    } catch (e) { if (cb) cb(); }
  }

  if (IS_TOP) {
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        var dirty = false;
        if (changes.clips) { data.clips = changes.clips.newValue || []; dirty = true; }
        if (changes.memos) { data.memos = changes.memos.newValue || []; dirty = true; }
        if (dirty && visible) scheduleRender();
      });
    } catch (e) {}
  }

  function scheduleRender() {
    if (editingId || composerOpen || reorderDragging) { pendingRender = true; return; }
    render();
  }

  /* ---------- パネルの状態保存 ---------- */
  function savePanelStateNow() {
    if (!panelEl) return;
    var st = { tab: currentTab, sort: { clips: sortMode.clips, memos: sortMode.memos } };
    if (!IS_PAGE_MODE && visible) {
      var r = panelEl.getBoundingClientRect();
      if (r.width > 0) { st.width = Math.round(r.width); st.height = Math.round(r.height); }
      if (panelEl.style.left) { st.left = Math.round(r.left); st.top = Math.round(r.top); }
    }
    savedPanelState = Object.assign({}, savedPanelState, st);
    /* 位置や並べ替えの設定は保存できなくても使い続けられるので、知らせずに流す */
    try {
      var p = chrome.storage.local.set({ panelState: savedPanelState });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function scheduleSaveState() {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(savePanelStateNow, 400);
  }

  function applyPanelState() {
    if (IS_PAGE_MODE || !savedPanelState || !panelEl) return;
    var s = savedPanelState;
    if (typeof s.width === 'number') {
      panelEl.style.width = Math.max(MIN_W, Math.min(s.width, window.innerWidth - 16)) + 'px';
    }
    if (typeof s.height === 'number') {
      panelEl.style.height = Math.max(MIN_H, Math.min(s.height, window.innerHeight - 16)) + 'px';
    }
    if (typeof s.left === 'number' && typeof s.top === 'number') {
      var w = parseFloat(panelEl.style.width) || 380;
      var left = Math.max(60 - w, Math.min(s.left, window.innerWidth - 60));
      var top = Math.max(0, Math.min(s.top, window.innerHeight - 48));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
      panelEl.style.right = 'auto';
    }
  }

  /* ウィンドウ縮小などでパネルが画面外に取り残されないよう引き戻す */
  function clampPanelIntoView() {
    if (IS_PAGE_MODE || !panelEl || !visible) return;
    if (!panelEl.style.left) return;
    var r = panelEl.getBoundingClientRect();
    if (!r.width) return;
    var left = Math.max(60 - r.width, Math.min(r.left, window.innerWidth - 60));
    var top = Math.max(0, Math.min(r.top, window.innerHeight - 48));
    if (left !== r.left) panelEl.style.left = left + 'px';
    if (top !== r.top) panelEl.style.top = top + 'px';
  }

  /* ---------- ドラッグ移動 ---------- */
  function enableDrag(handle) {
    var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('.iconbtn')) return;
      var r = panelEl.getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
      panelEl.style.left = r.left + 'px';
      panelEl.style.top = r.top + 'px';
      panelEl.style.right = 'auto';
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var w = panelEl.getBoundingClientRect().width;
      var left = Math.max(60 - w, Math.min(sl + (e.clientX - sx), window.innerWidth - 60));
      var top = Math.max(0, Math.min(st + (e.clientY - sy), window.innerHeight - 40));
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
    });
    var end = function () {
      if (!dragging) return;
      dragging = false;
      scheduleSaveState();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /* ---------- パネル生成 ---------- */
  function buildPanel() {
    host = document.createElement('div');
    host.id = 'soyogi-fusen-host';
    /* 🔴 page-modeでは全面に固定する。座標なしのfixedだとshrink-to-fitで
       中のwidth:100%がmin-width(300px)まで潰れる */
    host.style.cssText = IS_PAGE_MODE
      ? 'all:initial; position:fixed; left:0; top:0; right:0; bottom:0; display:none;'
      : 'all:initial; position:fixed; z-index:2147483647; display:none;';
    (document.documentElement || document.body).appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    panelEl = el('div', 'panel' + (IS_PAGE_MODE ? ' page-mode' : ''));
    /* 英語のページの上でも日本語として読み上げられるように */
    panelEl.setAttribute('lang', 'ja');
    panelEl.setAttribute('aria-label', '便利クリップメモ・そよぎ');
    panelEl.setAttribute('role', IS_PAGE_MODE ? 'main' : 'dialog');
    /* アイコンで開いたとき、ここにフォーカスを置く(Tabで中のボタンへ進める) */
    panelEl.setAttribute('tabindex', '-1');
    panelEl.innerHTML = [
      '<div class="hdr" id="hdr">',
      '  <span class="logo" aria-hidden="true">📋</span>',
      '  <span class="ttl">便利クリップメモ・そよぎ</span>',
      '  <span class="hdr-actions">',
      '    <button class="iconbtn win" id="btn-window" title="小窓で開く（ブラウザとは別の小さな窓にする）" aria-label="小窓で開く（ブラウザとは別の小さな窓にする）">🪟</button>',
      '    <button class="iconbtn bak" id="btn-export" title="書き出し（今の中身をファイルに保存）" aria-label="書き出し（今の中身をファイルに保存）">💾</button>',
      '    <button class="iconbtn bak" id="btn-import-file" title="読み込み（保存したファイルの中身を、今のものに足す）" aria-label="読み込み（保存したファイルの中身を、今のものに足す）">📂</button>',
      '    <button class="iconbtn" id="btn-close" title="しまう(拡張機能アイコンで再表示)" aria-label="しまう(拡張機能アイコンで再表示)">✕</button>',
      '  </span>',
      '</div>',
      '<input type="file" id="file-input" accept="application/json,.json" style="display:none">',
      '<div class="tabs" role="tablist" aria-label="表示する一覧">',
      '  <button class="tab" id="tab-clips" role="tab" aria-controls="list"></button>',
      '  <button class="tab" id="tab-memos" role="tab" aria-controls="list"></button>',
      '</div>',
      '<div class="toolbar">',
      '  <button class="btn" id="btn-import">',
      '    <span class="lbl-full">📥 いまのクリップボードを取り込む</span>',
      '    <span class="lbl-min">📥 取り込む</span>',
      '  </button>',
      '  <button class="btn" id="btn-newmemo">',
      '    <span class="lbl-full">＋ 新しいメモ</span>',
      '    <span class="lbl-min">＋ メモ</span>',
      '  </button>',
      '  <select class="sortbox" id="sortbox" aria-label="並べ替え" title="並べ替え（「自分の並び」以外では、ピン止めが一番上に来ます）"></select>',
      '</div>',
      '<div class="list" id="list" role="tabpanel"></div>',
      '<div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>'
    ].join('\n');
    shadow.appendChild(panelEl);

    listEl = shadow.getElementById('list');
    toastEl = shadow.getElementById('toast');
    tabClipsEl = shadow.getElementById('tab-clips');
    tabMemosEl = shadow.getElementById('tab-memos');
    btnImportEl = shadow.getElementById('btn-import');
    btnNewMemoEl = shadow.getElementById('btn-newmemo');
    sortBoxEl = shadow.getElementById('sortbox');

    L.SORT_MODES.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      sortBoxEl.appendChild(o);
    });
    sortBoxEl.addEventListener('change', function () {
      if (!L.isSortMode(sortBoxEl.value)) return;
      sortMode[currentTab] = sortBoxEl.value;
      render();
      scheduleSaveState();
    });

    var closeBtn = shadow.getElementById('btn-close');
    if (IS_WEB_APP) {
      /* Web版は常時表示のアプリなので「しまう」ボタン自体を出さない */
      closeBtn.style.display = 'none';
    } else {
      closeBtn.addEventListener('click', function () {
        if (IS_PAGE_MODE) {
          try {
            chrome.windows.getCurrent(function (w) {
              if (w && w.id != null) chrome.windows.remove(w.id);
              else window.close();
            });
          } catch (e) { window.close(); }
        } else {
          hidePanel();
        }
      });
    }

    var winBtn = shadow.getElementById('btn-window');
    if (IS_PAGE_MODE) {
      /* すでに小窓(または全画面のWeb版)なので出さない */
      winBtn.style.display = 'none';
    } else {
      winBtn.addEventListener('click', openSmallWindow);
    }

    fileInputEl = shadow.getElementById('file-input');
    shadow.getElementById('btn-export').addEventListener('click', doExport);
    shadow.getElementById('btn-import-file').addEventListener('click', function () {
      fileInputEl.click();
    });
    fileInputEl.addEventListener('change', onImportFile);

    tabClipsEl.addEventListener('click', function () { switchTab('clips'); });
    tabMemosEl.addEventListener('click', function () { switchTab('memos'); });
    /* タブは左右の矢印(と Home / End)で切り替える(読み上げソフトのタブの決まりごと) */
    var onTabKey = function (e) {
      var k = e.key;
      if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End') return;
      e.preventDefault();
      var next = k === 'Home' ? 'clips' : k === 'End' ? 'memos'
        : (currentTab === 'clips' ? 'memos' : 'clips');
      switchTab(next);
      try { (next === 'clips' ? tabClipsEl : tabMemosEl).focus(); } catch (err) {}
    };
    tabClipsEl.addEventListener('keydown', onTabKey);
    tabMemosEl.addEventListener('keydown', onTabKey);
    btnImportEl.addEventListener('click', importClipboard);
    btnNewMemoEl.addEventListener('click', function () {
      if (composerOpen) return;
      composerOpen = true;
      composerFocusPending = true;
      render();
    });

    /* 編集・メモ入力は状態(editDraft/composerDraft)で守られるので、Escapeはいつでも格納できる。
       🔴 日本語の変換中のEscは「変換の取り消し」なので閉じない */
    panelEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || IS_PAGE_MODE) return;
      if (e.isComposing || e.keyCode === 229) return;
      hidePanel();
    });
    /* パネル内のキー入力が、ページ側のショートカット(1文字キーで動くサイトなど)に届かないよう
       hostで止める。パネル自身の処理(上のEscなど)は中で先に済んでいる */
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      host.addEventListener(type, function (e) { e.stopPropagation(); });
    });

    if (!IS_PAGE_MODE) {
      enableDrag(shadow.getElementById('hdr'));
      try {
        var ro = new ResizeObserver(function () {
          if (visible && panelEl.style.left) scheduleSaveState();
        });
        ro.observe(panelEl);
      } catch (e) {}
      window.addEventListener('resize', function () {
        clearTimeout(resizeClampTimer);
        resizeClampTimer = setTimeout(clampPanelIntoView, 150);
      });
      /* 全画面(top layer)中はz-indexで勝てないため、hostを全画面要素の中へ移す */
      document.addEventListener('fullscreenchange', function () {
        try {
          var target = document.fullscreenElement || document.documentElement;
          if (host && host.parentNode !== target) target.appendChild(host);
        } catch (e) {}
      });
    }
  }

  /* 編集・メモ入力の下書きは状態として保持されるので、タブ切替はいつでも安全 */
  function switchTab(tab) {
    if (currentTab === tab) return;
    currentTab = tab;
    paletteOpenId = null;
    confirmDeleteId = null;
    render();
    scheduleSaveState();
  }

  function togglePanel() {
    if (!panelEl) {
      buildPanel();
      loadData(function () {
        applyPanelState();
        showPanel();
      });
      return;
    }
    if (visible) hidePanel();
    else loadData(showPanel);
  }

  function showPanel() {
    var wasVisible = visible;
    visible = true;
    host.style.display = 'block';
    render();
    /* right基準のままだとリサイズつまみの動きが不自然なので、表示できたら left 基準に固定する */
    if (!IS_PAGE_MODE && !panelEl.style.left) {
      var r = panelEl.getBoundingClientRect();
      if (r.width > 0) {
        panelEl.style.left = r.left + 'px';
        panelEl.style.top = r.top + 'px';
        panelEl.style.right = 'auto';
      }
    }
    clampPanelIntoView();
    /* アイコンで開いたらパネルの先頭へフォーカスを移す(閉じたら元の場所へ戻す) */
    if (!IS_PAGE_MODE && !wasVisible) {
      focusBeforeOpen = deepActiveElement();
      try { panelEl.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  function hidePanel() {
    savePanelStateNow();
    var hadFocus = false;
    try { hadFocus = !!(shadow && shadow.activeElement); } catch (e) {}
    visible = false;
    host.style.display = 'none';
    paletteOpenId = null;
    confirmDeleteId = null;
    /* パネルの中で操作していたときだけ、開く前の場所(入力中の欄など)へ戻す */
    var back = focusBeforeOpen;
    focusBeforeOpen = null;
    if (hadFocus && back && back.focus && back.isConnected !== false) {
      try { back.focus({ preventScroll: true }); } catch (e2) {}
    }
  }

  /* ---------- 描画 ---------- */

  /* 作り直す前に、一覧の中のどのカードのどのボタンにフォーカスがあったかを覚える */
  function captureListFocus() {
    try {
      var a = shadow.activeElement;
      if (!a || !visible) return null;
      var act = a.dataset && a.dataset.act;
      if (!act) return null;
      var card = a;
      while (card && card !== listEl && !(card.dataset && card.dataset.fkey)) card = card.parentNode;
      if (!card || card === listEl) return null;
      return {
        key: card.dataset.fkey,
        act: act,
        index: Array.prototype.indexOf.call(listEl.children, card)
      };
    } catch (e) { return null; }
  }

  /* act が null なら目印の付いた最初のもの */
  function findAct(node, act) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.dataset && c.dataset.act && (act == null || c.dataset.act === act)) return c;
      var r = findAct(c, act);
      if (r) return r;
    }
    return null;
  }

  /* 作り直したあと、同じカードの同じボタンへフォーカスを戻す。
     編集を閉じたら✏️へ、編集を開いたら入力欄へ、カードが消えていたら(削除など)
     同じ位置のカードへ、それも無ければタブへ */
  function restoreListFocus(f) {
    if (!f) return;
    var base = f.act.split('-')[0];
    var card = null, target = null, i;
    for (i = 0; i < listEl.children.length; i++) {
      var c = listEl.children[i];
      if (c.dataset && c.dataset.fkey === f.key) { card = c; break; }
    }
    if (card) {
      target = findAct(card, f.act) || findAct(card, base) || findAct(card, null);
    } else if (f.key === COMPOSER_KEY) {
      target = btnNewMemoEl;
    } else {
      var near = listEl.children[Math.min(f.index, listEl.children.length - 1)];
      if (near) target = findAct(near, base);
    }
    if (!target) target = currentTab === 'clips' ? tabClipsEl : tabMemosEl;
    try { target.focus(); } catch (e) {}
  }

  function render() {
    if (!panelEl) return;
    if (reorderDragging) { pendingRender = true; return; }
    pendingRender = false;
    var focusWas = captureListFocus();

    setTabLabel(tabClipsEl, 'コピー履歴 ' + data.clips.length + '/' + L.MAX_ITEMS,
      '履歴 ' + data.clips.length);
    setTabLabel(tabMemosEl, 'メモ ' + data.memos.length + '/' + L.MAX_ITEMS,
      'メモ ' + data.memos.length);
    tabClipsEl.classList.toggle('on', currentTab === 'clips');
    tabMemosEl.classList.toggle('on', currentTab === 'memos');
    tabClipsEl.setAttribute('aria-selected', currentTab === 'clips' ? 'true' : 'false');
    tabMemosEl.setAttribute('aria-selected', currentTab === 'memos' ? 'true' : 'false');
    /* 選ばれているタブだけTabで止まる(もう片方へは左右の矢印で) */
    tabClipsEl.setAttribute('tabindex', currentTab === 'clips' ? '0' : '-1');
    tabMemosEl.setAttribute('tabindex', currentTab === 'memos' ? '0' : '-1');
    listEl.setAttribute('aria-labelledby', currentTab === 'clips' ? 'tab-clips' : 'tab-memos');
    btnImportEl.style.display = currentTab === 'clips' ? '' : 'none';
    btnNewMemoEl.style.display = currentTab === 'memos' ? '' : 'none';
    sortBoxEl.value = sortMode[currentTab];

    listEl.textContent = '';
    var kind = currentTab === 'clips' ? 'clip' : 'memo';
    var items = L.sortForDisplay(currentTab === 'clips' ? data.clips : data.memos,
      sortMode[currentTab]);

    var showComposer = composerOpen && kind === 'memo';
    var editOnThisTab = editingId !== null && kind === editKind;
    var editTargetExists = editOnThisTab && items.some(function (it) { return it.id === editingId; });
    /* 編集中に元の項目が他所で消えても、下書きを守るため編集カードだけは出し続ける */
    var showOrphanEdit = editOnThisTab && !editTargetExists;

    if (showComposer) listEl.appendChild(buildComposer());
    if (showOrphanEdit) listEl.appendChild(buildEditCard(null, kind));

    if (!items.length && !showComposer && !showOrphanEdit) {
      var em = el('div', 'empty');
      em.textContent = currentTab === 'clips'
        ? 'ページで文字をコピーすると、ここに残っていきます。\n「取り込む」ボタンで今のクリップボードも追加できます。'
        : '「＋ 新しいメモ」から自由にメモを残せます。';
      listEl.appendChild(em);
    }

    for (var i = 0; i < items.length; i++) {
      if (editOnThisTab && items[i].id === editingId) {
        listEl.appendChild(buildEditCard(items[i], kind));
      } else {
        listEl.appendChild(buildCard(items[i], kind));
      }
    }
    restoreListFocus(focusWas);
  }

  function buildComposer() {
    var card = el('div', 'card');
    card.dataset.fkey = COMPOSER_KEY;
    card.style.background = L.colorHex('yellow');
    var ta = document.createElement('textarea');
    ta.value = composerDraft;
    ta.maxLength = L.MAX_TEXT;
    ta.placeholder = 'メモを入力…';
    ta.setAttribute('aria-label', '新しいメモ');
    ta.dataset.act = 'new-text';
    ta.addEventListener('input', function () { composerDraft = ta.value; });
    var row = el('div', 'editrow');
    var cancel = textBtn('キャンセル', function () {
      composerOpen = false;
      composerDraft = '';
      render();
    }, 'sub', 'new-cancel');
    /* 🔴 下書きは「保存できた」と返事が来てから消す。失敗したら残したまま知らせる */
    var save = textBtn('保存', function () {
      if (composerSaving) return;
      var v = ta.value;
      composerDraft = v;
      if (!v.trim()) { toast('文字を入力してください'); return; }
      composerSaving = true;
      saveOp({ op: 'addMemo', text: v }).then(function () {
        composerSaving = false;
        if (!composerOpen) return;   // 返事を待つ間にキャンセルされた
        composerOpen = false;
        composerDraft = '';
        render();
      }, function (msg) {
        composerSaving = false;
        toast(msg);
      });
    }, '', 'new-save');
    row.appendChild(cancel);
    row.appendChild(save);
    card.appendChild(ta);
    card.appendChild(row);
    /* 開いたときだけ入力欄へ。毎回だと、他のカードを操作したときにフォーカスを奪う */
    if (composerFocusPending) {
      composerFocusPending = false;
      setTimeout(function () { try { ta.focus(); } catch (e) {} }, 0);
    }
    return card;
  }

  function buildCard(item, kind) {
    var card = el('div', 'card');
    card.dataset.id = item.id;
    card.dataset.fkey = item.id;
    card.style.background = L.colorHex(item.color);

    var txt = el('div', 'txt clamp');
    txt.style.color = L.textColorHex(item.textColor);
    txt.textContent = item.text || (kind === 'memo' ? '(空のメモ)' : '(空)');
    if (!item.text) txt.style.opacity = '.55';
    txt.title = 'クリックで全文表示/折りたたみ';
    txt.addEventListener('click', function () { txt.classList.toggle('clamp'); });
    card.appendChild(txt);

    var meta = el('div', 'meta');
    if (sortMode[currentTab] === 'manual') {
      var grip = el('button', 'grip');
      grip.textContent = '⋮⋮';
      grip.title = 'ここを掴んで上下に動かすと順番を変えられます。Alt+上下の矢印キーでも動かせます';
      grip.setAttribute('aria-label', grip.title);
      grip.dataset.act = 'grip';
      grip.addEventListener('pointerdown', function (e) { beginDrag(e, card, grip, kind); });
      grip.addEventListener('keydown', function (e) {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        moveByKey(item, kind, e.key === 'ArrowUp' ? -1 : 1);
      });
      meta.appendChild(grip);
    }
    var time = el('span', 'time');
    time.textContent = fmtTime(item.ts);
    meta.appendChild(time);

    /* 🔴「自分の並び」ではピン止めも置いた場所に留まるので「常に上」とは書かない */
    var pin = iconBtn('📌', item.pinned ? 'ピン止めを外す'
      : 'ピン止め（自動で消えません。「自分の並び」以外では一番上に出ます）', function () {
      sendOp({ op: 'togglePin', kind: kind, id: item.id });
    }, item.pinned, 'pin');
    pin.setAttribute('aria-pressed', item.pinned ? 'true' : 'false');
    meta.appendChild(pin);

    meta.appendChild(iconBtn('📋', 'クリップボードにコピー', function () {
      copyText(item.text);
    }, false, 'copy'));

    meta.appendChild(iconBtn('✏️', '編集', function () {
      startEdit(item, kind);
    }, false, 'edit'));

    var colorBtn = iconBtn('🎨', '色を変える', function () {
      paletteOpenId = paletteOpenId === item.id ? null : item.id;
      render();
    }, false, 'color');
    colorBtn.setAttribute('aria-expanded', paletteOpenId === item.id ? 'true' : 'false');
    meta.appendChild(colorBtn);

    var del;
    if (confirmDeleteId === item.id) {
      del = el('button', 'iconbtn danger');
      del.textContent = '削除する';
      del.dataset.act = 'del';
      del.addEventListener('click', function () {
        /* 🔴 🗑️のダブルクリックの2打目がここに当たって素通りしないよう、切り替わって直後は無視 */
        if (Date.now() - confirmDeleteAt < CONFIRM_GUARD_MS) return;
        confirmDeleteId = null;
        clearTimeout(confirmDeleteTimer);
        sendOp({ op: 'remove', kind: kind, id: item.id });
      });
    } else {
      del = iconBtn('🗑️', '削除', function () {
        confirmDeleteId = item.id;
        confirmDeleteAt = Date.now();
        clearTimeout(confirmDeleteTimer);
        confirmDeleteTimer = setTimeout(function () {
          if (confirmDeleteId === item.id) {
            confirmDeleteId = null;
            if (visible) scheduleRender();
          }
        }, CONFIRM_RESET_MS);
        render();
      }, false, 'del');
    }
    meta.appendChild(del);
    card.appendChild(meta);

    var pal = buildPalette(item, kind);
    if (paletteOpenId === item.id) pal.classList.add('open');
    card.appendChild(pal);

    return card;
  }

  function buildPalette(item, kind) {
    var pal = el('div', 'palette');
    L.COLORS.forEach(function (c) {
      var s = el('button', 'sw');
      s.style.background = c.hex;
      s.title = c.name;
      s.setAttribute('aria-label', c.name);
      s.setAttribute('aria-pressed', item.color === c.id ? 'true' : 'false');
      s.dataset.act = 'sw-' + c.id;
      if (item.color === c.id) s.classList.add('on');
      s.addEventListener('click', function () {
        sendOp({ op: 'setColor', kind: kind, id: item.id, color: c.id });
      });
      pal.appendChild(s);
    });
    pal.appendChild(el('span', 'sep'));
    L.TEXT_COLORS.forEach(function (t) {
      var s = el('button', 'sw txtsw');
      s.textContent = 'あ';
      s.style.color = t.hex;
      s.style.background = t.id === 'white' ? '#8a8a8a' : '#f2f2f2';
      s.title = '文字色: ' + t.name;
      s.setAttribute('aria-label', s.title);
      s.setAttribute('aria-pressed', item.textColor === t.id ? 'true' : 'false');
      s.dataset.act = 'tc-' + t.id;
      if (item.textColor === t.id) s.classList.add('on');
      s.addEventListener('click', function () {
        sendOp({ op: 'setTextColor', kind: kind, id: item.id, textColor: t.id });
      });
      pal.appendChild(s);
    });
    return pal;
  }

  function clearEditState() {
    editingId = null;
    editKind = null;
    editDraft = '';
    editFocusPending = false;
  }

  function startEdit(item, kind) {
    if (editingId) { toast('別の項目を編集中です'); return; }
    editingId = item.id;
    editKind = kind;
    editDraft = item.text;
    editFocusPending = true;
    paletteOpenId = null;
    confirmDeleteId = null;
    render();
  }

  /* 編集カードはcomposerと同じく毎回のrender()で下書きから再構築する。
     これにより途中でどんな再描画が走っても編集状態が壊れない。 */
  function buildEditCard(item, kind) {
    var card = el('div', 'card');
    card.dataset.fkey = editingId;
    card.style.background = L.colorHex(item ? item.color : (kind === 'memo' ? 'yellow' : 'white'));
    var ta = document.createElement('textarea');
    ta.value = editDraft;
    ta.maxLength = L.MAX_TEXT;
    ta.setAttribute('aria-label', '編集中の文');
    ta.dataset.act = 'edit-text';
    ta.addEventListener('input', function () { editDraft = ta.value; });
    var row = el('div', 'editrow');
    var cancel = textBtn('キャンセル', function () {
      clearEditState();
      render();
    }, 'sub', 'edit-cancel');
    /* 🔴 編集状態(下書き)は「保存できた」と返事が来てから閉じる。失敗したら残したまま知らせる */
    var save = textBtn('保存', function () {
      if (editSaving) return;
      var v = ta.value;
      editDraft = v;
      var id = editingId;
      var stillThere = (kind === 'memo' ? data.memos : data.clips)
        .some(function (it) { return it.id === id; });
      var op = null;
      if (stillThere) {
        op = { op: 'updateText', kind: kind, id: id, text: v };
      } else if (v.trim()) {
        /* 編集している間に他のタブや自動削除で元項目が消えていた場合の救済 */
        op = kind === 'memo' ? { op: 'addMemo', text: v } : { op: 'addClip', text: v };
      }
      if (!op) { clearEditState(); render(); return; }
      editSaving = true;
      saveOp(op).then(function () {
        editSaving = false;
        if (!stillThere) toast('元の項目が消えていたため、新しく保存しました');
        if (editingId !== id) return;   // 返事を待つ間にキャンセルされた
        clearEditState();
        render();
      }, function (msg) {
        editSaving = false;
        toast(msg);
      });
    }, '', 'edit-save');
    row.appendChild(cancel);
    row.appendChild(save);
    card.appendChild(ta);
    card.appendChild(row);
    if (editFocusPending) {
      editFocusPending = false;
      setTimeout(function () { try { ta.focus(); } catch (e) {} }, 0);
    }
    return card;
  }

  /* ---------- メッセージ受け口(アイコンクリック・トップフレームのみ) ---------- */
  if (IS_TOP) {
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.type === 'soyogi-fusen-toggle') {
          togglePanel();
          sendResponse({ ok: true });
        }
      });
    } catch (e) {}
  }

  /* ---------- panel.html(拡張ページ)では即表示 ---------- */
  if (IS_PAGE_MODE) {
    var boot = function () {
      buildPanel();
      loadData(showPanel);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

})();
