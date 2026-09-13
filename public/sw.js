/* Diskovarr push service worker.
 * Display-only: shows Web Push notifications from the server and opens the
 * deep link on click. Intentionally no fetch handler / asset caching. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { message: event.data && event.data.text() } }
  const title = data.subject || 'Diskovarr'
  const options = {
    body: data.message || '',
    icon: '/diskovarr-logo.png',
    badge: '/diskovarr-logo.png',
    image: data.image || undefined,
    data: { url: data.url || '/' },
    tag: data.notificationType ? `diskovarr-${data.notificationType}` : undefined,
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of all) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client) { try { await client.navigate(url) } catch { /* cross-origin */ } }
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})
