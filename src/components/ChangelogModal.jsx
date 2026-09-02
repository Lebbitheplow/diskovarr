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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '3.0.0'

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
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.7.0{' '}
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
        </div>
      </div>
    </div>
  )
}
