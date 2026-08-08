'use strict';
/* 便利クリップメモ・そよぎ Web版アイコン生成(32/180/192/512)
   拡張版と同じ絵柄だが、🔴角を透過させない正方形(ベタ塗り)にする。
   iOSはapple-touch-iconの透過部分を黒く塗る&maskableは全面必要のため。
   使い方: node _make_icons.js */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

const GREEN = [0x2E, 0xAD, 0x62, 255];
const WHITE = [255, 255, 255, 255];
const FOLD = [0xD4, 0xD4, 0xD4, 255];
const RED = [0xE0, 0x52, 0x52, 255];
const LINE = [0x75, 0x75, 0x75, 255];

function colorAt(u, v) {
  /* maskableのセーフゾーン(中央80%)に収まるよう、絵柄は拡張版と同じ配置 */
  const nx0 = 0.20, nx1 = 0.80, ny0 = 0.16, ny1 = 0.84, fold = 0.17;
  if (u >= nx0 && u <= nx1 && v >= ny0 && v <= ny1) {
    const du = u - (nx1 - fold), dv = v - (ny1 - fold);
    if (du > 0 && dv > 0) {
      if (du + dv > fold) return GREEN;
      return FOLD;
    }
    if (Math.hypot(u - 0.5, v - 0.27) < 0.075) return RED;
    const lines = [0.46, 0.58, 0.70];
    for (let i = 0; i < lines.length; i++) {
      const ly = lines[i];
      const xEnd = (i === 2) ? 0.58 : 0.70;
      if (v >= ly && v <= ly + 0.055 && u >= 0.30 && u <= xEnd) return LINE;
    }
    return WHITE;
  }
  return GREEN;   // 角まで緑のベタ塗り(透過なし)
}

function writePng(file, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  const offs = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const o of offs) {
        const c = colorAt((x + o[0]) / size, (y + o[1]) / size);
        r += c[0]; g += c[1]; b += c[2]; a += c[3];
      }
      raw[p++] = Math.round(r / 4);
      raw[p++] = Math.round(g / 4);
      raw[p++] = Math.round(b / 4);
      raw[p++] = Math.round(a / 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  console.log('生成: ' + file + ' (' + png.length + ' bytes)');
}

[32, 180, 192, 512].forEach(function (s) {
  writePng(path.join(OUT_DIR, 'icon' + s + '.png'), s);
});
