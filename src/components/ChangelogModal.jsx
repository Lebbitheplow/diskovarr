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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '3.3.5'

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
              <span style={DATE_STYLE}>2026-09-23</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>New background — a velvet stage curtain replaces the floating orbs: its folds ripple slowly as if in a draught, the velvet catches the light where they bunch, and a soft spotlight wanders across it, all in your accent colour</li>
              <li style={ITEM_STYLE}>A faint film grain and warm vignette over the whole stage</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.3.4{' '}
              <span style={DATE_STYLE}>2026-09-23</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>New look: Velvet Marquee — cinema-lobby display type, condensed caps on labels and buttons, cream text on a warm stage, and ticket-stub buttons, all driven by your accent colour</li>
              <li style={ITEM_STYLE}>Hero: a slow projector-beam sweep over the key art and a ticket-stub pager that fills with each rotation; the details window slides in on a frosted velvet card</li>
              <li style={ITEM_STYLE}>The page background tints toward your accent colour with no flash on reload</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Search results showed a literal \u2605 instead of a star next to the rating</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.3.3{' '}
              <span style={DATE_STYLE}>2026-09-21</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Movie Night — a new side-rail section for movie nights with your people: create a group (one-off scheduled night, weekly recurring, or always-on rolling list), invite members, nominate movies and shows straight from the details window, and let everyone vote +1/-1 on the pile</li>
              <li style={ITEM_STYLE}>Movie Night rotation — turn on rotation and the app keeps a round-robin of who picks each night (members and personas in order), shows who's next up and their top pick, and moves the cursor on when a title is marked watched</li>
              <li style={ITEM_STYLE}>Personas — extra voters for people sharing an account (kids, partner, the dog): each persona casts its own votes and posts comments under its own name</li>
              <li style={ITEM_STYLE}>Weekday themes, per-title comments, and tonight reminders through your enabled notification channels</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Security: nodemailer upgraded to 9.1.1</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
