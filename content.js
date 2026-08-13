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
  var sortBoxEl = null;
  var visible = false;
  var currentTab = 'clips';           // 'clips' | 'memos'
  var sortMode = { clips: 'new', memos: 'new' };   // タブごとに覚える
  var data = { clips: [], memos: [] };
  var savedPanelState = null;         // {left, top, width, height, tab}
  var editingId = null;               // 編集はcomposerと同じく状態駆動で描画する
  var editKind = null;                // 'clip' | 'memo'
  var editDraft = '';
  var editFocusPending = false;
  var composerOpen = false;
  var composerDraft = '';
  var paletteOpenId = null;
  var confirmDeleteId = null;
  var pendingRender = false;
  var toastTimer = null;
  var saveStateTimer = null;
  var resizeClampTimer = null;

  /* ---------- スタイル ---------- */
  /* 🔴 パネルの最小サイズ。CSSと位置復元の両方で使う(片方だけ直すと、
        縮めても再表示で元に戻る不具合になる) */
  var MIN_W = 190, MIN_H = 170;

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
    '.panel.page-mode {',
    '  position: static; width: 100%; height: 100vh; max-width: none; max-height: none;',
    '  border: none; border-radius: 0; box-shadow: none; resize: none;',
    '  padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);',
    '}',
    '.hdr { display: flex; align-items: center; gap: 7px; padding: 10px 12px;',
    '  background: #e8f5ec; border-bottom: 1px solid #d0e2d6; cursor: grab;',
    '  user-select: none; touch-action: none; flex: none; }',
    '.panel.page-mode .hdr { cursor: default; }',
    '.hdr .ttl { font-weight: 700; font-size: 14px; color: #1b1b1b; flex: 1;',
    '  white-space: nowrap; overflow: hidden; }',
    '.iconbtn { border: none; background: rgba(255,255,255,.6); width: 30px; height: 28px;',
    '  border-radius: 6px; cursor: pointer; font-size: 14px; line-height: 1; padding: 0;',
    '  display: inline-flex; align-items: center; justify-content: center; color: #333; flex: none; }',
    '.iconbtn:hover { background: rgba(255,255,255,.95); }',
    '.iconbtn.on { background: #2e9e5b; }',
    '.iconbtn.danger { background: #d9534f; color: #fff; font-size: 12px; font-weight: 700;',
    '  width: auto; padding: 0 10px; }',
    '.tabs { display: flex; background: #f7faf8; border-bottom: 1px solid #ddd; flex: none; }',
    '.tab { flex: 1; border: none; background: none; padding: 10px 4px; text-align: center;',
    '  cursor: pointer; font-size: 13px; color: #555; border-bottom: 3px solid transparent; }',
    '.tab.on { border-bottom-color: #2e9e5b; color: #1b6b3d; font-weight: 700; background: #fff; }',
    '.toolbar { padding: 8px 10px; display: flex; gap: 8px; flex: none; background: #fff;',
    '  align-items: stretch; }',
    '.sortbox { flex: none; max-width: 46%; border: 1px solid #c8d2cc; border-radius: 8px;',
    '  background: #f7faf8; color: #1b6b3d; font-size: 12px; font-weight: 600;',
    '  padding: 0 4px; cursor: pointer; }',
    '.lbl-min { display: none; }',
    '.btn { flex: 1; border: none; background: #2e9e5b; color: #fff; font-size: 13px;',
    '  font-weight: 600; padding: 9px 10px; border-radius: 8px; cursor: pointer; }',
    '.btn:hover { background: #27874f; }',
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
    '.meta .time { font-size: 11px; color: rgba(0,0,0,.55); flex: 1; }',
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
    '.empty { text-align: center; color: #78877d; padding: 30px 10px; font-size: 13px;',
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
    /* タイトルを隠すと✕が左に寄って間延びするので右端へ寄せ直す */
    '  .hdr .ttl { display: none; }',
    '  .hdr .iconbtn { margin-left: auto; }',
    '  .meta { flex-wrap: wrap; }',
    '  .meta .time { flex: 1 0 100%; margin-bottom: 3px; }',
    '}'
  ].join('\n');

  /* ---------- 小道具 ---------- */
  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  function iconBtn(glyph, title, onClick, on) {
    var b = el('button', 'iconbtn' + (on ? ' on' : ''));
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function textBtn(label, onClick, extraClass) {
    var b = el('button', 'btn small' + (extraClass ? ' ' + extraClass : ''));
    b.textContent = label;
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

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 1700);
  }

  /* 拡張が更新された直後などは context が死んでいるので握りつぶす */
  function sendOp(op) {
    try {
      var p = chrome.runtime.sendMessage(Object.assign({ type: 'soyogi-fusen-op' }, op));
      if (p && p.catch) p.catch(function () {});
      return p;
    } catch (e) { return Promise.resolve(); }
  }

  /* ---------- コピー/カットの自動記録 ---------- */
  function deepActiveElement() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function grabCopiedText(e) {
    try {
      var path = e.composedPath ? e.composedPath() : [];
      if (host && path.indexOf(host) >= 0) return '';   // 自分のパネル内の操作は拾わない
      var ae = deepActiveElement();
      if (ae) {
        var tag = (ae.tagName || '').toUpperCase();
        if (tag === 'INPUT') {
          var type = (ae.type || '').toLowerCase();
          if (type === 'password') return '';           // パスワード欄は絶対に記録しない
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
  function copyText(text) {
    var done = function () { toast('コピーしました'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    panelEl.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
    done();
  }

  function importClipboard() {
    var fail = function () { toast('読み取れませんでした'); };
    try {
      chrome.runtime.sendMessage({ type: 'soyogi-fusen-read-clipboard' }).then(function (res) {
        if (res && res.ok && res.text && res.text.trim()) {
          sendOp({ op: 'addClip', text: res.text });
          toast('取り込みました');
        } else if (res && res.ok) {
          toast('クリップボードに文字がありません');
        } else {
          fail();
        }
      }, fail);
    } catch (e) { fail(); }
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
    if (editingId || composerOpen) { pendingRender = true; return; }
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
    try { chrome.storage.local.set({ panelState: savedPanelState }); } catch (e) {}
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
    panelEl.innerHTML = [
      '<div class="hdr" id="hdr">',
      '  <span class="logo">📋</span>',
      '  <span class="ttl">便利クリップメモ・そよぎ</span>',
      '  <button class="iconbtn" id="btn-close" title="しまう(拡張機能アイコンで再表示)">✕</button>',
      '</div>',
      '<div class="tabs">',
      '  <button class="tab" id="tab-clips"></button>',
      '  <button class="tab" id="tab-memos"></button>',
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
      '  <select class="sortbox" id="sortbox" title="並べ替え（ピン止めは常に一番上に残ります）"></select>',
      '</div>',
      '<div class="list" id="list"></div>',
      '<div class="toast" id="toast"></div>'
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

    tabClipsEl.addEventListener('click', function () { switchTab('clips'); });
    tabMemosEl.addEventListener('click', function () { switchTab('memos'); });
    btnImportEl.addEventListener('click', importClipboard);
    btnNewMemoEl.addEventListener('click', function () {
      if (composerOpen) return;
      composerOpen = true;
      render();
    });

    /* 編集・メモ入力は状態(editDraft/composerDraft)で守られるので、Escapeはいつでも格納できる */
    panelEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !IS_PAGE_MODE) hidePanel();
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
  }

  function hidePanel() {
    savePanelStateNow();
    visible = false;
    host.style.display = 'none';
    paletteOpenId = null;
    confirmDeleteId = null;
  }

  /* ---------- 描画 ---------- */
  function render() {
    if (!panelEl) return;
    pendingRender = false;

    setTabLabel(tabClipsEl, 'コピー履歴 ' + data.clips.length + '/' + L.MAX_ITEMS,
      '履歴 ' + data.clips.length);
    setTabLabel(tabMemosEl, 'メモ ' + data.memos.length + '/' + L.MAX_ITEMS,
      'メモ ' + data.memos.length);
    tabClipsEl.classList.toggle('on', currentTab === 'clips');
    tabMemosEl.classList.toggle('on', currentTab === 'memos');
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
  }

  function buildComposer() {
    var card = el('div', 'card');
    card.style.background = L.colorHex('yellow');
    var ta = document.createElement('textarea');
    ta.value = composerDraft;
    ta.maxLength = L.MAX_TEXT;
    ta.placeholder = 'メモを入力…';
    ta.addEventListener('input', function () { composerDraft = ta.value; });
    var row = el('div', 'editrow');
    var cancel = textBtn('キャンセル', function () {
      composerOpen = false;
      composerDraft = '';
      render();
    }, 'sub');
    var save = textBtn('保存', function () {
      if (!ta.value.trim()) { toast('文字を入力してください'); return; }
      var v = ta.value;
      composerOpen = false;
      composerDraft = '';
      sendOp({ op: 'addMemo', text: v });
      render();
    });
    row.appendChild(cancel);
    row.appendChild(save);
    card.appendChild(ta);
    card.appendChild(row);
    setTimeout(function () { try { ta.focus(); } catch (e) {} }, 0);
    return card;
  }

  function buildCard(item, kind) {
    var card = el('div', 'card');
    card.style.background = L.colorHex(item.color);

    var txt = el('div', 'txt clamp');
    txt.style.color = L.textColorHex(item.textColor);
    txt.textContent = item.text || '(空のメモ)';
    if (!item.text) txt.style.opacity = '.55';
    txt.title = 'クリックで全文表示/折りたたみ';
    txt.addEventListener('click', function () { txt.classList.toggle('clamp'); });
    card.appendChild(txt);

    var meta = el('div', 'meta');
    var time = el('span', 'time');
    time.textContent = fmtTime(item.ts);
    meta.appendChild(time);

    meta.appendChild(iconBtn('📌', item.pinned ? 'ピン止めを外す' : 'ピン止め(自動削除されず上に固定)', function () {
      sendOp({ op: 'togglePin', kind: kind, id: item.id });
    }, item.pinned));

    meta.appendChild(iconBtn('📋', 'クリップボードにコピー', function () {
      copyText(item.text);
    }));

    meta.appendChild(iconBtn('✏️', '編集', function () {
      startEdit(item, kind);
    }));

    meta.appendChild(iconBtn('🎨', '色を変える', function () {
      paletteOpenId = paletteOpenId === item.id ? null : item.id;
      render();
    }));

    var del;
    if (confirmDeleteId === item.id) {
      del = el('button', 'iconbtn danger');
      del.textContent = '削除する';
      del.addEventListener('click', function () {
        confirmDeleteId = null;
        sendOp({ op: 'remove', kind: kind, id: item.id });
      });
    } else {
      del = iconBtn('🗑️', '削除', function () {
        confirmDeleteId = item.id;
        render();
        setTimeout(function () {
          if (confirmDeleteId === item.id) {
            confirmDeleteId = null;
            if (visible) scheduleRender();
          }
        }, 2500);
      });
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
    card.style.background = L.colorHex(item ? item.color : (kind === 'memo' ? 'yellow' : 'white'));
    var ta = document.createElement('textarea');
    ta.value = editDraft;
    ta.maxLength = L.MAX_TEXT;
    ta.addEventListener('input', function () { editDraft = ta.value; });
    var row = el('div', 'editrow');
    var cancel = textBtn('キャンセル', function () {
      clearEditState();
      render();
    }, 'sub');
    var save = textBtn('保存', function () {
      var v = ta.value;
      var id = editingId;
      var stillThere = (kind === 'memo' ? data.memos : data.clips)
        .some(function (it) { return it.id === id; });
      clearEditState();
      if (stillThere) {
        sendOp({ op: 'updateText', kind: kind, id: id, text: v });
      } else if (v.trim()) {
        /* 編集している間に他のタブや自動削除で元項目が消えていた場合の救済 */
        sendOp(kind === 'memo' ? { op: 'addMemo', text: v } : { op: 'addClip', text: v });
        toast('元の項目が消えていたため、新しく保存しました');
      }
      render();
    });
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
