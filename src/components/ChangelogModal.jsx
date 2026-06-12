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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.3.0'

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
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.2.2{' '}
              <span style={DATE_STYLE}>2026-06-11</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Security')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Session cookies are now marked Secure over HTTPS, and API keys no longer create persistent sessions</li>
              <li style={ITEM_STYLE}>Hardened the poster proxy against path traversal and added rate limiting to compute-heavy endpoints</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes & Improvements')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed stale results when changing filters mid-search or while recommendations were still building</li>
              <li style={ITEM_STYLE}>Faster Requests page rendering, new database indexes, and cached Plex device lookups</li>
              <li style={ITEM_STYLE}>Internal code health improvements — shared utilities, removed dead code, and a new automated test suite</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.2.1{' '}
              <span style={DATE_STYLE}>2026-06-09</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed queue page filters that were resetting unexpectedly due to broken URL-based filter state</li>
              <li style={ITEM_STYLE}>Fixed bulk delete of multiple requests and issues — transaction handling was preventing deletes from completing</li>
              <li style={ITEM_STYLE}>Fixed Plex SSE integration — message parsing now handles both SSE eventsource and WebSocket endpoint shapes, restoring real-time new-content detection</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
