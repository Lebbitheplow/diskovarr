import React from 'react'

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
  if (!open) return null
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.0.1'

  return (
    <div className="info-modal-backdrop open" onClick={onClose}>
      <div className="info-modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()} style={{ maxWidth: '520px' }}>
        <button className="info-modal-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="info-modal-logo">
          <span className="logo-text">Changelog</span>
        </div>
        <div className="info-modal-sections" id="changelog-entries">
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v{currentVersion}{' '}
              <span style={DATE_STYLE}>2026-05-19</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>Fixes & Improvements</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed search failures on certain titles (e.g. "Napoleon Dynamite") caused by double-gzipped TMDB responses from CloudFront</li>
              <li style={ITEM_STYLE}>Hardened the TMDB client to resiliently decompress nested gzip payloads, fixing intermittent failures across Search, autocomplete, item details, and Discover</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.0.0{' '}
              <span style={DATE_STYLE}>2026-05-18</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>Additions</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Added genre lists to the Requests page</li>
              <li style={ITEM_STYLE}>Added "Coming Soon" items to the Requests page</li>
              <li style={ITEM_STYLE}>Added toggle to hide library items on the Search page</li>
              <li style={ITEM_STYLE}>Introduced new filter section for the Search and Filter pages</li>
              <li style={ITEM_STYLE}>Added server-side search and filter API calls for the Queue and Issues pages (user filter, date-range filter)</li>
              <li style={ITEM_STYLE}>Added "More Like This" recommendations on the Search page</li>
              <li style={ITEM_STYLE}>Added 8 notification agents: Webhook, Slack, Gotify, ntfy, Pushbullet, Telegram, Email, WebPush</li>
              <li style={ITEM_STYLE}>Added font-style options (bold, italic, strikethrough, inline code) to the broadcast message editor</li>
              <li style={ITEM_STYLE}>Added Plex SSE integration for detecting recently added media</li>
              <li style={ITEM_STYLE}>Added scrolling poster tiles to the login page</li>
              <li style={ITEM_STYLE}>Notifications now include clickable hyperlinks</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>Removals</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Removed torrent browser</li>
              <li style={ITEM_STYLE}>Removed Real-Debrid key field from the admin page</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>Fixes & Improvements</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Watchlist now properly imports items from user watchlists</li>
              <li style={ITEM_STYLE}>Admin user selector now supports scrolling and search</li>
              <li style={ITEM_STYLE}>Improved functionality in the Seerr compatibility shim</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v1.17.12{' '}
              <span style={DATE_STYLE}>2025-01-01</span>
            </div>
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <li style={ITEM_STYLE}>Initial React migration</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
