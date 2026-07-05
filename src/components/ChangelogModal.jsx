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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.5.1'

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
              <span style={DATE_STYLE}>2026-07-05</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Tuberr comes bundled with Docker — it starts with the Diskovarr container and pairs itself in Admin → Connections automatically; nothing to install or configure by hand</li>
              <li style={ITEM_STYLE}>One-click Sonarr wiring — the Set up Sonarr button creates the tagged indexer and download client in Sonarr for you. Full setup is now: enable the toggle, add a YouTube API key, click Set up Sonarr</li>
              <li style={ITEM_STYLE}>Manage Series moved into the Connections page — YouTube series management opens as a modal from the YouTube (Tuberr) box instead of its own admin tab</li>
              <li style={ITEM_STYLE}>Optional YouTube root folder — send new YouTube series to a dedicated library folder (like /NAS/YT Videos) while regular shows stay where they are</li>
              <li style={ITEM_STYLE}>Tag a series "yt" directly in Sonarr and Tuberr picks it up automatically — it even detects the right source channel by verifying candidate channels against the episode list, and flags anything it can't verify for a manual pick</li>
              <li style={ITEM_STYLE}>Smarter matching for series whose TVDB episodes are just "Episode 11" — numbers and air dates take over when titles carry no signal</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>YouTube requests are locked to Sonarr — they can no longer be rerouted to Overseerr or DUMB from the request dialog, queue edits, or approvals, and DUMB's pull-mode polling no longer sees them</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.0{' '}
              <span style={DATE_STYLE}>2026-07-05</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>YouTube series through Sonarr — the new Tuberr companion service lets Sonarr search and download YouTube web series with yt-dlp, with proper episode naming and live download progress in Sonarr's queue. Series added this way carry a "yt" tag so your normal shows are untouched</li>
              <li style={ITEM_STYLE}>Download via YouTube — TV requests headed to Sonarr get a Torrent / YouTube choice; picking YouTube suggests source channels for the show, or takes a pasted channel URL</li>
              <li style={ITEM_STYLE}>Find shows that aren't on TMDB — search now also checks Sonarr's TVDB lookup, so YouTube-only series show up in results and can be requested; shows already in Plex are recognized by their TVDB id too</li>
              <li style={ITEM_STYLE}>Manage Series — review how episodes were matched to videos, fix a match from the candidate list or a pasted URL, and tell Sonarr to re-grab an episode after correcting it</li>
              <li style={ITEM_STYLE}>Admin → Connections gains a YouTube (Tuberr) section — an enable/disable toggle for the whole feature, YouTube API key, connection test, and step-by-step setup instructions behind the ⓘ icon</li>
              <li style={ITEM_STYLE}>Zero maintenance — Tuberr downloads and keeps yt-dlp updated by itself, and monitored series re-check for new episodes and new uploads every 6 hours, so new episodes download automatically with no manual steps</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.4.0{' '}
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
        </div>
      </div>
    </div>
  )
}
