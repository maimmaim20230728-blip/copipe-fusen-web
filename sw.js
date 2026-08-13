'use strict';
/* 便利クリップメモ・そよぎ Web版 service worker (cache-first)
   🔴 更新のたびに CACHE の版数を必ず上げること(据え置き禁止)。
   🔴 更新直後の初回起動は旧画面のまま=開き直しで反映、を案内文に入れること。 */
var CACHE = 'benri-clip-memo-web-v0.1.4';
var ASSETS = [
  './',
  './index.html',
  './store_logic.js',
  './content.js',
  './manifest.webmanifest',
  './icons/icon32.png',
  './icons/icon180.png',
  './icons/icon192.png',
  './icons/icon512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request);
    })
  );
});
