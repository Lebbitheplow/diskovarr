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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.7.0'

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
              <span style={DATE_STYLE}>2026-09-01</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>A new sidebar — the top navigation bar has moved to a collapsible rail down the left side, with every page one click away instead of hidden behind the avatar menu. Click ☰ to shrink it to icons; Diskovarr remembers your choice</li>
              <li style={ITEM_STYLE}>A spotlight on the home page — your strongest recommendation now leads the page as full-width artwork with its rating, runtime, description, and Play and Watchlist buttons</li>
              <li style={ITEM_STYLE}>Redesigned artwork cards — posters are larger and cleaner, with the title, year, and rating laid over the artwork and the reasons a title was recommended revealed on hover</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>A refreshed look across every page — frosted panels, a new display typeface for headings, and shelf headings that pin below the top bar as you scroll</li>
              <li style={ITEM_STYLE}>Moving between pages no longer reloads the app, so navigation is instant, and opening a title now expands its poster into the detail window</li>
              <li style={ITEM_STYLE}>Shelves now animate in as you scroll to them rather than all at once on load</li>
              <li style={ITEM_STYLE}>Diskovarr Requests now has the same full-width spotlight as the home page, and both cycle through your top picks every few seconds — hover to hold one in place, or use the dots to jump</li>
              <li style={ITEM_STYLE}>Added a privacy notice, linked in the footer, covering what this server stores, who it talks to, and what other members can see</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>The "Show mature content" switch on the home page now applies to every shelf — it previously only affected the two Most Popular rows, leaving R and TV-MA titles filtered out of your recommendations no matter how it was set</li>
              <li style={ITEM_STYLE}>Esc now closes the title detail window, and stops the trailer with it</li>
              <li style={ITEM_STYLE}>If your session expires while you're browsing, Diskovarr now returns you to the sign-in page instead of quietly failing to load anything</li>
              <li style={ITEM_STYLE}>Email notifications now actually send — set the address you want them delivered to in Settings → Notifications → Email. The feature previously looked for an address that was never stored</li>
              <li style={ITEM_STYLE}>Saving one notification channel no longer clears the others — Telegram, Pushbullet and email settings were being reset whenever any other notification setting was saved</li>
              <li style={ITEM_STYLE}>Trailers now use YouTube's privacy-enhanced player, so YouTube doesn't set tracking cookies unless you press play</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.6.0{' '}
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
        </div>
      </div>
    </div>
  )
}
