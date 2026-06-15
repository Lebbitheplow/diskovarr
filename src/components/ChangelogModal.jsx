import React from 'react'
import { useTranslation } from 'react-i18next'

const SECTION_LABEL_STYLE = {
  margin: '4px 0 2px',
  fontSize: '0.78rem',
  fontWeight: '600',
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const LIST_STYLE = { margin: '0 0 8px', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }
const LIST_STYLE_LAST = { ...LIST_STYLE, margin: '0' }
const ITEM_STYLE = { fontSize: '0.84rem' }
const DATE_STYLE = { fontWeight: '400', color: 'var(--text-secondary)', fontSize: '0.78rem' }

export default function ChangelogModal({ open, onClose }) {
  const { t } = useTranslation()
  if (!open) return null
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.3.2'

  return (
    <div className="info-modal-backdrop open" onClick={onClose}>
      <div className="info-modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
        <button className="info-modal-close" onClick={onClose} aria-label={t('Close')}>✕</button>
        <div className="info-modal-logo">
          <span className="logo-text">{t('Changelog')}</span>
        </div>
        <div className="info-modal-sections" id="changelog-entries">
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v{currentVersion}{' '}
              <span style={DATE_STYLE}>2026-06-15</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed the default request app chosen in Admin → Connections being ignored — your selected default (Overseerr, DUMB, or Sonarr/Radarr) is now always honored</li>
              <li style={ITEM_STYLE}>Fixed choosing an alternate request app from the Advanced option — the request now reaches the app you picked instead of being silently dropped</li>
              <li style={ITEM_STYLE}>Fixed the request app list offering services that can't handle the title — Radarr no longer appears for shows and Sonarr no longer appears for movies, including in the admin Edit Request dialog</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.3.1{' '}
              <span style={DATE_STYLE}>2026-06-12</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed the accent color reverting to the default when returning from the admin panel — your saved color now applies instantly on every page load with no flash</li>
              <li style={ITEM_STYLE}>Fixed the notification dropdown appearing nearly transparent — it now uses the same frosted-glass effect as the user menu</li>
              <li style={ITEM_STYLE}>Fixed the Settings page on mobile — section tabs now scroll horizontally instead of overflowing the screen</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.3.0{' '}
              <span style={DATE_STYLE}>2026-06-12</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Additions')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Added UI localization — Spanish, French, German, and Portuguese translations with user-selectable language</li>
              <li style={ITEM_STYLE}>Added Automation tab in admin panel — auto-request content by genre, rating, or keyword; maintain Plex collections on a schedule; and clean up stale or unwatched requests automatically</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Improvements')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Added /health endpoint for external monitoring, load balancers, and orchestrators</li>
              <li style={ITEM_STYLE}>Added graceful shutdown — active connections are drained and pending writes flushed before exit</li>
              <li style={ITEM_STYLE}>Added automated DB backups with configurable schedules and retention policies</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
