import { describe, it, expect } from 'vitest'
import { detectManualPlatform, isRunningInstalled, resolveInstallMode, PLATFORM } from '../src/utils/pwaInstall'

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macSafari17: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macSafari16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36',
  androidDDG: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile DuckDuckGo/5 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  desktopFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  desktopEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0',
}

describe('detectManualPlatform', () => {
  it('treats every iOS browser as Share → Add to Home Screen', () => {
    expect(detectManualPlatform(UA.iphoneSafari)).toBe(PLATFORM.IOS)
    expect(detectManualPlatform(UA.iphoneChrome)).toBe(PLATFORM.IOS)
  })
  it('unmasks iPadOS via touch points', () => {
    expect(detectManualPlatform(UA.ipadOS, { maxTouchPoints: 5 })).toBe(PLATFORM.IOS)
    expect(detectManualPlatform(UA.macSafari17, { maxTouchPoints: 0 })).toBe(PLATFORM.MACOS_SAFARI)
  })
  it('only offers Add to Dock on Safari 17+', () => {
    expect(detectManualPlatform(UA.macSafari16)).toBe(PLATFORM.UNSUPPORTED)
  })
  it('identifies non-Chromium Android browsers with manual install flows', () => {
    expect(detectManualPlatform(UA.androidFirefox)).toBe(PLATFORM.FIREFOX_ANDROID)
    expect(detectManualPlatform(UA.androidSamsung)).toBe(PLATFORM.SAMSUNG)
    expect(detectManualPlatform(UA.androidDDG)).toBe(PLATFORM.DUCKDUCKGO_ANDROID)
  })
  it('keeps Chromium browsers installable via menu when the event never fires', () => {
    expect(detectManualPlatform(UA.androidChrome)).toBe(PLATFORM.CHROMIUM)
    expect(detectManualPlatform(UA.desktopEdge)).toBe(PLATFORM.CHROMIUM_DESKTOP)
    expect(detectManualPlatform(UA.macChrome)).toBe(PLATFORM.CHROMIUM_DESKTOP)
  })
  it('hides on browsers with no install support', () => {
    expect(detectManualPlatform(UA.desktopFirefox)).toBe(PLATFORM.UNSUPPORTED)
    expect(detectManualPlatform(undefined)).toBe(PLATFORM.UNSUPPORTED)
  })
})

describe('isRunningInstalled', () => {
  it('detects standalone display mode, iOS navigator.standalone and TWA referrers', () => {
    expect(isRunningInstalled({ displayModeStandalone: true })).toBe(true)
    expect(isRunningInstalled({ navigatorStandalone: true })).toBe(true)
    expect(isRunningInstalled({ referrer: 'android-app://com.android.chrome' })).toBe(true)
    expect(isRunningInstalled({ displayModeStandalone: false, navigatorStandalone: undefined, referrer: 'https://x' })).toBe(false)
  })
})

describe('resolveInstallMode', () => {
  const base = { installed: false, hasNativePrompt: false, promptDismissed: false, platform: PLATFORM.UNSUPPORTED }
  it('hides when installed, regardless of platform or prompt', () => {
    expect(resolveInstallMode({ ...base, installed: true, hasNativePrompt: true, platform: PLATFORM.IOS }).mode).toBe('hidden')
  })
  it('prefers the native prompt when the browser offered one', () => {
    expect(resolveInstallMode({ ...base, hasNativePrompt: true, platform: PLATFORM.SAMSUNG }).mode).toBe('native')
  })
  it('falls back to menu instructions after the native prompt was dismissed', () => {
    expect(resolveInstallMode({ ...base, promptDismissed: true })).toEqual({ mode: 'manual', platform: PLATFORM.CHROMIUM })
    expect(resolveInstallMode({ ...base, promptDismissed: true, platform: PLATFORM.CHROMIUM_DESKTOP })).toEqual({ mode: 'manual', platform: PLATFORM.CHROMIUM_DESKTOP })
  })
  it('shows manual steps for known platforms and hides otherwise', () => {
    expect(resolveInstallMode({ ...base, platform: PLATFORM.FIREFOX_ANDROID })).toEqual({ mode: 'manual', platform: PLATFORM.FIREFOX_ANDROID })
    expect(resolveInstallMode(base).mode).toBe('hidden')
  })
})
