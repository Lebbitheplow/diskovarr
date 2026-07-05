import React from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../context/AuthContext'

// Wide home-page tile announcing Wrapped. Sits in the space of a carousel row
// and resizes with the page. December only — Wrapped {currentYear} unlocks
// December 1, so the banner always announces the year that just unwrapped.
// The rest of the year, Wrapped is reached from the user's own profile.
export default function WrappedBanner() {
  const { t } = useTranslation()
  const { wrappedAvailable } = useAuth()

  const now = new Date()
  if (!wrappedAvailable || now.getMonth() !== 11) return null
  const year = now.getFullYear()

  return (
    <a className="wrapped-banner" href="/wrapped" aria-label={t('Open your Wrapped')}>
      <div className="wrapped-banner-glow" aria-hidden="true" />
      <div className="wrapped-banner-text">
        <span className="wrapped-banner-title">
          Wrapped <span className="wrapped-banner-year">{year}</span>
        </span>
        <span className="wrapped-banner-sub">{t('Your year in review is ready — take the tour')}</span>
      </div>
      <span className="wrapped-banner-cta">{t('Unwrap')} →</span>
    </a>
  )
}
