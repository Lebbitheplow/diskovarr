import React from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { PLATFORM } from '../utils/pwaInstall'

/**
 * Manual "Add to Home Screen" instructions for browsers that cannot trigger the
 * native install prompt from a page (iOS, Firefox on Android, Safari on macOS, …).
 */
export default function InstallAppModal({ isOpen, onClose, platform }) {
  const { t } = useTranslation()
  if (!isOpen) return null

  const steps = stepsFor(platform, t)

  return (
    <Modal isOpen={isOpen} onClose={onClose}>
      <h2 className="install-app-title">{t('Install Diskovarr')}</h2>
      <p className="install-app-intro">
        {t('Add Diskovarr to your home screen for a full-screen, app-like experience with its own icon.')}
      </p>
      <ol className="install-app-steps">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {platform === PLATFORM.IOS && (
        <p className="install-app-note">{t('On iPhone and iPad this works in Safari and, on iOS 16.4 or later, in other browsers too.')}</p>
      )}
    </Modal>
  )
}

function stepsFor(platform, t) {
  switch (platform) {
    case PLATFORM.IOS:
      return [
        t('Tap the Share button (the square with an arrow pointing up).'),
        t('Scroll down and tap "Add to Home Screen".'),
        t('Tap "Add" in the top-right corner.'),
      ]
    case PLATFORM.MACOS_SAFARI:
      return [
        t('Open the File menu in Safari\'s menu bar.'),
        t('Choose "Add to Dock…".'),
        t('Confirm the name and click "Add".'),
      ]
    case PLATFORM.FIREFOX_ANDROID:
      return [
        t('Tap the ⋮ menu button in the toolbar.'),
        t('Tap "Install" (on older versions, "Add to Home screen").'),
        t('Confirm by tapping "Add".'),
      ]
    case PLATFORM.SAMSUNG:
      return [
        t('Tap the ≡ menu button in the bottom toolbar.'),
        t('Tap "Add page to", then "Home screen".'),
        t('Confirm by tapping "Add".'),
      ]
    case PLATFORM.DUCKDUCKGO_ANDROID:
      return [
        t('Tap the ⋮ menu button in the toolbar.'),
        t('Tap "Add to Home screen".'),
        t('Confirm by tapping "Add".'),
      ]
    case PLATFORM.CHROMIUM_DESKTOP:
      return [
        t('Click the install icon at the right end of the address bar, if your browser shows one.'),
        t('Otherwise open the browser menu (⋮ or ⋯) and look for "Install Diskovarr", "Install page as app" or, in Edge, Apps → "Install this site as an app".'),
        t('Confirm by clicking "Install".'),
      ]
    case PLATFORM.CHROMIUM:
    default:
      return [
        t('Open your browser\'s menu (usually ⋮ or ⋯ in the toolbar).'),
        t('Tap "Install app" or "Add to Home screen".'),
        t('Confirm by tapping "Install".'),
      ]
  }
}
