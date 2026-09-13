/**
 * PWA install support: captures Chromium's `beforeinstallprompt` event as early
 * as possible (this module is imported from main.jsx before React mounts) and
 * classifies the current browser so the UI knows whether to offer a native
 * install prompt, show manual "Add to Home Screen" instructions, or hide the
 * option entirely (already installed, or the browser cannot install web apps).
 *
 * The detection helpers are pure so they can be unit-tested without a DOM.
 */

/** Manual-install platforms. Each maps to its own instruction set in the UI. */
export const PLATFORM = {
  IOS: 'ios',                    // Safari / any iOS browser: Share → Add to Home Screen
  MACOS_SAFARI: 'macos-safari',  // Safari 17+: File → Add to Dock
  FIREFOX_ANDROID: 'firefox-android',
  SAMSUNG: 'samsung',            // Samsung Internet (no native prompt fired)
  DUCKDUCKGO_ANDROID: 'duckduckgo-android',
  CHROMIUM: 'chromium',          // Chromium on Android without a native prompt: menu → Install app
  CHROMIUM_DESKTOP: 'chromium-desktop', // Chrome/Edge/Brave/… on desktop: address-bar icon or menu
  UNSUPPORTED: 'unsupported',
}

/**
 * True when the page is already running as an installed app.
 * @param {{ displayModeStandalone?: boolean, navigatorStandalone?: boolean, referrer?: string }} env
 */
export function isRunningInstalled(env) {
  if (env.displayModeStandalone) return true
  if (env.navigatorStandalone === true) return true // iOS Safari home-screen apps
  if (env.referrer && env.referrer.startsWith('android-app://')) return true // TWA
  return false
}

/**
 * Classify a browser by user agent for the manual-instructions fallback.
 * @param {string} ua navigator.userAgent
 * @param {{ maxTouchPoints?: number }} [opts]
 * @returns {string} one of PLATFORM
 */
export function detectManualPlatform(ua, opts = {}) {
  const s = String(ua || '')
  const touch = opts.maxTouchPoints || 0

  // iPadOS 13+ masquerades as macOS; the touch-point count gives it away.
  const isIOS = /iPhone|iPad|iPod/i.test(s) || (/Macintosh/.test(s) && touch > 1)
  if (isIOS) return PLATFORM.IOS

  const isAndroid = /Android/i.test(s)
  if (isAndroid) {
    if (/Firefox|FxiOS|Focus/i.test(s)) return PLATFORM.FIREFOX_ANDROID
    if (/SamsungBrowser/i.test(s)) return PLATFORM.SAMSUNG
    if (/DuckDuckGo/i.test(s)) return PLATFORM.DUCKDUCKGO_ANDROID
    // Chrome, Edge, Brave, Opera, Vivaldi, Kiwi: all Chromium. They normally
    // fire the native prompt; if it hasn't (yet), the browser menu still works.
    if (/Chrome\//.test(s)) return PLATFORM.CHROMIUM
    return PLATFORM.UNSUPPORTED
  }

  // Desktop Safari: only 17+ can install (File → Add to Dock). Rule out the
  // Chromium/Firefox engines that also carry the "Safari" token.
  const isSafariDesktop = /Macintosh/.test(s) && /Safari\//.test(s)
    && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(s)
  if (isSafariDesktop) {
    const m = s.match(/Version\/(\d+)/)
    const major = m ? parseInt(m[1], 10) : 0
    return major >= 17 ? PLATFORM.MACOS_SAFARI : PLATFORM.UNSUPPORTED
  }

  // Desktop Chromium (Chrome, Edge, Brave, Opera, Vivaldi) can always install
  // from the address bar or menu, even when the page-level event never fires.
  if (/Chrome\//.test(s) && !/Firefox/i.test(s)) return PLATFORM.CHROMIUM_DESKTOP
  // Desktop Firefox has no PWA install.
  return PLATFORM.UNSUPPORTED
}

/**
 * Resolve what the Install button should do.
 * @param {{ installed: boolean, hasNativePrompt: boolean, promptDismissed: boolean, platform: string }} s
 * @returns {{ mode: 'hidden' | 'native' | 'manual', platform: string }}
 */
export function resolveInstallMode(s) {
  if (s.installed) return { mode: 'hidden', platform: s.platform }
  if (s.hasNativePrompt) return { mode: 'native', platform: s.platform }
  // Chromium won't re-fire the event after a dismissal until the next visit,
  // but the browser menu can still install the app, so keep offering it.
  if (s.platform !== PLATFORM.UNSUPPORTED) return { mode: 'manual', platform: s.platform }
  if (s.promptDismissed) return { mode: 'manual', platform: PLATFORM.CHROMIUM }
  return { mode: 'hidden', platform: s.platform }
}

// ── Browser-side store ────────────────────────────────────────────────────────

const listeners = new Set()
const state = {
  deferredPrompt: null,
  promptDismissed: false,
  installed: false,
}

function emit() { listeners.forEach((fn) => fn()) }

function readEnv() {
  if (typeof window === 'undefined') return { installed: false, platform: PLATFORM.UNSUPPORTED }
  const displayModeStandalone = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
    .some((m) => window.matchMedia?.(`(display-mode: ${m})`)?.matches)
  return {
    installed: isRunningInstalled({
      displayModeStandalone,
      navigatorStandalone: window.navigator.standalone,
      referrer: document.referrer,
    }),
    platform: detectManualPlatform(window.navigator.userAgent, { maxTouchPoints: window.navigator.maxTouchPoints }),
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // keep Chromium's mini-infobar out of the way; we prompt from the menu
    state.deferredPrompt = e
    state.promptDismissed = false
    emit()
  })
  window.addEventListener('appinstalled', () => {
    state.deferredPrompt = null
    state.installed = true
    emit()
  })
}

/** Snapshot for the UI: `{ mode, platform }` per resolveInstallMode. */
export function getInstallState() {
  const env = readEnv()
  return resolveInstallMode({
    installed: env.installed || state.installed,
    hasNativePrompt: !!state.deferredPrompt,
    promptDismissed: state.promptDismissed,
    platform: env.platform,
  })
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribeInstallState(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Show the browser's native install dialog. Resolves to 'accepted',
 * 'dismissed', or null when no native prompt is available.
 */
export async function promptNativeInstall() {
  const evt = state.deferredPrompt
  if (!evt) return null
  state.deferredPrompt = null // a captured event can only be prompt()ed once
  let outcome = 'dismissed'
  try {
    await evt.prompt()
    const choice = await evt.userChoice
    outcome = choice?.outcome === 'accepted' ? 'accepted' : 'dismissed'
  } catch {
    outcome = 'dismissed'
  }
  if (outcome === 'accepted') state.installed = true
  else state.promptDismissed = true
  emit()
  return outcome
}
