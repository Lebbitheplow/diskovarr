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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '3.0.1'

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
              <span style={DATE_STYLE}>2026-09-02</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Cast from the home spotlight — the spotlight's Play button is now a Cast button: pick a TV or player and Diskovarr starts the title there, the same casting the detail window already offered</li>
              <li style={ITEM_STYLE}>Jellyfin now matches Plex almost everywhere — Jellyfin users can cast to their devices, build a Wrapped playlist, and have their real per-play watch history tracked, and list-based collections, the library cleanup automation, and unlinking a Plex account all work for Jellyfin too</li>
              <li style={ITEM_STYLE}>The YouTube downloader is now a first-class part of Diskovarr — a new YouTube tab in the admin panel shows its health, the download queue, failures, and match progress, and Diskovarr alerts admins when the downloader goes offline, YouTube quota runs out, or its cookies expire</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>YouTube downloader alerts can now be relayed through every notification channel — Slack, Gotify, ntfy, Telegram, Pushbullet, Email, Webhook and browser push, not just Discord and Pushover. Tick "YouTube downloader alerts" in a channel's settings to turn it on; the in-app bell always shows them</li>
              <li style={ITEM_STYLE}>Any TV show can now be downloaded from YouTube, not only shows that exist solely on TVDB</li>
              <li style={ITEM_STYLE}>Better YouTube episode matching — short titles, platform tags like "(NES)", and "#7" vs "#07" now line up correctly, and channels with nothing left to match stop burning through your daily quota</li>
              <li style={ITEM_STYLE}>Downloaded YouTube videos now carry their real title, thumbnail, and metadata, so Plex and Jellyfin stop labelling them "Episode 35"</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>YouTube requests now turn Available when their episodes land in the library, and finished downloads are cleaned up instead of piling up hundreds of gigabytes on disk</li>
              <li style={ITEM_STYLE}>The Cast button no longer appears on items or for accounts that can't actually be cast</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.0.0{' '}
              <span style={DATE_STYLE}>2026-09-02</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Smarter recommendations — the engine has been rebuilt to learn what you avoid as well as what you love. Genres and themes you consistently skip now stop being recommended instead of just counting for nothing, dismissing titles teaches it, and a favorite actor in a genre you never watch no longer carries the same weight</li>
              <li style={ITEM_STYLE}>Taste profile quiz — a short quiz in Settings → Taste Profile walks through genres, moods, people, and titles you love or want to avoid, and your answers immediately shape your recommendations</li>
              <li style={ITEM_STYLE}>Jellyfin updates are instant — Diskovarr now listens to Jellyfin's live event stream, so new items appear and requests flip to Available within seconds, just like Plex. Previously Jellyfin was checked every ten minutes</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Search is much faster — results and details are fetched in parallel instead of one at a time, and Diskovarr learns from which results you open</li>
              <li style={ITEM_STYLE}>Jellyfin libraries appear in the admin panel — Synced Libraries lists Jellyfin folders with item counts and their own toggles, Sync Library Now covers both servers, and watched re-sync works for Jellyfin accounts</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Jellyfin favorites no longer silently disappear from the watchlist for linked accounts</li>
              <li style={ITEM_STYLE}>The library cleanup automation can no longer target Jellyfin items</li>
              <li style={ITEM_STYLE}>Explore filters and library search now include Jellyfin titles, shared cards and Wrapped show Jellyfin artwork, and Monitors alert on Jellyfin additions</li>
              <li style={ITEM_STYLE}>The admin panel header no longer collapses into a stacked pile of links</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.7.1{' '}
              <span style={DATE_STYLE}>2026-09-01</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Tapping a poster on a phone could mark it Not Interested — phones treat a tap as a hover, which opened the hidden action row right under your finger. Card actions now only appear on devices with a mouse; on a phone, tapping a poster simply opens its details, where Watchlist and Not Interested still live</li>
              <li style={ITEM_STYLE}>Not Interested can now be undone — the confirmation gets an Undo button that puts the title back where it was</li>
              <li style={ITEM_STYLE}>The back button and Android's back gesture now close the details window instead of leaving the page</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>On phones, the floating profile button in the bottom right is now a menu button at the top left. It opens the same navigation drawer, from the side the drawer actually comes from, using the same icon as the sidebar toggle on desktop</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
