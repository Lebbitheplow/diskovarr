// Kill-switch service worker.
//
// Diskovarr no longer uses a service worker (the v1 SW cached /css/* paths
// that don't exist in the Vite build, and the React app never registers one).
// v1-era clients may still have the old SW controlling pages and serving
// stale cached responses. Browsers re-fetch the registered SW script on
// navigation, so shipping this file at the same path makes those clients
// install it, wipe all caches, unregister, and reload — after which pages
// are served directly from the network. This file can be deleted once no
// v1 clients remain, but keeping it is harmless.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((client) => client.navigate(client.url));
  })());
});
