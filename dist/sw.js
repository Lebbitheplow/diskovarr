const CACHE = 'diskovarr-shell-v2';
const SHELL = [
  '/css/style.css',
  '/css/discover.css',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept auth routes or the Plex callback — the browser must handle these
  // directly so Set-Cookie response headers are stored in the cookie jar correctly.
  if (url.pathname.startsWith('/auth/') || url.pathname === '/callback') {
    return;
  }

  // Always network-first for API, HTML pages, and theme CSS
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/theme.css' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/icons/') ||
    e.request.mode === 'navigate'
  ) {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  // Cache-first for static assets (CSS, JS, fonts)
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok && (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/'))) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
