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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '3.1.1'

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
              <span style={DATE_STYLE}>2026-09-12</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Diskovarr can now run your whole collection setup — everything Agregarr did. Monitored lists gained a top-N item cap, per-list and global exclusions, combining several list URLs into one collection, "unwatched only" smart collections, item ordering, home and library ordering, owner-only home visibility, a first/latest season mode for TV requests, and an optional summary. An import script moves an Agregarr config over in one go</li>
              <li style={ITEM_STYLE}>Plex Home Layout — every row Plex shows on the home and Recommended tab of each library, with owner/users/Recommended toggles and ordering, re-applied after every sync</li>
              <li style={ITEM_STYLE}>New list sources: FlixPatrol streaming top 10s (via FlareSolverr), TMDB trending, AniList's most popular anime, and Hulu/Paramount+ charts from TMDB</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Collections pick up newly added library titles every 30 minutes without re-fetching the list; a Quick sync button does it on demand</li>
              <li style={ITEM_STYLE}>Security: nodemailer upgraded to 9.1.0</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>The recommender no longer mixes up a movie and a show that share a TMDB id — the last trace of the mix-up that once put Lord of the Rings art on a Doctor Who notification</li>
              <li style={ITEM_STYLE}>"Request missing seasons" only appears when the show actually has a season left to request</li>
              <li style={ITEM_STYLE}>Monitored-list syncs no longer fail before requesting anything (a wrong module path in the auto-request job)</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.1.0{' '}
              <span style={DATE_STYLE}>2026-09-06</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Request missing seasons — shows already in your library now offer a "Request missing seasons" button in the details window and on search cards. The season picker grays out seasons that are complete in the library or already requested (hover for the episode count), so you only ask for what's actually missing</li>
              <li style={ITEM_STYLE}>Requesting a show Sonarr already has now works — the existing series gets the chosen seasons monitored and a search is started, instead of the request failing</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Search is much faster — results appear from what Diskovarr already knows while full details fill in behind the scenes, a slow TVDB lookup no longer holds up the page, and "More Like This" loads in parallel. Searches that took four or five seconds now come back in well under one</li>
              <li style={ITEM_STYLE}>Security: the web framework was upgraded to Express 5 in both Diskovarr and the bundled YouTube downloader, closing two query-parsing advisories</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Requesting missing seasons of a show you already have no longer triggers an immediate "now available" alert</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.0.1{' '}
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
        </div>
      </div>
    </div>
  )
}
