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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '2.5.5'

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
              <span style={DATE_STYLE}>2026-08-11</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Library items now use separate movie_id and tv_id columns instead of a single shared id — a show can no longer be misregistered in the library because it shared the same id value as a movie in a different context</li>
              <li style={ITEM_STYLE}>Fixed the last sync date on libraries in the admin panel — the timestamp was broken and no longer reflected the actual sync time</li>
              <li style={ITEM_STYLE}>Periodic reconciliation now includes all libraries — previously some libraries were skipped during the reconciliation process</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.4{' '}
              <span style={DATE_STYLE}>2026-07-12</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Non-Chrome browsers now get a heads-up when opening the cast menu — casting needs local network access, which only Chrome and Edge support, so if casting fails, try Chrome. Shown once per session</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Requesting a YouTube show no longer asks you to pick between Torrent and YouTube — YouTube series open straight into channel selection with the YouTube downloader preselected (Sonarr/torrent still available as an alternate), and regular shows never see the YouTube option anymore</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v2.5.3{' '}
              <span style={DATE_STYLE}>2026-07-06</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Cast to your TV from anywhere — casting now works for users outside the server's household. Your browser sends the play command straight to your TV, so be on the same Wi-Fi as the TV and allow local network access if your browser asks. Chrome and Edge work best; iPhone/iPad browsers can't reach TVs yet, so use the Plex app there</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Cast playback now streams from the server's public address instead of its LAN address, so TVs outside the server's network can actually play what you cast</li>
              <li style={ITEM_STYLE}>Cast errors now say what went wrong — wrong network, Plex app closed, or a device that can't be remote-controlled — instead of a cryptic "operation was aborted" timeout</li>
              <li style={ITEM_STYLE}>The device button shows "Casting…" while the command is being delivered</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
