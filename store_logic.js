'use strict';
/* 便利クリップメモ・そよぎ 共通ロジック
   content script / background / Node(スモークテスト) の3か所から同じものを使う。
   ここには chrome API を一切書かない(純粋関数のみ)。 */
(function (root) {

  var MAX_ITEMS = 50;      // クリップ履歴・メモ それぞれの上限
  var MAX_TEXT = 10000;    // 1件あたりの文字数上限

  /* 付箋の背景12色(わかりやすいパステル) */
  var COLORS = [
    { id: 'yellow', hex: '#FFF176', name: '黄' },
    { id: 'orange', hex: '#FFB74D', name: 'オレンジ' },
    { id: 'pink',   hex: '#F48FB1', name: 'ピンク' },
    { id: 'red',    hex: '#EF9A9A', name: '赤' },
    { id: 'purple', hex: '#CE93D8', name: '紫' },
    { id: 'blue',   hex: '#90CAF9', name: '青' },
    { id: 'cyan',   hex: '#80DEEA', name: '水色' },
    { id: 'green',  hex: '#A5D6A7', name: '緑' },
    { id: 'lime',   hex: '#DCE775', name: '黄緑' },
    { id: 'brown',  hex: '#BCAAA4', name: '茶' },
    { id: 'gray',   hex: '#CFD8DC', name: 'グレー' },
    { id: 'white',  hex: '#FFFFFF', name: '白' }
  ];

  /* 文字色は4色のみ */
  var TEXT_COLORS = [
    { id: 'black',    hex: '#1B1B1B', name: '黒' },
    { id: 'darkgray', hex: '#555555', name: '濃いグレー' },
    { id: 'red',      hex: '#D32F2F', name: '赤' },
    { id: 'white',    hex: '#FFFFFF', name: '白' }
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

  /* 並べ替えの種類。🔴どれを選んでもピン止めは必ず最上段(ピン優先はアプリの芯) */
  var SORT_MODES = [
    { id: 'new', name: '新しい順' },
    { id: 'old', name: '古い順' },
    { id: 'text', name: 'あいうえお順' },
    { id: 'color', name: '色ごと' }
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
  function sortForDisplay(list, mode) {
    var m = isSortMode(mode) ? mode : 'new';
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

  function colorHex(id) {
    for (var i = 0; i < COLORS.length; i++) if (COLORS[i].id === id) return COLORS[i].hex;
    return '#FFFFFF';
  }
  function textColorHex(id) {
    for (var i = 0; i < TEXT_COLORS.length; i++) if (TEXT_COLORS[i].id === id) return TEXT_COLORS[i].hex;
    return '#1B1B1B';
  }

  var api = {
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
    sortForDisplay: sortForDisplay,
    colorHex: colorHex,
    textColorHex: textColorHex
  };

  root.SoyogiFusenLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof self !== 'undefined' ? self : this);
