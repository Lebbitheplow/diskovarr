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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.4.0'

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
              <span style={DATE_STYLE}>2026-07-04</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Diskovarr Wrapped — a story-style walkthrough of your year, one stat at a time: hours watched, top movie, top show, the oldest thing you watched, top genres, viewing patterns (month-by-month chart, most active day and hour, biggest binge, longest streak), percentile rankings, your taste age, your show buddy, your Diskovarr personality (an archetype based on what you watch, with trait badges), a critic slide if you wrote reviews, and your Diskovarr activity. Find it on your profile — each year unlocks December 1 and past years stay available; in December a banner on the home page takes you straight there</li>
              <li style={ITEM_STYLE}>Server leaderboard — see how your watch time stacks up against everyone else, names and numbers included</li>
              <li style={ITEM_STYLE}>Share any Wrapped stat as an image — the same share options as reviews, with a generated card per stat, addressed by a private link only you can hand out</li>
              <li style={ITEM_STYLE}>One-click playlist — create a "Diskovarr Wrapped" playlist of your top content of the year in your own Plex account</li>
              <li style={ITEM_STYLE}>Accurate by design — plays only count once you've watched at least 5 minutes and 20% of a title (or finished it), so accidental clicks never pollute your stats</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Fixed editing a monitor duplicating its criteria on every save — saving now replaces the set in one step, removing a criterion actually sticks, and duplicates from the old bug are cleaned up automatically</li>
              <li style={ITEM_STYLE}>Monitor criteria for keyword, language, and production company now match newly added Plex content, not just requestable titles</li>
              <li style={ITEM_STYLE}>Deletion safety — titles deleted and re-added to Plex are no longer treated as never watched by deletion profiles, and watch-based profiles now protect items added in the last 14 days unless you set your own age cutoff</li>
              <li style={ITEM_STYLE}>Show deletions no longer bypass Sonarr when a lookup briefly fails — the deletion retries on the next run instead of leaving Sonarr monitoring a deleted show</li>
              <li style={ITEM_STYLE}>Auto-request lists retry a failed sync within about an hour instead of waiting out the full sync interval</li>
              <li style={ITEM_STYLE}>Fixed the search suggestions dropdown appearing nearly transparent — it now uses the same frosted glass as the user menu</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.3.3{' '}
              <span style={DATE_STYLE}>2026-07-01</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Fixed real-time Plex detection — newly added items are picked up the moment Plex finishes processing them, so requested titles are marked available and join the library within seconds instead of waiting for the next library rescan</li>
              <li style={ITEM_STYLE}>Fixed "now available" notifications — you're now notified when a title you requested is added to the library; a matching bug meant these never fired from library scans</li>
              <li style={ITEM_STYLE}>Fixed the Watched count on the admin Users page never updating — watched syncs now pull each user's watch history directly from the Plex server, so counts move as users watch (they may jump once as historical plays are counted)</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Improvements')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Movies can now be reviewed from your watch history once you've watched more than 10% — no need to finish them first; shows are unchanged, any watched episode qualifies</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.3.2{' '}
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
        </div>
      </div>
    </div>
  )
}
