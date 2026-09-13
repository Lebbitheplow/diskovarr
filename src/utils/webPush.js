/**
 * Browser push (Web Push) helpers for the user's Settings → Notifications →
 * WebPush panel. The service worker lives at /sw.js (see public/sw.js) and only
 * displays pushes; it does no fetch caching so it can't serve stale assets.
 *
 * The pure helpers are exported separately so they can be unit-tested
 * without a DOM.
 */

/** Convert a base64url VAPID public key to the Uint8Array PushManager wants. */
export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * Why push can't be offered in this browser, or null when it can.
 * @param {{ hasServiceWorker?: boolean, hasPushManager?: boolean, hasNotification?: boolean, isSecureContext?: boolean, permission?: string }} env
 */
export function pushUnavailableReason(env) {
  if (!env.isSecureContext) return 'Browser notifications need a secure (HTTPS) connection.'
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
    return 'This browser does not support push notifications. On iOS, add Diskovarr to your Home Screen first.'
  }
  if (env.permission === 'denied') return 'Notifications are blocked for this site. Allow them in your browser settings and try again.'
  return null
}

export function currentPushEnv() {
  if (typeof window === 'undefined') return { isSecureContext: false }
  return {
    isSecureContext: !!window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
    permission: typeof Notification !== 'undefined' ? Notification.permission : 'default',
  }
}

async function getRegistration() {
  // Register (idempotent) and wait until the worker is active so
  // pushManager.subscribe() doesn't race a first-time install.
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  await navigator.serviceWorker.ready
  return reg
}

/** The browser's existing subscription for this origin, if any. */
export async function getExistingSubscription() {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

/** Ask permission, subscribe this browser, and return the PushSubscription. */
export async function subscribeBrowser(vapidPublicKey) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted')
  const reg = await getRegistration()
  const existing = await reg.pushManager.getSubscription()
  if (existing) return existing
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  })
}

/** Drop this browser's subscription. Returns the endpoint that was removed, if any. */
export async function unsubscribeBrowser() {
  const sub = await getExistingSubscription()
  if (!sub) return null
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  return endpoint
}
