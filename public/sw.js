// Service worker: static assets stale-while-revalidate; pages always from network (they are per-user), offline page as fallback.
// Pages load scripts as /static/x.js?v=<hash>, so a new version is a new URL; older versions of the same file are pruned.
const CACHE = 'static-v2';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/offline', '/static/style.css', '/static/icon-192.png'])));
  self.skipWaiting();
});
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/static/media/')) return; // video uses Range requests; let the browser stream it
  if (u.pathname.startsWith('/static/')) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(async r => {
        if (!r.ok) return r;
        await c.put(e.request, r.clone());
        for (const k of await c.keys()) { const o = new URL(k.url); if (o.pathname === u.pathname && o.search !== u.search) c.delete(k); }
        return r;
      }).catch(() => hit);
      return hit || net;
    }));
  } else if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/offline')));
  }
});
