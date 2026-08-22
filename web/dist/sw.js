/**
 * 自毁版 Service Worker（PWA 已撤除）。
 * 曾注册过旧 SW 的浏览器在更新检查时会拿到这份：激活即清空全部缓存、
 * 注销自身、强刷所有受控页面。之后浏览器回到无 SW 的普通状态。
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) await caches.delete(k);
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.navigate(c.url);
    })(),
  );
});
