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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.6.0'

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
              <span style={DATE_STYLE}>2026-08-31</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Jellyfin server support — Diskovarr now works with Jellyfin as well as Plex. Admins add their Jellyfin server under Admin → Connections, and its movies and shows sync into the library alongside Plex's</li>
              <li style={ITEM_STYLE}>Sign in with Jellyfin — the login page now offers a Jellyfin username and password form next to the Plex button, showing only the sign-in options your server has configured</li>
              <li style={ITEM_STYLE}>Link your Plex and Jellyfin accounts — a new Media Server Accounts card in Settings connects the two, so signing in with either one lands you in the same profile with a single combined watch history, watchlist, and reviews</li>
              <li style={ITEM_STYLE}>Switch between libraries — with both servers set up, a Plex / Jellyfin toggle appears in the navigation bar; recommendations, search, and availability follow whichever you pick, and your choice is remembered</li>
              <li style={ITEM_STYLE}>Jellyfin watch history needs no Tautulli — Jellyfin tracks plays natively, so your history, ratings, and favorites mirror in every 15 minutes, and your Jellyfin Favorites act as your watchlist</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Recommendations blend both servers — with linked accounts, what you watched on Plex shapes your Jellyfin recommendations and vice versa</li>
              <li style={ITEM_STYLE}>Tuberr now starts and stops with Diskovarr — the bundled YouTube downloader runs as part of the server, launching when you enable the YouTube integration and restarting itself if it crashes, with no separate service to install</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.8{' '}
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
        </div>
      </div>
    </div>
  )
}
