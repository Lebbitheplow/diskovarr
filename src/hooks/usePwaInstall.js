import { useSyncExternalStore, useCallback, useMemo } from 'react'
import { getInstallState, subscribeInstallState, promptNativeInstall } from '../utils/pwaInstall'

// useSyncExternalStore needs a referentially stable snapshot; cache by value.
let lastSnapshot = null
function getSnapshot() {
  const next = getInstallState()
  if (!lastSnapshot || lastSnapshot.mode !== next.mode || lastSnapshot.platform !== next.platform) {
    lastSnapshot = next
  }
  return lastSnapshot
}
const serverSnapshot = { mode: 'hidden', platform: 'unsupported' }

/**
 * Install-app state for the user menu.
 * `mode` is 'hidden' (installed or unsupported), 'native' (browser prompt
 * available) or 'manual' (show per-platform instructions for `platform`).
 */
export default function usePwaInstall() {
  const snap = useSyncExternalStore(subscribeInstallState, getSnapshot, () => serverSnapshot)
  const promptInstall = useCallback(() => promptNativeInstall(), [])
  return useMemo(() => ({ ...snap, promptInstall }), [snap, promptInstall])
}
