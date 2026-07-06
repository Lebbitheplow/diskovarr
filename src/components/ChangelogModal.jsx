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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.5.2'

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
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Series tagged "yt" in Sonarr are now picked up by Tuberr within about 15 minutes instead of waiting for the 6-hour refresh cycle</li>
              <li style={ITEM_STYLE}>Fixed channel auto-detection skipping brand-new series — episodes are synced from Sonarr first, so tagging a series goes from tag to detected channel and matched episodes in a single pass</li>
              <li style={ITEM_STYLE}>Missing monitored episodes now download automatically — after matching, Tuberr tells Sonarr to search everything that's matched, monitored, and missing (Sonarr never searches back-catalog on its own). Fixing a match manually also triggers the search</li>
              <li style={ITEM_STYLE}>Smarter matching when video titles carry extra noise like guest names or console suffixes — AVGN's "ToeJam & Earl" now matches its "ToeJam & Earl with Scott the Woz" video</li>
              <li style={ITEM_STYLE}>Back-catalog searches are batched (25 per cycle) so a big new series no longer floods your regular indexers and bogs down Sonarr's Activity page — the rest queue up automatically</li>
              <li style={ITEM_STYLE}>Download progress now shows live in Sonarr's Activity queue — a yt-dlp flag conflict had been suppressing it, leaving items at 0% until they finished</li>
              <li style={ITEM_STYLE}>Failed downloads no longer clog Sonarr's queue at 0% — Sonarr now sees them as failed, removes them, and moves on</li>
              <li style={ITEM_STYLE}>Age-restricted videos download too — paste YouTube cookies from a signed-in session into the new box in the YouTube settings; previously failed episodes retry on their own</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.1{' '}
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
        </div>
      </div>
    </div>
  )
}
