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

// Shows the current release plus the two before it — older history lives in
// server/CHANGELOG.md.
export default function ChangelogModal({ open, onClose }) {
  const { t } = useTranslation()
  if (!open) return null
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.5.8'

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
              <span style={DATE_STYLE}>2026-08-22</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Security patches across the frontend and server dependencies (Snyk)</li>
              <li style={ITEM_STYLE}>Upgraded the email (SMTP) library to nodemailer v9, resolving a security advisory in the mailer</li>
              <li style={ITEM_STYLE}>Patched additional dependency vulnerabilities in the request-routing and build toolchains (path-to-regexp, PostCSS, nanoid, and Vite tooling)</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.7{' '}
              <span style={DATE_STYLE}>2026-08-21</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Filter the request queue by app — a new App filter lets admins narrow the queue to requests routed to Sonarr, Radarr, Overseerr, DUMB, or YouTube (plus a Default bucket for requests whose app is chosen at approval time)</li>
              <li style={ITEM_STYLE}>Reporting a missing season or episode can now queue a search automatically — tick "This content is missing" when reporting an issue for a show, and Diskovarr searches for it in your default request app</li>
              <li style={ITEM_STYLE}>When a reporter's requests need approval, missing-content issues wait for an admin instead — a Search now button on the issue lets you kick off the search (and retry if one fails)</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.6{' '}
              <span style={DATE_STYLE}>2026-08-19</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Security patches across the frontend, server, and Docker base image (Snyk)</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
