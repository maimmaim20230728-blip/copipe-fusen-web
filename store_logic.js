'use strict';
/* 便利クリップメモ・そよぎ 共通ロジック
   content script / background / Node(スモークテスト) の3か所から同じものを使う。
   ここには chrome API を一切書かない(純粋関数のみ)。 */
(function (root) {

  var MAX_ITEMS = 50;      // クリップ履歴・メモ それぞれの上限
  var MAX_TEXT = 10000;    // 1件あたりの文字数上限

  /* 付箋の背景12色(わかりやすいパステル) */
  var COLORS = [
    { id: 'yellow', hex: '#FFF176', name: '黄', en: 'Yellow' },
    { id: 'orange', hex: '#FFB74D', name: 'オレンジ', en: 'Orange' },
    { id: 'pink',   hex: '#F48FB1', name: 'ピンク', en: 'Pink' },
    { id: 'red',    hex: '#EF9A9A', name: '赤', en: 'Red' },
    { id: 'purple', hex: '#CE93D8', name: '紫', en: 'Purple' },
    { id: 'blue',   hex: '#90CAF9', name: '青', en: 'Blue' },
    { id: 'cyan',   hex: '#80DEEA', name: '水色', en: 'Light blue' },
    { id: 'green',  hex: '#A5D6A7', name: '緑', en: 'Green' },
    { id: 'lime',   hex: '#DCE775', name: '黄緑', en: 'Yellow green' },
    { id: 'brown',  hex: '#BCAAA4', name: '茶', en: 'Brown' },
    { id: 'gray',   hex: '#CFD8DC', name: 'グレー', en: 'Gray' },
    { id: 'white',  hex: '#FFFFFF', name: '白', en: 'White' }
  ];

  /* 文字色は4色のみ */
  var TEXT_COLORS = [
    { id: 'black',    hex: '#1B1B1B', name: '黒', en: 'Black' },
    { id: 'darkgray', hex: '#555555', name: '濃いグレー', en: 'Dark gray' },
    { id: 'red',      hex: '#D32F2F', name: '赤', en: 'Red' },
    { id: 'white',    hex: '#FFFFFF', name: '白', en: 'White' }
  ];

  var seq = 0;
  function makeId(now) {
    seq = (seq + 1) % 10000;
    return String(now) + '-' + String(seq);
  }

  function clampText(text) {
    var t = String(text == null ? '' : text);
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
  }

  function makeItem(text, opts, now) {
    opts = opts || {};
    return {
      id: makeId(now),
      text: clampText(text),
      color: opts.color || 'white',
      textColor: opts.textColor || 'black',
      pinned: false,
      ts: now
    };
  }

  /* 上限を超えたら「ピン止めしていない中で一番古いもの」から消す。
     全部ピン止めなら消さない(ピンは絶対に守る)。
     protectId を渡すとその1件は消さない(追加したばかりの項目が
     「ピン無しの最古」に該当して即消えるのを防ぐ)。 */
  function prune(list, protectId) {
    var out = list.slice();
    while (out.length > MAX_ITEMS) {
      var idx = -1, oldest = Infinity;
      for (var i = 0; i < out.length; i++) {
        if (out[i].pinned || out[i].id === protectId) continue;
        if (out[i].ts < oldest) { oldest = out[i].ts; idx = i; }
      }
      if (idx < 0) break;
      out.splice(idx, 1);
    }
    return out;
  }

  /* コピー履歴に追加。同じ文字が既にあれば増やさず、その1件を先頭扱い(ts更新)にする。 */
  function addClip(list, text, now) {
    var t = clampText(text);
    if (!t || !t.trim()) return list;
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === t) {
        var out = list.slice();
        out[i] = Object.assign({}, out[i], { ts: now });
        return out;
      }
    }
    var item = makeItem(t, { color: 'white' }, now);
    return prune([item].concat(list), item.id);
  }

  function addMemo(list, text, opts, now) {
    var item = makeItem(text == null ? '' : text,
      Object.assign({ color: 'yellow' }, opts || {}), now);
    return prune([item].concat(list), item.id);
  }

  /* touchTs=true のとき更新日時も動かす(=一覧の上に上がる)。色変更などは false。 */
  function updateItem(list, id, patch, touchTs, now) {
    return list.map(function (it) {
      if (it.id !== id) return it;
      var next = Object.assign({}, it, patch);
      if (touchTs) next.ts = now;
      return next;
    });
  }

  function removeItem(list, id) {
    return list.filter(function (it) { return it.id !== id; });
  }

  /* 消した項目を「元に戻す」。id・文字・色・ピン・ts・pos はそのまま戻す。
     🔴 戻した結果が50件を超えたら、戻した項目は protectId で守る
        (ほかのピン止めしていない古いものが整理されるのは今のルールどおり)。
     同じidがもうあれば何もしない(二度押し・別のタブで先に戻した場合) */
  function restoreItem(list, raw, fallbackColor, now) {
    var cur = Array.isArray(list) ? list : [];
    var it = sanitizeItem(raw, fallbackColor || 'white', now);
    if (!it) return cur;
    for (var i = 0; i < cur.length; i++) {
      if (cur[i].id === it.id) return cur;
    }
    return prune([it].concat(cur), it.id);
  }

  /* ---- 検索 ---- */

  /* 検索用に文字をそろえる。全角の英数字は半角に(NFKC)、大文字は小文字に */
  function normalizeForSearch(s) {
    var t = String(s == null ? '' : s);
    try { t = t.normalize('NFKC'); } catch (e) {}
    return t.toLowerCase();
  }

  /* 打った文字を含む項目だけにしぼる(空白だけなら全部) */
  function filterItems(list, query) {
    var q = normalizeForSearch(query).trim();
    var src = Array.isArray(list) ? list : [];
    if (!q) return src.slice();
    return src.filter(function (it) {
      return normalizeForSearch(it && it.text).indexOf(q) >= 0;
    });
  }

  /* 並べ替えの種類。🔴どれを選んでもピン止めは必ず最上段(ピン優先はアプリの芯) */
  var SORT_MODES = [
    { id: 'new', name: '新しい順', en: 'Newest first' },
    { id: 'old', name: '古い順', en: 'Oldest first' },
    { id: 'text', name: 'あいうえお順', en: 'A to Z' },
    { id: 'color', name: '色ごと', en: 'By color' },
    /* 🔴 これだけはピン止めを最上段に強制しない。
          利用者が自分で並べた通りに出さないと、掴んで動かしても戻ってしまうため。
          ピン止めは「自動で消えない」という意味は保ったまま */
    { id: 'manual', name: '自分の並び', en: 'My order' }
  ];

  function isSortMode(id) {
    for (var i = 0; i < SORT_MODES.length; i++) if (SORT_MODES[i].id === id) return true;
    return false;
  }

  var COLOR_RANK = (function () {
    var r = {};
    for (var i = 0; i < COLORS.length; i++) r[COLORS[i].id] = i;
    return r;
  })();

  /* 表示順: ピン止めが上。その中の並びを mode で選ぶ(既定は新しい順) */
  /* 並べ替えていない項目は先頭(新着がいちばん上に出るように) */
  function posOf(it) {
    var n = Number(it && it.pos);
    return isFinite(n) ? n : -1;
  }

  /* 掴んで並べ替えた順番を記録する。ここで各項目に pos を振る
     🔴 rank は Object.create(null)。{} だと id が "constructor" などのとき
        Object.prototype の中身を拾って順番が壊れる */
  function applyManualOrder(list, orderedIds) {
    var rank = Object.create(null);
    (Array.isArray(orderedIds) ? orderedIds : []).forEach(function (id, i) { rank[id] = i; });
    return list.map(function (it) {
      if (rank[it.id] == null) return it;
      return Object.assign({}, it, { pos: rank[it.id] });
    });
  }

  function sortForDisplay(list, mode) {
    var m = isSortMode(mode) ? mode : 'new';
    if (m === 'manual') {
      return list.slice().sort(function (a, b) {
        var pa = posOf(a), pb = posOf(b);
        if (pa !== pb) return pa - pb;
        return b.ts - a.ts;
      });
    }
    return list.slice().sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (m === 'old') return a.ts - b.ts;
      if (m === 'text') {
        var r = String(a.text).localeCompare(String(b.text), 'ja');
        if (r !== 0) return r;
        return b.ts - a.ts;
      }
      if (m === 'color') {
        var ra = COLOR_RANK[a.color], rb = COLOR_RANK[b.color];
        if (ra == null) ra = COLORS.length;
        if (rb == null) rb = COLORS.length;
        if (ra !== rb) return ra - rb;
        return b.ts - a.ts;
      }
      return b.ts - a.ts;
    });
  }

  /* ---- バックアップ(書き出し・読み込み) ---- */

  var BACKUP_APP = 'benri-clip-memo';
  var BACKUP_FORMAT = 1;

  function isColorId(id) {
    for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return true;
    return false;
  }
  function isTextColorId(id) {
    for (var i = 0; i < TEXT_COLORS.length; i++) if (TEXT_COLORS[i].id === id) return true;
    return false;
  }

  /* 外から来たデータは信用しない。1件ずつ形を整え、壊れていればnullを返す */
  function sanitizeItem(raw, fallbackColor, now) {
    if (!raw || typeof raw !== 'object') return null;
    var text = clampText(raw.text == null ? '' : raw.text);
    var ts = Number(raw.ts);
    if (!isFinite(ts)) ts = now;
    var out = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id.slice(0, 64) : makeId(now),
      text: text,
      color: isColorId(raw.color) ? raw.color : fallbackColor,
      textColor: isTextColorId(raw.textColor) ? raw.textColor : 'black',
      pinned: !!raw.pinned,
      ts: ts
    };
    /* 自分で並べ替えた順番も引き継ぐ(バックアップから戻したとき並びが崩れないように) */
    var pos = Number(raw.pos);
    if (isFinite(pos)) out.pos = pos;
    return out;
  }

  function buildBackup(clips, memos, exportedAt) {
    return {
      app: BACKUP_APP,
      format: BACKUP_FORMAT,
      exportedAt: exportedAt,
      clips: clips || [],
      memos: memos || []
    };
  }

  /* 読み込んだ文字列をバックアップとして解釈する。だめなら例外を投げる */
  function parseBackup(text, now) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('ファイルの形式が違います'); }
    if (!obj || typeof obj !== 'object') throw new Error('ファイルの形式が違います');
    if (!Array.isArray(obj.clips) && !Array.isArray(obj.memos)) {
      throw new Error('このアプリのバックアップではありません');
    }
    var pick = function (arr, fallbackColor) {
      return (Array.isArray(arr) ? arr : [])
        .map(function (r) { return sanitizeItem(r, fallbackColor, now); })
        .filter(Boolean);
    };
    return { clips: pick(obj.clips, 'white'), memos: pick(obj.memos, 'yellow') };
  }

  /* 今の中身に足す。同じidは重複させない。
     🔴 足して50件を超えた分は、ピン止めしていない古いものから整理される(元からあった項目も対象)。
        消えた件数は dropped で返し、画面に出す。
     読み込んだ項目の pos(自分の並び)は、今ある最大値の後ろへ付け直す(重複させない)。
     🔴 have は Object.create(null)。{} だと id が "constructor" などのとき重複と誤判定する */
  function mergeItems(current, incoming, now) {
    var cur = Array.isArray(current) ? current.slice() : [];
    var have = Object.create(null);
    var maxPos = -1;
    cur.forEach(function (it) {
      have[it.id] = true;
      var p = Number(it && it.pos);
      if (isFinite(p) && p > maxPos) maxPos = p;
    });
    var added = 0, skipped = 0;
    var withPos = [];
    (Array.isArray(incoming) ? incoming : []).forEach(function (raw) {
      var it = sanitizeItem(raw, 'white', now);
      if (!it) { skipped++; return; }
      if (have[it.id]) { skipped++; return; }
      have[it.id] = true;
      if (it.pos != null) withPos.push(it);
      cur.push(it);
      added++;
    });
    /* 読み込んだ側どうしの順番は保ったまま、今の並びの後ろへ */
    withPos.sort(function (a, b) { return a.pos - b.pos; })
      .forEach(function (it, i) { it.pos = maxPos + 1 + i; });
    /* 増えるものが無ければ何も消さない(全部ピン止めで一時的に50件を超えている分も守る) */
    if (!added) return { list: cur, added: 0, skipped: skipped, dropped: 0 };
    var pruned = prune(cur);
    return { list: pruned, added: added, skipped: skipped, dropped: cur.length - pruned.length };
  }

  function colorHex(id) {
    for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return COLORS[i].hex;
    return '#FFFFFF';
  }
  function textColorHex(id) {
    for (var i = 0; i < TEXT_COLORS.length; i++) if (TEXT_COLORS[i].id === id) return TEXT_COLORS[i].hex;
    return '#1B1B1B';
  }

  /* ---------- 文字の大きさ(小・中・大) ---------- */
  var FONT_SIZES = [
    { id: 's', name: '小', en: 'Small' },
    { id: 'm', name: '中', en: 'Medium' },
    { id: 'l', name: '大', en: 'Large' }
  ];
  function isFontSize(id) {
    for (var i = 0; i < FONT_SIZES.length; i++) if (FONT_SIZES[i].id === id) return true;
    return false;
  }
  /* 小 → 中 → 大 → 小 の順に切り替える。変な値は「中」から数える */
  function nextFontSize(id) {
    var cur = isFontSize(id) ? id : 'm';
    for (var i = 0; i < FONT_SIZES.length; i++) {
      if (FONT_SIZES[i].id === cur) return FONT_SIZES[(i + 1) % FONT_SIZES.length].id;
    }
    return 'm';
  }

  /* ---------- バックアップのお知らせ ---------- */
  var BACKUP_INTERVAL_DAYS = 30;   // 最後の書き出しから、この日数でお知らせ
  var BACKUP_SNOOZE_DAYS = 7;      // 「あとで」を押したときに待つ日数
  var DAY_MS = 24 * 60 * 60 * 1000;

  /* お知らせを出すか。info = { lastBackupAt, baselineAt, snoozeUntil, hasData }(数値はミリ秒・無ければ null)
     ・書き出したことが無いときは baselineAt(使い始めの記録)から数える
     ・中身(メモやピン止め)が無ければ出さない
     ・時計が戻っていて基準が未来にあるときは出さない */
  function backupReminderDue(now, info) {
    info = info || {};
    if (!info.hasData) return false;
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
    var snooze = num(info.snoozeUntil);
    if (snooze !== null && now < snooze) return false;
    var base = num(info.lastBackupAt);
    if (base === null) base = num(info.baselineAt);
    if (base === null) return false;
    return now - base >= BACKUP_INTERVAL_DAYS * DAY_MS;
  }

  /* 書き出して守る価値のある中身があるか(メモがある・ピン止めがある) */
  function hasBackupWorthyData(clips, memos) {
    if (memos && memos.length) return true;
    return !!(clips && clips.some(function (it) { return it && it.pinned; }));
  }

  /* ---------- ひな形(メモのひな形) ---------- */
  var MAX_TEMPLATES = 20;
  var MAX_TEMPLATE_TITLE = 30;

  /* 最初に用意しているひな形。電話番号などの中身は入れない(自分で書き足す) */
  function defaultTemplates(lang) {
    if (lang === 'en') {
      return [
        { id: 'tpl-default-1', title: 'Contact point', text: 'Contact point:\nPhone:\nHours:\nNotes:' },
        { id: 'tpl-default-2', title: 'Greeting', text: 'Hello,\nThis is (name).\nThank you for your help.' },
        { id: 'tpl-default-3', title: 'Address', text: 'Postal code:\nAddress:\nPhone:' }
      ];
    }
    return [
      { id: 'tpl-default-1', title: '相談窓口の連絡先', text: '相談窓口：\n電話：\n受付時間：\nメモ：' },
      { id: 'tpl-default-2', title: 'あいさつ文', text: 'お世話になっております。\n（名前）です。\nよろしくお願いします。' },
      { id: 'tpl-default-3', title: '住所', text: '〒\n住所：\n電話：' }
    ];
  }

  /* 保存された値を安全な形に直す。配列でなければ null(= まだ自分では変えていない)。
     id が無い・文字が無い項目は捨て、長さの上限と件数の上限を守る */
  function sanitizeTemplates(arr) {
    if (!Array.isArray(arr)) return null;
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length && out.length < MAX_TEMPLATES; i++) {
      var t = arr[i];
      if (!t || typeof t !== 'object') continue;
      var id = typeof t.id === 'string' ? t.id : '';
      var text = typeof t.text === 'string' ? clampText(t.text) : '';
      if (!id || seen[id] || !text.trim()) continue;
      var title = typeof t.title === 'string' ? t.title.trim().slice(0, MAX_TEMPLATE_TITLE) : '';
      if (!title) title = text.trim().split(/\r?\n/)[0].slice(0, MAX_TEMPLATE_TITLE);
      seen[id] = true;
      out.push({ id: id, title: title, text: text });
    }
    return out;
  }

  /* ---------- 読み上げ用に文を区切る ---------- */
  /* 長い文を一度に読ませると途中で止まる環境があるので、句点・改行で区切って
     おおよそ maxLen 文字までのかたまりにする。空のかたまりは作らない */
  function speakChunks(text, maxLen) {
    maxLen = maxLen > 20 ? maxLen : 160;
    var s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var parts = s.match(/[^。．.！!？?\n]+[。．.！!？?]*\n*|\n+/g) || [];
    var out = [];
    var cur = '';
    var push = function () { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    parts.forEach(function (p) {
      while (p.length > maxLen) {          // 句読点なしで長く続くときは固定の長さで切る
        if (cur) push();
        out.push(p.slice(0, maxLen).trim());
        p = p.slice(maxLen);
      }
      if (cur.length + p.length > maxLen) push();
      cur += p;
    });
    push();
    return out.filter(function (c) { return c; });
  }

  var api = {
    FONT_SIZES: FONT_SIZES,
    isFontSize: isFontSize,
    nextFontSize: nextFontSize,
    BACKUP_INTERVAL_DAYS: BACKUP_INTERVAL_DAYS,
    BACKUP_SNOOZE_DAYS: BACKUP_SNOOZE_DAYS,
    backupReminderDue: backupReminderDue,
    hasBackupWorthyData: hasBackupWorthyData,
    MAX_TEMPLATES: MAX_TEMPLATES,
    MAX_TEMPLATE_TITLE: MAX_TEMPLATE_TITLE,
    defaultTemplates: defaultTemplates,
    sanitizeTemplates: sanitizeTemplates,
    speakChunks: speakChunks,
    MAX_ITEMS: MAX_ITEMS,
    MAX_TEXT: MAX_TEXT,
    COLORS: COLORS,
    TEXT_COLORS: TEXT_COLORS,
    SORT_MODES: SORT_MODES,
    isSortMode: isSortMode,
    makeItem: makeItem,
    clampText: clampText,
    prune: prune,
    addClip: addClip,
    addMemo: addMemo,
    updateItem: updateItem,
    removeItem: removeItem,
    restoreItem: restoreItem,
    normalizeForSearch: normalizeForSearch,
    filterItems: filterItems,
    sortForDisplay: sortForDisplay,
    applyManualOrder: applyManualOrder,
    sanitizeItem: sanitizeItem,
    buildBackup: buildBackup,
    parseBackup: parseBackup,
    mergeItems: mergeItems,
    colorHex: colorHex,
    textColorHex: textColorHex
  };

  root.SoyogiFusenLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : this);
