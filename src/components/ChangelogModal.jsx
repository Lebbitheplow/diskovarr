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
  const currentVersion = import.meta.env.VITE_APP_VERSION || '3.3.4'

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
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.3.2{' '}
              <span style={DATE_STYLE}>2026-09-13</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('Changes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>ntfy is an admin feed again — the per-user ntfy panel asked users to subscribe to topics on the admin's server, which needs an account there; like Gotify, Slack and Webhook, ntfy now lives only in Admin → Notifications, and users keep Discord, Pushover, Telegram, Pushbullet, Email and Browser push</li>
            </ul>
          </div>
          <div className="info-modal-section">
            <div className="info-modal-section-title">
              v3.3.1{' '}
              <span style={DATE_STYLE}>2026-09-13</span>
            </div>
            <p style={SECTION_LABEL_STYLE}>{t('New')}</p>
            <ul style={LIST_STYLE}>
              <li style={ITEM_STYLE}>Notifications for everyone — users now get ntfy (your own topic, optional server and login) and Browser push (native notifications from any device you enable, even with Diskovarr closed) under My Settings → Notifications whenever the admin has those channels on, alongside Discord, Pushover, Telegram, Pushbullet and Email</li>
              <li style={ITEM_STYLE}>Install Diskovarr as an app — the user menu offers Install App with the native browser prompt where available, or step-by-step Add to Home Screen instructions for iPhone, iPad, Safari on Mac, Firefox and Samsung Internet</li>
              <li style={ITEM_STYLE}>Browse by Genre — new artwork tiles on Home (filtering your library on Discover) and on Explore (searching TMDB)</li>
            </ul>
            <p style={SECTION_LABEL_STYLE}>{t('Fixes')}</p>
            <ul style={LIST_STYLE_LAST}>
              <li style={ITEM_STYLE}>Telegram, Pushbullet and Email user settings never actually received request, issue or monitor notifications — every event now reaches every enabled channel</li>
              <li style={ITEM_STYLE}>Turning a notification provider on in the admin panel took effect only after a restart, and its green status dot didn't update until the page was reloaded</li>
              <li style={ITEM_STYLE}>The elevated owner now sees the same admin-only notification toggles (processing failed, new issue) that admins do; regular users can no longer flip them</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
