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
  var btnSearchEl = null, searchBarEl = null, searchInputEl = null, searchCountEl = null;
  var btnPauseEl = null, pauseBarEl = null;
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
  var recordingPaused = false;        // 記録の一時停止(全部のフレームで共有・storage.local)
  /* 検索は状態駆動。文字は searchQuery に持ち、入力欄そのものは render() で作り直さない
     (作り直すと日本語の変換中の文字が消えるため。render() は表示と件数だけを合わせる) */
  var searchOpen = false;
  var searchQuery = '';
  var searchComposing = false;        // 変換中は絞り込まず、確定してから絞り込む
  var filtering = false;              // いま絞り込んで表示しているか(render()が決める)
  var undoPending = null;             // 直前に消した項目 {kind, item}(トーストが出ている間だけ戻せる)
  var focusAfterRender = null;        // 次の描画のあとフォーカスを置くカード {key, act}
  var toastTimer = null;
  var toastMs = 0;
  var toastOnHide = null;
  var saveStateTimer = null;
  var resizeClampTimer = null;

  /* 文字の大きさ(s=小・m=中・l=大)。storage の fontSize に置く */
  var fontSize = 'm';
  var btnFontEl = null, btnTplEl = null;
  /* お知らせの帯 */
  var noticeBackupEl = null, noticeA2hsEl = null;
  var backupInfo = { lastBackupAt: null, baselineAt: null, snoozeUntil: null };
  var a2hsSeen = false;               // ホーム画面への追加のご案内を「わかった」で閉じたか(Web版だけ)
  /* ひな形。null=まだ自分では変えていない(最初のひな形をそのまま見せる) */
  var templates = null;
  var templatesOpen = false;
  var tplEdit = null;                 // 編集中のひな形 {id(新規はnull), title, text}。状態駆動で描く
  var tplSaving = false;
  var tplFocusPending = false;
  var tplConfirmId = null;            // 「削除する」に切り替えたひな形
  var tplConfirmAt = 0;
  var tplConfirmTimer = null;
  var TPL_KEY = '__templates__';      // ひな形の箱のフォーカス目印
  /* 読み上げ */
  var speakingId = null;              // いま読み上げている項目の id
  var speakGen = 0;                   // 読み上げを始めるたびに増やす(古い読み上げの終わりの知らせを捨てる)

  /* 画面の言葉。ヘッダーの言語ボタンで選んだもの(storage の uiLang)を優先し、
     選んでいなければブラウザの言語が日本語なら日本語、それ以外は英語 */
  var LANG_AUTO = (function () {
    try {
      var l = (navigator.languages && navigator.languages[0]) || navigator.language || '';
      if (!l) return 'ja';
      return /^ja\b/i.test(l) ? 'ja' : 'en';
    } catch (e) { return 'ja'; }
  })();
  var LANG = LANG_AUTO;
  function validLang(v) { return v === 'ja' || v === 'en' ? v : null; }
  function T(ja, en) { return LANG === 'ja' ? ja : en; }
  /* 色や並べ替えの名前(store_logic.js の name / en) */
  function nm(o) { return LANG === 'ja' ? o.name : (o.en || o.name); }
  /* store_logic.js が投げる読み込みエラーの文言 */
  var ERR_EN = {
    'ファイルの形式が違います': 'The file format is not correct',
    'このアプリのバックアップではありません': 'This is not a backup file from this app'
  };
  function trErr(m) { return LANG === 'ja' ? m : (ERR_EN[m] || m); }

  var SAVE_FAIL_MSG = T('保存できませんでした。ページを再読み込みしてください', 'Could not save. Please reload the page');
  /* 🗑️をダブルクリックすると、2打目が切り替わった「削除する」に当たって素通りする。
     切り替わってからこの間のクリックは受け付けない */
  var CONFIRM_GUARD_MS = 600;
  var CONFIRM_RESET_MS = 5000;        // 「削除する」を自動で🗑️に戻すまで
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  var COMPOSER_KEY = '__composer__';  // 新しいメモの入力カードのフォーカス目印
  var UNDO_MS = 6000;                 // 「元に戻す」を出しておく長さ(マウスやフォーカスが乗っている間は消さない)

  /* ---------- スタイル ---------- */
  /* 🔴 パネルの最小サイズ。CSSと位置復元の両方で使う(片方だけ直すと、
        縮めても再表示で元に戻る不具合になる) */
  var MIN_W = 100, MIN_H = 170;

  /* 幅が狭いときの詰め方(@container の段階ごと)。末尾の tierCss() が @container にして並べる */
  var TIER_330 = [
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
  ];

  var TIER_240 = [
    '  .hdr .ttl { display: none; }',
    /* ヘッダーのボタンが6つになったので、ロゴを隠して詰める。🔴 それでも入らない幅では
       折り返す(右端の「しまう」が切れて押せなくなるのを防ぐ)。24pxは押しやすさの下限 */
    '  .logo { display: none; }',
    '  .hdr-actions { gap: 3px; flex-wrap: wrap; justify-content: flex-end; }',
    '  .hdr .iconbtn { width: 24px; }',
    '  .meta { flex-wrap: wrap; }',
    '  .meta .time { flex: 1 0 100%; margin-bottom: 3px; }',
  ];

  var TIER_165 = [
    '  .toolbar { flex-direction: column; gap: 4px; padding: 5px 5px; }',
    '  .btn { width: 100%; padding: 7px 4px; font-size: 11px; }',
    '  .sortbox { max-width: none; width: 100%; font-size: 11px; padding: 3px 2px; }',
    '  .tab { font-size: 11px; padding: 7px 1px; }',
    '  .hdr { padding: 5px 6px; }',
    '  .list { padding: 5px 5px 8px; gap: 5px; }',
    '  .card { padding: 6px 6px; }',
    '  .card .txt { font-size: calc(var(--txt-fs, 13px) - 1px); }',
    '  .card .txt.clamp { -webkit-line-clamp: 3; }',
    /* 22pxなら100px幅でも3つ並ぶ(24pxだと2つで折り返して3段になる) */
    '  .meta { gap: 2px; justify-content: flex-end; margin-top: 5px; }',
    '  .iconbtn { width: 22px; height: 21px; font-size: 11px; }',
    '  .toast { padding: 5px 8px; font-size: 11px; bottom: 8px; }',
    '  .toast-act { margin: 4px 0 0; }',
    /* この幅でバックアップや窓の切り替えはしないので隠す(広げれば出る)。
       ロゴも隠して、検索・一時停止・しまうの3つを1列に収める */
    '  .bak, .win, .logo, .langbtn, .fontbtn { display: none; }',
    '  .pausebar, .searchbar, .notice { padding: 5px 5px; font-size: 11px; }',
    '  .searchbar .count { font-size: 11px; }',
  ];

  /* 文字「大」のときだけ、同じ詰め方を広い幅から始めるための接頭辞 */
  var FS_L = '.panel.fs-l ';

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
    /* 付箋の文字の大きさ(小・中・大)。ツールバーの「Aあ」で切り替える。中が今までの大きさ */
    '  --txt-fs: 13px;',
    '}',
    '.panel.fs-s { --txt-fs: 12px; }',
    '.panel.fs-l { --txt-fs: 18px; }',
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
    '.iconbtn.on { background: #23804a; color: #ffffff; }',
    '.iconbtn.danger { background: #c9302c; color: #fff; font-size: 12px; font-weight: 700;',
    '  width: auto; padding: 0 10px; }',
    /* 言語の切り替え(「EN」/「日本語」の文字で出す) */
    '.hdr .iconbtn.langbtn { width: auto; min-width: 30px; padding: 0 6px; font-size: 12px; font-weight: 700; color: #1d5e37; }',
    '.tabs { display: flex; background: #f7faf8; border-bottom: 1px solid #ddd; flex: none; }',
    '.tab { flex: 1; border: none; background: none; padding: 10px 4px; text-align: center;',
    '  cursor: pointer; font-size: 13px; color: #555; border-bottom: 3px solid transparent; }',
    '.tab.on { border-bottom-color: #23804a; color: #1b6b3d; font-weight: 700; background: #fff; }',
    /* 「ひな形」「Aあ」でボタンが増えたので、入りきらない幅では折り返す(右端が切れて押せなくなるのを防ぐ) */
    '.toolbar { padding: 8px 10px; display: flex; flex-wrap: wrap; gap: 8px; flex: none; background: #fff;',
    '  align-items: stretch; }',
    '.sortbox { flex: none; max-width: 46%; border: 1px solid #c8d2cc; border-radius: 8px;',
    '  background: #f7faf8; color: #1b6b3d; font-size: 12px; font-weight: 600;',
    '  padding: 0 4px; cursor: pointer; }',
    '.lbl-min { display: none; }',
    /* 文字の大きさの切り替えと、ひな形のボタン(ツールバー) */
    '.fontbtn { flex: none; border: 1px solid #c8d2cc; border-radius: 8px; background: #f7faf8;',
    '  color: #1b6b3d; font-size: 12px; font-weight: 700; padding: 0 8px; cursor: pointer; min-width: 34px; }',
    '.fontbtn:hover { background: #e3efe7; }',
    '.btn.tplbtn { flex: none; }',
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
    '  font-size: var(--txt-fs, 13px); }',
    '.card .txt.clamp { display: -webkit-box; -webkit-line-clamp: 4;',
    '  -webkit-box-orient: vertical; overflow: hidden; }',
    '.card textarea { width: 100%; min-height: 76px; border: 1px solid rgba(0,0,0,.3);',
    '  border-radius: 6px; padding: 7px; font-size: var(--txt-fs, 13px); line-height: 1.5;',
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
    /* 「元に戻す」付きのトーストだけ押せるようにする */
    '.toast.show.has-act { pointer-events: auto; opacity: 1; }',
    '.toast-act { margin-left: 10px; border: 1px solid #ffffff; background: transparent;',
    '  color: #ffffff; border-radius: 12px; padding: 1px 10px; font-size: 12px; font-weight: 700;',
    '  cursor: pointer; white-space: nowrap; line-height: 1.6; }',
    '.toast-act:hover { background: rgba(255,255,255,.18); }',
    /* 記録の一時停止中の帯。色だけに頼らず文字と記号で伝える */
    '.pausebar { display: none; align-items: center; gap: 6px 8px; flex-wrap: wrap; flex: none;',
    '  padding: 6px 10px; background: #fff4d6; color: #5c3b00; border-bottom: 1px solid #e3bf62;',
    '  font-size: 12px; font-weight: 700; line-height: 1.4; }',
    '.pausebar.on { display: flex; }',
    '.pausebar-txt { flex: 1 1 auto; min-width: 0; }',
    '.pausebar-btn { flex: none; border: 1px solid #8a5a00; background: #ffffff; color: #5c3b00;',
    '  border-radius: 8px; padding: 3px 10px; font-size: 12px; font-weight: 700; cursor: pointer; }',
    /* 検索の欄 */
    '.searchbar { display: none; align-items: center; gap: 4px 6px; flex-wrap: wrap; flex: none;',
    '  padding: 6px 10px; background: #ffffff; border-bottom: 1px solid #e3ebe6; }',
    '.searchbar.open { display: flex; }',
    /* 枠線は白との差 3:1 以上(入力欄の場所が見えるように) */
    '.searchbar input { flex: 1 1 90px; min-width: 0; border: 1px solid #7d8f83; border-radius: 8px;',
    '  padding: 6px 8px; font-size: 13px; color: #1b1b1b; background: #ffffff; }',
    '.searchbar .count { font-size: 12px; color: #3d4a42; }',
    /* お知らせの帯(書き出しのお願い・ホーム画面への追加のご案内)。色だけに頼らず文字で伝える。
       文字と背景は 10:1 以上、ボタンの枠は背景との差 3:1 以上 */
    '.notice { display: none; align-items: center; gap: 6px 8px; flex-wrap: wrap; flex: none;',
    '  padding: 7px 10px; background: #e8f2fb; color: #12365a; border-bottom: 1px solid #a9c6e3;',
    '  font-size: 12px; line-height: 1.5; }',
    '.notice.on { display: flex; }',
    '.notice-txt { flex: 1 1 140px; min-width: 0; white-space: pre-line; }',
    '.notice-btns { display: flex; gap: 6px; flex-wrap: wrap; flex: none; }',
    '.notice-btn { flex: none; border: 1px solid #1d4f82; background: #ffffff; color: #12365a;',
    '  border-radius: 8px; padding: 3px 10px; font-size: 12px; font-weight: 700; cursor: pointer; }',
    '.notice-btn:hover { background: #dbe9f6; }',
    /* ひな形の箱(メモのタブの先頭に出る) */
    '.tplbox { flex: none; border: 1px solid #a9c9b5; border-radius: 10px; background: #ffffff;',
    '  padding: 8px 9px; }',
    '.tplhead { font-size: 12px; font-weight: 700; color: #1b6b3d; margin-bottom: 4px; line-height: 1.5; }',
    '.tplrow { display: flex; align-items: center; gap: 4px; padding: 5px 0; border-top: 1px dashed #c3d6ca; }',
    '.tplrow .tpltitle { flex: 1 1 auto; min-width: 0; font-size: 13px; color: #1b1b1b;',
    '  overflow-wrap: anywhere; line-height: 1.4; }',
    '.tplrow .iconbtn { background: #e3efe7; }',
    '.tplrow .iconbtn:hover { background: #d2e5d9; }',
    '.tplrow .iconbtn.danger { background: #c9302c; }',
    '.tplfoot { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap;',
    '  margin-top: 6px; padding-top: 6px; border-top: 1px dashed #c3d6ca; }',
    '.tplbox input[type=text], .tplbox textarea { width: 100%; border: 1px solid #7d8f83;',
    '  border-radius: 6px; padding: 6px 7px; font-size: 13px; line-height: 1.5; color: #1b1b1b;',
    '  background: #ffffff; margin-top: 5px; }',
    '.tplbox textarea { min-height: 84px; resize: vertical; }',
    /* キーボードで動かしたときの目印。付箋のどの色の上でも見えるよう白と濃い青の二重の輪にする
       (外側に出すと端のタブがパネルの縁で切れるので、タブだけ内側に描く) */
    'button:focus-visible, select:focus-visible, textarea:focus-visible, input:focus-visible {',
    '  outline: none; box-shadow: 0 0 0 2px #ffffff, 0 0 0 4px #174ea6; }',
    '.tab:focus-visible { box-shadow: inset 0 0 0 3px #174ea6; }',

    /* 🔴 @container は詳細度を上げないので、上書きしたい通常ルールより「後ろ」に
          置かないと効かない。必ずCSSの最後に置くこと(前に置くと半分死ぬ)。
          段階ごとの詰め方は上の TIER_330 / TIER_240 / TIER_165 にまとめてあり、
          ここで @container にして並べる。文字を「大」にしたときは同じ詰め方を
          広い幅(400 / 300 / 200)から先に始める(.panel.fs-l を付けた同じ規則を、通常の後ろに置く) */
  ].concat(
    tierCss(330, TIER_330, ''),
    tierCss(240, TIER_240, ''),
    tierCss(165, TIER_165, ''),
    tierCss(400, TIER_330, FS_L),
    tierCss(300, TIER_240, FS_L),
    tierCss(200, TIER_165, FS_L)
  ).join('\n');

  /* 「セレクタ { 中身 }」の1規則の、すべてのセレクタに接頭辞を付ける */
  function scopeRule(rule, prefix) {
    if (!prefix) return rule;
    var i = rule.indexOf('{');
    var sels = rule.slice(0, i).split(',').map(function (x) { return prefix + x.trim(); }).join(', ');
    return '  ' + sels + ' ' + rule.slice(i);
  }
  function tierCss(px, rules, prefix) {
    return ['@container (max-width: ' + px + 'px) {']
      .concat(rules.map(function (r) { return scopeRule(r, prefix); }), ['}']);
  }

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

  /* 長い知らせ(保存できなかった・整理した件数など)は読み切れるよう長めに出す。
     action={label, title, ms, onClick, onHide} を渡すと押せるボタン付きになる(「元に戻す」)。
     マウスやフォーカスが乗っている間は消さない(読み上げやキーボードで押す時間を取る) */
  function toast(msg, action) {
    if (!toastEl) return;
    var prevOnHide = toastOnHide;
    toastOnHide = null;
    if (prevOnHide) prevOnHide();   // 前の「元に戻す」は、別の知らせに替わった時点で終わり
    var text = String(msg);
    toastEl.textContent = '';
    var span = el('span', 'toast-msg');
    span.textContent = text;
    toastEl.appendChild(span);
    if (action) {
      var b = el('button', 'toast-act');
      b.textContent = action.label;
      b.title = action.title || action.label;
      b.dataset.act = 'toast-act';
      b.addEventListener('click', action.onClick);
      toastEl.appendChild(b);
      toastOnHide = action.onHide || null;
    }
    toastEl.classList.toggle('has-act', !!action);
    toastEl.classList.add('show');
    toastMs = action ? (action.ms || UNDO_MS) : Math.min(6000, Math.max(1700, text.length * 110));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, toastMs);
  }

  /* 消すときはボタンも抜く(見えないのにTabで止まらないように) */
  function hideToast() {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastEl.classList.remove('show');
    toastEl.classList.remove('has-act');
    var b = findAct(toastEl, 'toast-act');
    if (b) b.remove();
    var f = toastOnHide;
    toastOnHide = null;
    if (f) f();
  }

  function holdToast() { clearTimeout(toastTimer); }
  function releaseToast() {
    if (!toastEl || !toastEl.classList.contains('show')) return;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, Math.max(2000, toastMs));
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

  /* ---------- 設定の保存(storage.local に直接置く。言語・文字の大きさ・お知らせの記録) ---------- */

  /* 保存できたら resolve、できなければ画面に出す文言で reject */
  function saveLocal(obj) {
    return new Promise(function (resolve, reject) {
      if (!extAlive()) { reject(SAVE_FAIL_MSG); return; }
      var p;
      try { p = chrome.storage.local.set(obj); } catch (e) { reject(SAVE_FAIL_MSG); return; }
      if (p && p.then) p.then(function () { resolve(); }, function () { reject(SAVE_FAIL_MSG); });
      else resolve();
    });
  }

  /* 保存できなくても使い続けられるもの(お知らせの記録など)は、知らせずに流す */
  function saveLocalQuiet(obj) {
    saveLocal(obj).then(null, function () {});
  }

  function numOrNull(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  /* ---------- 文字の大きさ ---------- */

  function fontName() {
    for (var i = 0; i < L.FONT_SIZES.length; i++) if (L.FONT_SIZES[i].id === fontSize) return nm(L.FONT_SIZES[i]);
    return '';
  }

  /* 見た目は panel のクラス(fs-s / fs-l)で切り替える。パネルを作り直さずに済む */
  function applyFontSize(id) {
    fontSize = L.isFontSize(id) ? id : 'm';
    if (!panelEl) return;
    panelEl.classList.remove('fs-s', 'fs-l');
    if (fontSize === 's') panelEl.classList.add('fs-s');
    if (fontSize === 'l') panelEl.classList.add('fs-l');
    if (btnFontEl) {
      var t = T('文字の大きさ（いま: ' + fontName() + '。押すと変わります）',
        'Text size (now: ' + fontName() + '. Press to change)');
      btnFontEl.title = t;
      btnFontEl.setAttribute('aria-label', t);
    }
  }

  function cycleFontSize() {
    var next = L.nextFontSize(fontSize);
    applyFontSize(next);
    toast(T('文字の大きさ: ', 'Text size: ') + fontName());
    saveLocal({ fontSize: next }).then(null, toast);
  }

  /* ---------- お知らせの帯(書き出しのお願い・ホーム画面への追加) ---------- */

  /* 書き出しのお願いを出すか。最後の書き出し(無ければ使い始め)から30日たち、
     書き出す価値のある中身(メモ・ピン止め)があり、「あとで」の期間でないとき */
  function backupDue() {
    return L.backupReminderDue(Date.now(), {
      lastBackupAt: backupInfo.lastBackupAt,
      baselineAt: backupInfo.baselineAt,
      snoozeUntil: backupInfo.snoozeUntil,
      hasData: L.hasBackupWorthyData(data.clips, data.memos)
    });
  }

  function snoozeBackup() {
    var until = Date.now() + L.BACKUP_SNOOZE_DAYS * 24 * 60 * 60 * 1000;
    backupInfo.snoozeUntil = until;
    saveLocalQuiet({ backupSnoozeUntil: until });
    render();
    try { btnSearchEl.focus(); } catch (e) {}
  }

  /* 書き出せたら、数え直す(次のお知らせは30日後) */
  function markBackedUp() {
    var now = Date.now();
    backupInfo.lastBackupAt = now;
    backupInfo.snoozeUntil = null;
    saveLocalQuiet({ lastBackupAt: now, backupSnoozeUntil: null });
    if (visible) render();
  }

  /* iPhone・iPad のブラウザで開いていて、まだホーム画面から開いていないか */
  function needsA2hsGuide() {
    try {
      var ua = String(navigator.userAgent || '');
      var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (!ios) return false;
      if (navigator.standalone === true) return false;
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return false;
      return true;
    } catch (e) { return false; }
  }

  function dismissA2hs() {
    a2hsSeen = true;
    saveLocalQuiet({ a2hsSeen: true });
    render();
    try { btnSearchEl.focus(); } catch (e) {}
  }

  function renderNotices() {
    if (!noticeBackupEl) return;
    noticeBackupEl.classList.toggle('on', backupDue());
    noticeA2hsEl.classList.toggle('on', IS_WEB_APP && !a2hsSeen && needsA2hsGuide());
  }

  /* ---------- 読み上げ(声で読む) ---------- */

  function ttsSupported() {
    try { return !!(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function'); } catch (e) { return false; }
  }

  /* 声の一覧は、ブラウザによって最初は空で、あとから届く。少しだけ待つ */
  function getVoicesReady(cb) {
    var ss = window.speechSynthesis;
    var list = [];
    try { list = ss.getVoices() || []; } catch (e) { list = []; }
    if (list.length) { cb(list); return; }
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      try { ss.removeEventListener('voiceschanged', finish); } catch (e) {}
      var v = [];
      try { v = ss.getVoices() || []; } catch (e2) { v = []; }
      cb(v);
    };
    try { ss.addEventListener('voiceschanged', finish); } catch (e3) {}
    setTimeout(finish, 700);
  }

  /* 🔴 読み上げは端末に入っている声だけを使う(ネットの声は文字を外へ送ることがあるため)。
     画面の言語に合う、端末の声が見つからなければ読まない。
     声の一覧が空のときも、端末の声かどうか確かめられないので読まない(ブラウザ任せにするとネットの声になることがある) */
  function pickVoice(voices) {
    var want = LANG === 'ja' ? 'ja' : 'en';
    var local = voices.filter(function (v) {
      var lang = String(v.lang || '').toLowerCase().replace('_', '-').split('-')[0];
      return lang === want && v.localService !== false;
    });
    if (local.length) {
      for (var i = 0; i < local.length; i++) if (local[i].default) return { voice: local[i] };
      return { voice: local[0] };
    }
    return { none: true };
  }

  function stopSpeaking(silent) {
    speakGen++;
    var was = speakingId;
    speakingId = null;
    try { if (ttsSupported()) window.speechSynthesis.cancel(); } catch (e) {}
    if (!silent && was !== null && visible) render();
  }

  /* もう一度押すと止まる。読み終わったら、ボタンを元に戻す */
  function toggleSpeak(item) {
    if (!ttsSupported()) return;
    if (speakingId === item.id) { stopSpeaking(); return; }
    var text = String(item.text || '');
    if (!text.trim()) { toast(T('読み上げる文字がありません', 'There is no text to read')); return; }
    stopSpeaking(true);
    var gen = speakGen;
    speakingId = item.id;
    render();
    getVoicesReady(function (voices) {
      if (gen !== speakGen) return;
      var pick = pickVoice(voices);
      var fail = function (msg) {
        speakingId = null;
        if (visible) render();
        toast(msg);
      };
      if (pick.none) {
        fail(T('この端末には、日本語の読み上げの声が入っていません', 'This device has no English voice for reading aloud'));
        return;
      }
      var chunks = L.speakChunks(text);
      var ss = window.speechSynthesis;
      var finish = function () {
        if (gen !== speakGen) return;
        speakingId = null;
        if (visible) scheduleRender();
      };
      try {
        chunks.forEach(function (c, i) {
          var u = new window.SpeechSynthesisUtterance(c);
          u.lang = pick.voice && pick.voice.lang ? pick.voice.lang : (LANG === 'ja' ? 'ja-JP' : 'en-US');
          if (pick.voice) u.voice = pick.voice;
          if (i === chunks.length - 1) u.onend = finish;
          u.onerror = function (e) {
            /* 自分で止めたときの知らせ(canceled / interrupted)は、止めた側が片づけている */
            var er = e && e.error;
            if (er === 'canceled' || er === 'interrupted') return;
            if (gen === speakGen) fail(T('読み上げできませんでした', 'Could not read aloud'));
          };
          ss.speak(u);
        });
      } catch (e2) {
        fail(T('読み上げできませんでした', 'Could not read aloud'));
      }
    });
  }

  /* ---------- ひな形(メモのひな形) ---------- */

  function getTemplates() { return templates || L.defaultTemplates(LANG); }

  function tplNewId() {
    return 'tpl-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
  }

  function closeTemplates() {
    templatesOpen = false;
    tplEdit = null;
    tplConfirmId = null;
    clearTimeout(tplConfirmTimer);
  }

  function toggleTemplates() {
    if (templatesOpen) closeTemplates();
    else templatesOpen = true;
    render();
    if (!templatesOpen) { try { btnTplEl.focus(); } catch (e) {} }
  }

  function startTplEdit(t) {
    if (!t && getTemplates().length >= L.MAX_TEMPLATES) {
      toast(T('ひな形は' + L.MAX_TEMPLATES + '個までです。いらないものを消してください', 'You can keep up to ' + L.MAX_TEMPLATES + ' templates. Please delete one you do not need'));
      return;
    }
    tplEdit = { id: t ? t.id : null, title: t ? t.title : '', text: t ? t.text : '' };
    tplFocusPending = true;
    tplConfirmId = null;
    render();
  }

  /* 全部を1回で保存する。🔴 保存できてから画面の状態を変える(失敗したら下書きを残す) */
  function saveTemplates(list) {
    var clean = L.sanitizeTemplates(list) || [];
    return saveLocal({ templates: clean }).then(function () { templates = clean; });
  }

  function addTemplateAsMemo(t) {
    saveOp({ op: 'addMemo', text: t.text }).then(function () {
      closeTemplates();
      render();
      try { btnTplEl.focus(); } catch (e) {}
      toast(T('メモに追加しました。✏️で書き足せます', 'Added as a memo. Use ✏️ to fill it in'));
    }, toast);
  }

  function buildTemplateBox() {
    var box = el('div', 'tplbox');
    box.dataset.fkey = TPL_KEY;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', T('ひな形', 'Templates'));

    if (tplEdit) {
      var head = el('div', 'tplhead');
      head.textContent = tplEdit.id ? T('ひな形を直す', 'Edit template') : T('ひな形を作る', 'New template');
      box.appendChild(head);
      var ti = document.createElement('input');
      ti.type = 'text';
      ti.maxLength = L.MAX_TEMPLATE_TITLE;
      ti.value = tplEdit.title;
      ti.placeholder = T('名前（例: 住所）', 'Name (e.g. Address)');
      ti.setAttribute('aria-label', T('ひな形の名前', 'Template name'));
      ti.dataset.act = 'tpl-title';
      ti.addEventListener('input', function () { if (tplEdit) tplEdit.title = ti.value; });
      var ta = document.createElement('textarea');
      ta.maxLength = L.MAX_TEXT;
      ta.value = tplEdit.text;
      ta.placeholder = T('追加されるメモの文', 'Text of the memo to add');
      ta.setAttribute('aria-label', T('ひな形の文', 'Template text'));
      ta.dataset.act = 'tpl-text';
      ta.addEventListener('input', function () { if (tplEdit) tplEdit.text = ta.value; });
      box.appendChild(ti);
      box.appendChild(ta);
      var row = el('div', 'tplfoot');
      row.appendChild(textBtn(T('キャンセル', 'Cancel'), function () {
        tplEdit = null;
        render();
      }, 'sub', 'tpl-cancel'));
      row.appendChild(textBtn(T('保存', 'Save'), function () {
        if (tplSaving || !tplEdit) return;
        tplEdit.title = ti.value;
        tplEdit.text = ta.value;
        if (!ta.value.trim()) { toast(T('文字を入力してください', 'Please enter some text')); return; }
        var id = tplEdit.id;
        var entry = { id: id || tplNewId(), title: ti.value, text: ta.value };
        var list = getTemplates();
        var next = id
          ? list.map(function (x) { return x.id === id ? entry : x; })
          : list.concat([entry]);
        tplSaving = true;
        saveTemplates(next).then(function () {
          tplSaving = false;
          tplEdit = null;
          render();
          toast(T('ひな形を保存しました', 'Template saved'));
        }, function (msg) {
          tplSaving = false;
          toast(msg);
        });
      }, '', 'tpl-save'));
      box.appendChild(row);
      if (tplFocusPending) {
        tplFocusPending = false;
        setTimeout(function () { try { ti.focus(); } catch (e) {} }, 0);
      }
      return box;
    }

    var h = el('div', 'tplhead');
    h.textContent = T('「追加」を押すと、ひな形が新しいメモとして入ります。名前も中身も自由に直せます（この端末の中にだけ保存）。',
      'Press Add to put a template in as a new memo. You can edit or delete them (saved only on this device).');
    box.appendChild(h);
    var list2 = getTemplates();
    if (!list2.length) {
      var em = el('div', 'tplhead');
      em.textContent = T('ひな形がありません。「＋ ひな形を作る」で作れます。', 'There are no templates. Use "+ New template" to make one.');
      box.appendChild(em);
    }
    list2.forEach(function (t) {
      var r = el('div', 'tplrow');
      r.dataset.tid = t.id;
      var title = el('span', 'tpltitle');
      title.textContent = t.title;
      r.appendChild(title);
      var add = textBtn(T('追加', 'Add'), function () { addTemplateAsMemo(t); }, '', 'tpl-add-' + t.id);
      add.setAttribute('aria-label', T('「' + t.title + '」をメモに追加', 'Add "' + t.title + '" as a memo'));
      r.appendChild(add);
      r.appendChild(iconBtn('✏️', T('「' + t.title + '」を直す', 'Edit "' + t.title + '"'), function () { startTplEdit(t); }, false, 'tpl-edit-' + t.id));
      var del;
      if (tplConfirmId === t.id) {
        del = el('button', 'iconbtn danger');
        del.textContent = T('削除する', 'Confirm delete');
        del.dataset.act = 'tpl-del-' + t.id;
        del.addEventListener('click', function () {
          if (Date.now() - tplConfirmAt < CONFIRM_GUARD_MS) return;
          tplConfirmId = null;
          clearTimeout(tplConfirmTimer);
          saveTemplates(getTemplates().filter(function (x) { return x.id !== t.id; })).then(function () {
            render();
            toast(T('ひな形を削除しました', 'Template deleted'));
          }, toast);
        });
      } else {
        del = iconBtn('🗑️', T('「' + t.title + '」を削除', 'Delete "' + t.title + '"'), function () {
          tplConfirmId = t.id;
          tplConfirmAt = Date.now();
          clearTimeout(tplConfirmTimer);
          tplConfirmTimer = setTimeout(function () {
            if (tplConfirmId === t.id) { tplConfirmId = null; if (visible) scheduleRender(); }
          }, CONFIRM_RESET_MS);
          render();
        }, false, 'tpl-del-' + t.id);
      }
      r.appendChild(del);
      box.appendChild(r);
    });
    var foot = el('div', 'tplfoot');
    foot.appendChild(textBtn(T('＋ ひな形を作る', '+ New template'), function () { startTplEdit(null); }, 'sub', 'tpl-new'));
    foot.appendChild(textBtn(T('閉じる', 'Close'), toggleTemplates, 'sub', 'tpl-close'));
    box.appendChild(foot);
    return box;
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

  /* auto:true = ページでのコピーの自動記録(一時停止中は background でも捨てる) */
  function onCopyOrCut(e) {
    if (recordingPaused) return;   // 記録の一時停止中
    var t = grabCopiedText(e);
    if (!t || !t.trim()) return;
    sendOp({ op: 'addClip', text: t, auto: true });
  }

  document.addEventListener('copy', onCopyOrCut, true);
  document.addEventListener('cut', onCopyOrCut, true);

  /* 一時停止の状態は、iframe も含めた全部のフレームが自分で読む(コピーはどのフレームでも起きる) */
  if (!IS_WEB_APP) {
    try {
      chrome.storage.local.get({ recordingPaused: false }, function (res) {
        recordingPaused = !!(res && res.recordingPaused);
        if (visible) render();
      });
    } catch (e) {}
  }

  /* ---------- クリップボード操作 ---------- */
  /* 🔴 できたときだけ「コピーしました」。両方のやり方でだめなら、そう伝える */
  function copyText(text) {
    var ok = function () { toast(T('コピーしました', 'Copied')); };
    var ng = function () { toast(T('コピーできませんでした', 'Could not copy')); };
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
    var fail = function () { toast(T('読み取れませんでした', 'Could not read the clipboard')); };
    if (!extAlive()) { toast(SAVE_FAIL_MSG); return; }
    try {
      chrome.runtime.sendMessage({ type: 'soyogi-fusen-read-clipboard' }).then(function (res) {
        if (res && res.ok && res.text && res.text.trim()) {
          saveOp({ op: 'addClip', text: res.text }).then(function () {
            toast(T('取り込みました', 'Added'));
          }, toast);
        } else if (res && res.ok) {
          toast(T('クリップボードに文字がありません', 'There is no text on the clipboard'));
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
    /* しぼりこみ中は位置があいまいになるので並べ替えない(取っ手も出していない) */
    if (editingId || composerOpen || filtering) return;
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
    if (filtering) return;
    var key = kind === 'memo' ? 'memos' : 'clips';
    var ids = L.sortForDisplay(data[key], 'manual').map(function (it) { return it.id; });
    var i = ids.indexOf(item.id);
    var j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids[i] = ids[j];
    ids[j] = item.id;
    saveOrder(kind, ids);
    render();   // フォーカスは動かしたカードの取っ手に戻る
    toast(T((j + 1) + '番目に動かしました', 'Moved to position ' + (j + 1)));
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
          else toast(T('小窓を開けませんでした', 'Could not open the small window'));
        }, function () { toast(T('小窓を開けませんでした', 'Could not open the small window')); });
      } else {
        hidePanel();
      }
    } catch (e) {
      toast(T('小窓を開けませんでした', 'Could not open the small window'));
    }
  }

  /* ---------- 記録の一時停止 ---------- */

  /* storage.local に置くので、全部のタブ・iframe とブラウザの開き直しに効く。
     止めている間も「取り込む」ボタンとメモは使える(止めるのはページでのコピーの自動記録だけ) */
  function togglePaused() {
    var next = !recordingPaused;
    var fromBar = false;
    try { fromBar = !!(shadow.activeElement && shadow.activeElement.id === 'btn-resume'); } catch (e) {}
    saveOp({ op: 'setRecordingPaused', paused: next }).then(function () {
      recordingPaused = next;
      render();
      /* 帯の「再開する」で再開したら帯が消えるので、ヘッダーのボタンへフォーカスを移す */
      if (fromBar) { try { btnPauseEl.focus(); } catch (e2) {} }
      toast(next ? T('記録を止めました。「取り込む」とメモは使えます', 'Recording paused. Add and memos still work') : T('記録を再開しました', 'Recording resumed'));
    }, toast);
  }

  /* ---------- 検索 ---------- */

  function openSearch() {
    searchOpen = true;
    searchInputEl.value = searchQuery;
    render();
    try { searchInputEl.focus(); } catch (e) {}
  }

  /* 閉じたら全部に戻す。フォーカスは🔍へ */
  function closeSearch() {
    var hadFocus = false;
    try { hadFocus = !!shadow.activeElement; } catch (e) {}
    searchOpen = false;
    searchQuery = '';
    searchComposing = false;
    searchInputEl.value = '';
    render();
    if (hadFocus) { try { btnSearchEl.focus(); } catch (e2) {} }
  }

  function setSearchQuery(q) {
    if (q === searchQuery) return;
    searchQuery = q;
    render();
  }

  function isTextEntry(t) {
    if (!t || !t.tagName) return false;
    var tag = String(t.tagName).toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || !!t.isContentEditable;
  }

  /* ---------- 消す・元に戻す ---------- */

  /* 消せたら「削除しました」と「元に戻す」を6秒ほど出す。戻すときに使う中身はここで写しておく */
  function deleteItem(kind, item) {
    var list = kind === 'memo' ? data.memos : data.clips;
    var latest = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === item.id) latest = list[i];
    var snapshot = Object.assign({}, latest || item);
    if (speakingId === item.id) stopSpeaking(true);
    saveOp({ op: 'remove', kind: kind, id: item.id }).then(function () {
      var u = { kind: kind, item: snapshot };
      toast(T('削除しました', 'Deleted'), {
        label: T('元に戻す', 'Undo'),
        title: T('元に戻す（Ctrl+Z でも戻せます）', 'Undo (Ctrl+Z also works)'),
        ms: UNDO_MS,
        onClick: doUndo,
        onHide: function () { if (undoPending === u) undoPending = null; }
      });
      undoPending = u;
    }, toast);
  }

  /* 同じ id・文字・色・ピン・ts・pos で戻す(background の直列キューの restore)。
     戻したカードの🗑️へフォーカスを置く(キーボードで押した人が迷わないように) */
  function doUndo() {
    var u = undoPending;
    if (!u) return;
    undoPending = null;
    hideToast();
    saveOp({ op: 'restore', kind: u.kind, item: u.item }).then(function () {
      var key = u.kind === 'memo' ? 'memos' : 'clips';
      data[key] = L.restoreItem(data[key], u.item, u.kind === 'memo' ? 'yellow' : 'white', Date.now());
      if (visible) {
        focusAfterRender = { key: u.item.id, act: 'del' };
        render();
      }
      toast(T('元に戻しました', 'Restored'));
    }, toast);
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
      toast(T('書き出しました', 'Exported'));
      markBackedUp();
    } catch (e) {
      toast(T('書き出せませんでした', 'Could not export'));
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
      toast(T('ファイルが大きすぎます', 'The file is too large'));
      fileInputEl.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var parsed = null;
      try {
        parsed = L.parseBackup(String(reader.result), Date.now());
      } catch (e) {
        toast(trErr(String((e && e.message) || 'このファイルは読み込めません')));
        fileInputEl.value = '';
        return;
      }
      fileInputEl.value = '';
      saveOp({ op: 'importItems', clips: parsed.clips, memos: parsed.memos }).then(function (res) {
        var a = (res && res.addedClips) || 0;
        var b = (res && res.addedMemos) || 0;
        var d = (res && res.dropped) || 0;
        var msg = a + b === 0
          ? T('新しく増えるものはありませんでした', 'Nothing new to add')
          : T('読み込みました（履歴' + a + '件・メモ' + b + '件）', 'Imported (history ' + a + ', memos ' + b + ')');
        if (d > 0) msg += T('。上限のため古い' + d + '件を整理しました', '. ' + d + ' older item(s) were removed because of the limit');
        toast(msg);
      }, toast);
    };
    reader.onerror = function () {
      toast(T('ファイルを開けませんでした', 'Could not open the file'));
      fileInputEl.value = '';
    };
    reader.readAsText(f);
  }

  /* ---------- データ読み込み・監視 ---------- */
  function loadData(cb) {
    try {
      chrome.storage.local.get({ clips: [], memos: [], panelState: null, recordingPaused: false, uiLang: null,
        fontSize: 'm', lastBackupAt: null, backupBaselineAt: null, backupSnoozeUntil: null, a2hsSeen: false, templates: null }, function (res) {
        if (validLang(res.uiLang)) applyLang(res.uiLang);
        applyFontSize(res.fontSize);
        backupInfo.lastBackupAt = numOrNull(res.lastBackupAt);
        backupInfo.baselineAt = numOrNull(res.backupBaselineAt);
        backupInfo.snoozeUntil = numOrNull(res.backupSnoozeUntil);
        /* 使い始めの日を一度だけ覚える(書き出したことが無い人の「30日」はここから数える) */
        if (backupInfo.lastBackupAt === null && backupInfo.baselineAt === null) {
          backupInfo.baselineAt = Date.now();
          saveLocalQuiet({ backupBaselineAt: backupInfo.baselineAt });
        }
        a2hsSeen = res.a2hsSeen === true;
        templates = L.sanitizeTemplates(res.templates);
        data.clips = res.clips || [];
        data.memos = res.memos || [];
        if (!IS_WEB_APP) recordingPaused = !!res.recordingPaused;
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

  /* 一時停止は全部のフレームで追う。一覧の中身はパネルのあるトップフレームだけ */
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      var dirty = false;
      if (changes.recordingPaused && !IS_WEB_APP) {
        recordingPaused = !!changes.recordingPaused.newValue;
        dirty = true;
      }
      if (IS_TOP) {
        /* 別のタブや小窓で言語を切り替えたら、こちらも合わせる */
        if (changes.uiLang) applyLang(changes.uiLang.newValue);
        if (changes.fontSize) applyFontSize(changes.fontSize.newValue);
        if (changes.lastBackupAt) { backupInfo.lastBackupAt = numOrNull(changes.lastBackupAt.newValue); dirty = true; }
        if (changes.backupBaselineAt) { backupInfo.baselineAt = numOrNull(changes.backupBaselineAt.newValue); dirty = true; }
        if (changes.backupSnoozeUntil) { backupInfo.snoozeUntil = numOrNull(changes.backupSnoozeUntil.newValue); dirty = true; }
        if (changes.a2hsSeen) { a2hsSeen = changes.a2hsSeen.newValue === true; dirty = true; }
        if (changes.templates) { templates = L.sanitizeTemplates(changes.templates.newValue); dirty = true; }
        if (changes.clips) { data.clips = changes.clips.newValue || []; dirty = true; }
        if (changes.memos) { data.memos = changes.memos.newValue || []; dirty = true; }
      }
      if (dirty && visible) scheduleRender();
    });
  } catch (e) {}

  function scheduleRender() {
    if (editingId || composerOpen || reorderDragging || tplEdit) { pendingRender = true; return; }
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
    /* ページの言語に関係なく、画面の言葉の言語で読み上げられるように */
    panelEl.setAttribute('lang', LANG);
    panelEl.setAttribute('aria-label', T('便利クリップメモ・そよぎ', 'Handy Clip Memo - Soyogi'));
    if (IS_PAGE_MODE) { try { document.title = T('便利クリップメモ・そよぎ', 'Handy Clip Memo - Soyogi'); document.documentElement.setAttribute('lang', LANG); } catch (e) {} }
    panelEl.setAttribute('role', IS_PAGE_MODE ? 'main' : 'dialog');
    /* アイコンで開いたとき、ここにフォーカスを置く(Tabで中のボタンへ進める) */
    panelEl.setAttribute('tabindex', '-1');
    panelEl.innerHTML = [
      '<div class="hdr" id="hdr">',
      '  <span class="logo" aria-hidden="true">📋</span>',
      '  <span class="ttl">' + T('便利クリップメモ・そよぎ', 'Handy Clip Memo - Soyogi') + '</span>',
      '  <span class="hdr-actions">',
      '    <button class="iconbtn" id="btn-search" title="' + T('さがす（いま見ている一覧を文字でしぼりこむ）', 'Search (filter the current list by text)') + '" aria-label="' + T('さがす（いま見ている一覧を文字でしぼりこむ）', 'Search (filter the current list by text)') + '" aria-expanded="false" aria-controls="searchbar">🔍</button>',
      '    <button class="iconbtn langbtn" id="btn-lang" lang="' + T('en', 'ja') + '" title="' + T('Switch to English', '日本語にする') + '" aria-label="' + T('Switch to English', '日本語にする') + '">' + T('EN', '日本語') + '</button>',
      '    <button class="iconbtn" id="btn-pause" title="' + T('コピーの自動記録を一時停止', 'Pause automatic recording of copies') + '" aria-label="' + T('コピーの自動記録を一時停止', 'Pause automatic recording of copies') + '" aria-pressed="false">⏸</button>',
      '    <button class="iconbtn win" id="btn-window" title="' + T('小窓で開く（ブラウザとは別の小さな窓にする）', 'Open in a small window (separate from the browser)') + '" aria-label="' + T('小窓で開く（ブラウザとは別の小さな窓にする）', 'Open in a small window (separate from the browser)') + '">🪟</button>',
      '    <button class="iconbtn bak" id="btn-export" title="' + T('書き出し（今の中身をファイルに保存）', 'Export (save everything to a file)') + '" aria-label="' + T('書き出し（今の中身をファイルに保存）', 'Export (save everything to a file)') + '">💾</button>',
      '    <button class="iconbtn bak" id="btn-import-file" title="' + T('読み込み（保存したファイルの中身を、今のものに足す）', 'Import (add the contents of a saved file)') + '" aria-label="' + T('読み込み（保存したファイルの中身を、今のものに足す）', 'Import (add the contents of a saved file)') + '">📂</button>',
      '    <button class="iconbtn" id="btn-close" title="' + T('しまう(拡張機能アイコンで再表示)', 'Hide (click the extension icon to show again)') + '" aria-label="' + T('しまう(拡張機能アイコンで再表示)', 'Hide (click the extension icon to show again)') + '">✕</button>',
      '  </span>',
      '</div>',
      '<div class="pausebar" id="pausebar">',
      '  <span class="pausebar-txt">⏸ ' + T('記録を止めています（ページでコピーしても残りません）', 'Recording is paused (copies on pages are not saved)') + '</span>',
      '  <button class="pausebar-btn" id="btn-resume">' + T('再開する', 'Resume') + '</button>',
      '</div>',
      '<div class="notice" id="notice-backup" role="region" aria-label="' + T('書き出しのお願い', 'Backup reminder') + '">',
      '  <span class="notice-txt">💾 ' + T('メモをファイルに書き出しておきませんか？\nデータはこの端末の中だけにあるので、ブラウザのデータを消したり端末が壊れたりすると戻せません。', 'Would you like to export your memos to a file?\nYour data is only on this device, so it cannot be restored if browser data is cleared or the device breaks.') + '</span>',
      '  <span class="notice-btns">',
      '    <button class="notice-btn" id="btn-backup-now">' + T('書き出す', 'Export') + '</button>',
      '    <button class="notice-btn" id="btn-backup-later">' + T('あとで', 'Later') + '</button>',
      '  </span>',
      '</div>',
      '<div class="notice" id="notice-a2hs" role="region" aria-label="' + T('ホーム画面に追加のご案内', 'Add to Home Screen') + '">',
      '  <span class="notice-txt">' + T('ホーム画面に追加すると、アプリのようにすぐ開けます。\n共有ボタンから「ホーム画面に追加」を選んでください。\nホーム画面から開く版は、Safariのタブとは保存場所が別です。先に追加してから使い始めると安心です。', 'Add this app to your Home Screen to open it like an app.\nTap the Share button and choose "Add to Home Screen".\nThe Home Screen version stores its data separately from Safari tabs, so it is best to add it before you start writing memos.') + '</span>',
      '  <span class="notice-btns">',
      '    <button class="notice-btn" id="btn-a2hs-ok">' + T('わかった', 'Got it') + '</button>',
      '  </span>',
      '</div>',
      '<input type="file" id="file-input" accept="application/json,.json" style="display:none">',
      '<div class="tabs" role="tablist" aria-label="' + T('表示する一覧', 'List to show') + '">',
      '  <button class="tab" id="tab-clips" role="tab" aria-controls="list"></button>',
      '  <button class="tab" id="tab-memos" role="tab" aria-controls="list"></button>',
      '</div>',
      '<div class="toolbar">',
      '  <button class="btn" id="btn-import">',
      '    <span class="lbl-full">📥 ' + T('いまのクリップボードを取り込む', 'Add from clipboard') + '</span>',
      '    <span class="lbl-min">📥 ' + T('取り込む', 'Add') + '</span>',
      '  </button>',
      '  <button class="btn" id="btn-newmemo">',
      '    <span class="lbl-full">＋ ' + T('新しいメモ', 'New memo') + '</span>',
      '    <span class="lbl-min">＋ ' + T('メモ', 'Memo') + '</span>',
      '  </button>',
      '  <button class="btn sub tplbtn" id="btn-tpl" aria-expanded="false" title="' + T('ひな形から新しいメモを作る（住所・あいさつ文など）', 'Add a memo from a template (address, greeting, etc.)') + '">',
      '    <span class="lbl-full">📝 ' + T('ひな形', 'Templates') + '</span>',
      '    <span class="lbl-min">📝 ' + T('ひな形', 'Templates') + '</span>',
      '  </button>',
      '  <select class="sortbox" id="sortbox" aria-label="' + T('並べ替え', 'Sort') + '" title="' + T('並べ替え（「自分の並び」以外では、ピン止めが一番上に来ます）', 'Sort (pinned items come first, except in My order)') + '"></select>',
      '  <button class="fontbtn" id="btn-font">' + T('Aあ', 'Aa') + '</button>',
      '</div>',
      '<div class="searchbar" id="searchbar" role="search">',
      '  <input type="text" id="search-input" placeholder="' + T('さがす文字', 'Search text') + '" autocomplete="off" enterkeyhint="search" aria-label="' + T('さがす文字（いま見ている一覧をしぼりこむ）', 'Search text (filter the current list)') + '">',
      '  <span class="count" id="search-count" aria-live="polite"></span>',
      '  <button class="iconbtn" id="btn-search-close" title="' + T('さがすのをやめる（Esc）', 'Close search (Esc)') + '" aria-label="' + T('さがすのをやめる（Esc）', 'Close search (Esc)') + '">✕</button>',
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
    btnSearchEl = shadow.getElementById('btn-search');
    searchBarEl = shadow.getElementById('searchbar');
    searchInputEl = shadow.getElementById('search-input');
    searchCountEl = shadow.getElementById('search-count');
    btnPauseEl = shadow.getElementById('btn-pause');
    pauseBarEl = shadow.getElementById('pausebar');
    noticeBackupEl = shadow.getElementById('notice-backup');
    noticeA2hsEl = shadow.getElementById('notice-a2hs');
    btnTplEl = shadow.getElementById('btn-tpl');
    btnFontEl = shadow.getElementById('btn-font');
    btnFontEl.addEventListener('click', cycleFontSize);
    btnTplEl.addEventListener('click', toggleTemplates);
    shadow.getElementById('btn-backup-now').addEventListener('click', doExport);
    shadow.getElementById('btn-backup-later').addEventListener('click', snoozeBackup);
    shadow.getElementById('btn-a2hs-ok').addEventListener('click', dismissA2hs);
    applyFontSize(fontSize);

    L.SORT_MODES.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = nm(m);
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

    /* 記録の一時停止(Web版はコピーの自動記録が無いので出さない) */
    if (IS_WEB_APP) {
      btnPauseEl.style.display = 'none';
    } else {
      btnPauseEl.addEventListener('click', togglePaused);
      shadow.getElementById('btn-resume').addEventListener('click', togglePaused);
    }

    /* 検索。🔴 入力欄は作り直さない。変換中は絞り込まず、確定してから絞り込む */
    btnSearchEl.addEventListener('click', function () {
      if (searchOpen) closeSearch(); else openSearch();
    });
    shadow.getElementById('btn-search-close').addEventListener('click', closeSearch);
    shadow.getElementById('btn-lang').addEventListener('click', toggleLang);
    searchInputEl.addEventListener('compositionstart', function () { searchComposing = true; });
    searchInputEl.addEventListener('compositionend', function () {
      searchComposing = false;
      setSearchQuery(searchInputEl.value);
    });
    searchInputEl.addEventListener('input', function (e) {
      if ((e && e.isComposing) || searchComposing) return;
      setSearchQuery(searchInputEl.value);
    });

    /* 「元に戻す」のトーストは、マウスかフォーカスが乗っている間は消さない */
    var toastHover = false, toastFocus = false;
    toastEl.addEventListener('mouseenter', function () { toastHover = true; holdToast(); });
    toastEl.addEventListener('mouseleave', function () { toastHover = false; if (!toastFocus) releaseToast(); });
    toastEl.addEventListener('focusin', function () { toastFocus = true; holdToast(); });
    toastEl.addEventListener('focusout', function () { toastFocus = false; if (!toastHover) releaseToast(); });

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
       🔴 日本語の変換中のEscは「変換の取り消し」なので閉じない。
       検索を開いているときのEscは、まず検索を閉じて全部に戻す(もう一度でパネルを閉じる) */
    panelEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (e.isComposing || e.keyCode === 229) return;
        if (searchOpen) {
          if (e.preventDefault) e.preventDefault();
          closeSearch();
          return;
        }
        if (!IS_PAGE_MODE) hidePanel();
        return;
      }
      /* Ctrl+Z(MacはCommand+Z)で、さっき消した項目を戻す(「元に戻す」が出ている間だけ)。
         文字の入力欄の中では、文字の取り消しを優先する */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')
          && undoPending && !isTextEntry(e.target)) {
        if (e.preventDefault) e.preventDefault();
        doUndo();
      }
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
      /* 言語の切り替えでパネルを作り直しても、窓の見張りは1回だけ付ける */
      if (!winListenersOn) {
        winListenersOn = true;
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
  }
  var winListenersOn = false;

  /* ---------- 言語の切り替え ---------- */
  /* 選んだ言語は storage の uiLang に置く(全部のタブ・小窓・次に開いたときに効く) */
  function toggleLang() {
    var next = LANG === 'ja' ? 'en' : 'ja';
    applyLang(next, true);
    try {
      var p = chrome.storage.local.set({ uiLang: next });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  /* 画面の文字は作るときに入れているので、パネルを作り直して入れ替える。
     中身・タブ・並べ替え・検索の文字・位置と大きさ・編集中の下書きはそのまま */
  function applyLang(next, fromButton) {
    next = validLang(next) || LANG_AUTO;
    if (next === LANG) return;
    LANG = next;
    SAVE_FAIL_MSG = T('保存できませんでした。ページを再読み込みしてください', 'Could not save. Please reload the page');
    if (IS_PAGE_MODE) {
      try { document.title = T('便利クリップメモ・そよぎ', 'Handy Clip Memo - Soyogi'); document.documentElement.setAttribute('lang', LANG); } catch (e) {}
    }
    if (!panelEl) return;
    var keep = {
      left: panelEl.style.left, top: panelEl.style.top, right: panelEl.style.right,
      width: panelEl.style.width, height: panelEl.style.height
    };
    var wasVisible = visible;
    stopSpeaking(true);
    clearTimeout(toastTimer);
    if (toastOnHide) { var f = toastOnHide; toastOnHide = null; try { f(); } catch (e) {} }
    try { if (host) host.remove(); } catch (e) {}
    host = shadow = panelEl = null;
    buildPanel();
    Object.keys(keep).forEach(function (k) { if (keep[k]) panelEl.style[k] = keep[k]; });
    if (searchOpen) searchInputEl.value = searchQuery;
    if (wasVisible) {
      visible = true;
      host.style.display = 'block';
      render();
      if (fromButton) {
        try { shadow.getElementById('btn-lang').focus({ preventScroll: true }); } catch (e) {}
        toast(T('日本語にしました', 'Switched to English'));
      }
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
    stopSpeaking(true);
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

    setTabLabel(tabClipsEl, T('コピー履歴 ', 'Copy history ') + data.clips.length + '/' + L.MAX_ITEMS,
      T('履歴 ', 'History ') + data.clips.length);
    setTabLabel(tabMemosEl, T('メモ ', 'Memos ') + data.memos.length + '/' + L.MAX_ITEMS,
      T('メモ ', 'Memos ') + data.memos.length);
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
    btnTplEl.style.display = currentTab === 'memos' ? '' : 'none';
    btnTplEl.setAttribute('aria-expanded', templatesOpen && currentTab === 'memos' ? 'true' : 'false');
    btnTplEl.classList.toggle('on', templatesOpen && currentTab === 'memos');
    sortBoxEl.value = sortMode[currentTab];
    renderNotices();

    /* 記録の一時停止の帯とボタン */
    var showPaused = recordingPaused && !IS_WEB_APP;
    pauseBarEl.classList.toggle('on', showPaused);
    btnPauseEl.classList.toggle('on', showPaused);
    btnPauseEl.setAttribute('aria-pressed', showPaused ? 'true' : 'false');

    /* 検索の欄。🔴 入力欄の value にはここで触らない(変換中の文字を壊さないため) */
    searchBarEl.classList.toggle('open', searchOpen);
    btnSearchEl.classList.toggle('on', searchOpen);
    btnSearchEl.setAttribute('aria-expanded', searchOpen ? 'true' : 'false');

    listEl.textContent = '';
    var kind = currentTab === 'clips' ? 'clip' : 'memo';
    var all = currentTab === 'clips' ? data.clips : data.memos;
    filtering = searchOpen && L.normalizeForSearch(searchQuery).trim() !== '';
    var matched = filtering ? L.filterItems(all, searchQuery) : all;
    var shown = matched;
    /* 編集中の項目は、しぼりこみから外れても出し続ける(下書きを守る) */
    if (filtering && editingId !== null && kind === editKind
        && !matched.some(function (it) { return it.id === editingId; })) {
      shown = matched.concat(all.filter(function (it) { return it.id === editingId; }));
    }
    var items = L.sortForDisplay(shown, sortMode[currentTab]);
    if (searchOpen) {
      searchCountEl.textContent = T(all.length + '件中' + matched.length + '件', matched.length + ' of ' + all.length)
        + (filtering && sortMode[currentTab] === 'manual' ? T('（しぼりこみ中は並べ替えできません）', ' (cannot reorder while searching)') : '');
    }

    var showComposer = composerOpen && kind === 'memo';
    var editOnThisTab = editingId !== null && kind === editKind;
    var editTargetExists = editOnThisTab && items.some(function (it) { return it.id === editingId; });
    /* 編集中に元の項目が他所で消えても、下書きを守るため編集カードだけは出し続ける */
    var showOrphanEdit = editOnThisTab && !editTargetExists;

    if (currentTab === 'memos' && templatesOpen) listEl.appendChild(buildTemplateBox());
    if (showComposer) listEl.appendChild(buildComposer());
    if (showOrphanEdit) listEl.appendChild(buildEditCard(null, kind));

    if (!items.length && !showComposer && !showOrphanEdit) {
      var em = el('div', 'empty');
      if (filtering) {
        em.textContent = T('「' + searchQuery.trim() + '」は見つかりませんでした', 'No results for "' + searchQuery.trim() + '"');
      } else {
        em.textContent = currentTab === 'clips'
          ? T('ページで文字をコピーすると、ここに残っていきます。\n「取り込む」ボタンで今のクリップボードも追加できます。', 'Text you copy on web pages is saved here.\nUse the Add button to add what is on the clipboard now.')
          : T('「＋ 新しいメモ」から自由にメモを残せます。', 'Use "+ New memo" to write memos freely.');
      }
      listEl.appendChild(em);
    }

    for (var i = 0; i < items.length; i++) {
      if (editOnThisTab && items[i].id === editingId) {
        listEl.appendChild(buildEditCard(items[i], kind));
      } else {
        listEl.appendChild(buildCard(items[i], kind));
      }
    }
    /* 元に戻したカードへは1回だけフォーカスを置く。それ以外は作り直す前の場所へ戻す */
    var fa = focusAfterRender;
    focusAfterRender = null;
    if (fa) {
      for (var k = 0; k < listEl.children.length; k++) {
        var fc = listEl.children[k];
        if (fc.dataset && fc.dataset.fkey === fa.key) {
          var ft = findAct(fc, fa.act) || findAct(fc, null);
          if (ft) { try { ft.focus(); } catch (e) {} }
          return;
        }
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
    ta.placeholder = T('メモを入力…', 'Write a memo…');
    ta.setAttribute('aria-label', T('新しいメモ', 'New memo'));
    ta.dataset.act = 'new-text';
    ta.addEventListener('input', function () { composerDraft = ta.value; });
    var row = el('div', 'editrow');
    var cancel = textBtn(T('キャンセル', 'Cancel'), function () {
      composerOpen = false;
      composerDraft = '';
      render();
    }, 'sub', 'new-cancel');
    /* 🔴 下書きは「保存できた」と返事が来てから消す。失敗したら残したまま知らせる */
    var save = textBtn(T('保存', 'Save'), function () {
      if (composerSaving) return;
      var v = ta.value;
      composerDraft = v;
      if (!v.trim()) { toast(T('文字を入力してください', 'Please enter some text')); return; }
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
    txt.textContent = item.text || (kind === 'memo' ? T('(空のメモ)', '(empty memo)') : T('(空)', '(empty)'));
    if (!item.text) txt.style.opacity = '.55';
    txt.title = T('クリックで全文表示/折りたたみ', 'Click to show all / fold');
    txt.addEventListener('click', function () { txt.classList.toggle('clamp'); });
    card.appendChild(txt);

    var meta = el('div', 'meta');
    /* しぼりこみ中は取っ手を出さない(並べ替えの位置があいまいになるため) */
    if (sortMode[currentTab] === 'manual' && !filtering) {
      var grip = el('button', 'grip');
      grip.textContent = '⋮⋮';
      grip.title = T('ここを掴んで上下に動かすと順番を変えられます。Alt+上下の矢印キーでも動かせます', 'Drag this up or down to change the order. Alt + Up/Down arrow keys also work');
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
    var pin = iconBtn('📌', item.pinned ? T('ピン止めを外す', 'Unpin')
      : T('ピン止め（自動で消えません。「自分の並び」以外では一番上に出ます）', 'Pin (never removed automatically; shown first except in My order)'), function () {
      sendOp({ op: 'togglePin', kind: kind, id: item.id });
    }, item.pinned, 'pin');
    pin.setAttribute('aria-pressed', item.pinned ? 'true' : 'false');
    meta.appendChild(pin);

    meta.appendChild(iconBtn('📋', T('クリップボードにコピー', 'Copy to clipboard'), function () {
      copyText(item.text);
    }, false, 'copy'));

    /* 声で読み上げ(端末に声が入っているブラウザだけ出す)。もう一度押すと止まる */
    if (ttsSupported()) {
      var speaking = speakingId === item.id;
      var sp = iconBtn(speaking ? '⏹' : '🔊',
        T('声で読み上げる（もう一度押すと止まります）', 'Read aloud (press again to stop)'), function () {
          toggleSpeak(item);
        }, speaking, 'speak');
      sp.setAttribute('aria-pressed', speaking ? 'true' : 'false');
      meta.appendChild(sp);
    }

    meta.appendChild(iconBtn('✏️', T('編集', 'Edit'), function () {
      startEdit(item, kind);
    }, false, 'edit'));

    var colorBtn = iconBtn('🎨', T('色を変える', 'Change color'), function () {
      paletteOpenId = paletteOpenId === item.id ? null : item.id;
      render();
    }, false, 'color');
    colorBtn.setAttribute('aria-expanded', paletteOpenId === item.id ? 'true' : 'false');
    meta.appendChild(colorBtn);

    var del;
    if (confirmDeleteId === item.id) {
      del = el('button', 'iconbtn danger');
      del.textContent = T('削除する', 'Confirm delete');
      del.dataset.act = 'del';
      del.addEventListener('click', function () {
        /* 🔴 🗑️のダブルクリックの2打目がここに当たって素通りしないよう、切り替わって直後は無視 */
        if (Date.now() - confirmDeleteAt < CONFIRM_GUARD_MS) return;
        confirmDeleteId = null;
        clearTimeout(confirmDeleteTimer);
        deleteItem(kind, item);
      });
    } else {
      del = iconBtn('🗑️', T('削除', 'Delete'), function () {
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
      s.title = nm(c);
      s.setAttribute('aria-label', nm(c));
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
      s.textContent = T('あ', 'A');
      s.style.color = t.hex;
      s.style.background = t.id === 'white' ? '#8a8a8a' : '#f2f2f2';
      s.title = T('文字色: ', 'Text color: ') + nm(t);
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
    if (editingId) { toast(T('別の項目を編集中です', 'Another item is being edited')); return; }
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
    ta.setAttribute('aria-label', T('編集中の文', 'Text being edited'));
    ta.dataset.act = 'edit-text';
    ta.addEventListener('input', function () { editDraft = ta.value; });
    var row = el('div', 'editrow');
    var cancel = textBtn(T('キャンセル', 'Cancel'), function () {
      clearEditState();
      render();
    }, 'sub', 'edit-cancel');
    /* 🔴 編集状態(下書き)は「保存できた」と返事が来てから閉じる。失敗したら残したまま知らせる */
    var save = textBtn(T('保存', 'Save'), function () {
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
        if (!stillThere) toast(T('元の項目が消えていたため、新しく保存しました', 'The original item was gone, so it was saved as new'));
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

  /* ページを離れるときは読み上げを止める(声だけ残らないように) */
  if (IS_TOP) {
    try { window.addEventListener('pagehide', function () { stopSpeaking(true); }); } catch (e) {}
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
