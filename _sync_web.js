'use strict';
/* 拡張本体(copipe_fusen)から共用ファイルを取り込む。
   🔴 Web側の store_logic.js / content.js は直接編集禁止。本体を直してこれで同期する。
   使い方: node _sync_web.js */
const fs = require('fs');
const path = require('path');

const SRC = 'C:\\Users\\puipu\\copipe_fusen';
const FILES = ['store_logic.js', 'content.js'];

for (const f of FILES) {
  fs.copyFileSync(path.join(SRC, f), path.join(__dirname, f));
  console.log('同期: ' + f);
}
console.log('完了');
