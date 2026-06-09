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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.2.0'

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
              <span style={DATE_STYLE}>2026-06-09</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>Additions</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Added user profiles with a customizable bio, your reviews, and a personal watch history</li>
              <li style={ITEM_STYLE}>Added a Reviews page with social features — see what the community is watching and join the conversation</li>
              <li style={ITEM_STYLE}>You can now generate and share beautifully formatted review images to your favorite social and messaging apps</li>
              <li style={ITEM_STYLE}>Added "Most Popular on Server" sections to the Diskovarr page to surface what's trending in your own Plex library</li>
              <li style={ITEM_STYLE}>Added a Cast & Crew tab to the item details modal for exploring actors, directors, and production staff</li>
              <li style={ITEM_STYLE}>Added TMDB and Plex rating integration — ratings you give in Diskovarr now sync back to Plex</li>
              <li style={ITEM_STYLE}>Added Connected Apps settings for linking your TMDB account</li>
              <li style={ITEM_STYLE}>Added personal content monitors that notify you when newly available media matches the criteria you care about</li>
              <li style={ITEM_STYLE}>Expanded the Filter page with more powerful filtering and search refinement options</li>
              <li style={ITEM_STYLE}>Admins can now choose which Plex libraries are synced into Diskovarr</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>Fixes & Improvements</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Watchlist and Blacklist management moved from the user menu to your profile for easier access</li>
              <li style={ITEM_STYLE}>Smarter stale-content pruning keeps your library in sync as media is changed or removed</li>
              <li style={ITEM_STYLE}>The About modal now highlights and explains recently added features</li>
              <li style={ITEM_STYLE}>Various UI, usability, and quality-of-life improvements throughout the app</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.1.0{' '}
              <span style={DATE_STYLE}>2026-06-05</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>Additions</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Added a Blacklist page where users can see and manage blacklisted / "not interested" items</li>
              <li style={ITEM_STYLE}>Added a site footer with GitHub and other links</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>Fixes & Improvements</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Broadcast notification font styles are now applied correctly in the notification bell and modal</li>
              <li style={ITEM_STYLE}>Broadcast font-style buttons now highlight to reflect their enabled state, and the highlight can be toggled off again</li>
              <li style={ITEM_STYLE}>Admins can now edit approved requests to change the request app or season selection</li>
              <li style={ITEM_STYLE}>Item info modals now open when selecting an item from the Queue page</li>
              <li style={ITEM_STYLE}>Watchlist now correctly syncs and removes watched / deleted items</li>
              <li style={ITEM_STYLE}>Various other under-the-hood code improvements</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.0.1{' '}
              <span style={DATE_STYLE}>2026-05-19</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>Fixes & Improvements</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed search failures on certain titles (e.g. "Napoleon Dynamite") caused by double-gzipped TMDB responses from CloudFront</li>
              <li style={ITEM_STYLE}>Hardened the TMDB client to resiliently decompress nested gzip payloads, fixing intermittent failures across Search, autocomplete, item details, and Discover</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
