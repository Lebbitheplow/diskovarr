import React from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from './shared'
import { hoursOf, fmtInt } from './format'

// Slide body: server-wide leaderboard — real usernames and numbers, deliberately
// not anonymized (unlike wrapperr's obfuscation default).
export default function WrappedLeaderboard({ global, currentUserId }) {
  const { t } = useTranslation()
  if (!global || !global.leaderboard.length) return null

  return (
    <div className="wrapped-leaderboard-wrap">
      <div className="wrapped-leaderboard">
        {global.leaderboard.map((u, i) => (
          <div className={`wrapped-leader-row ${u.userId === currentUserId ? 'me' : ''}`} key={u.userId}>
            <span className="wrapped-leader-rank">{i + 1}</span>
            <Avatar thumb={u.userThumb} name={u.userName} size={36} />
            <span className="wrapped-leader-name">{u.userName}</span>
            <span className="wrapped-leader-hours">{fmtInt(hoursOf(u.seconds))}h</span>
            <span className="wrapped-leader-plays">{fmtInt(u.plays)} {t('plays')}</span>
          </div>
        ))}
      </div>
      <p className="wrapped-caption">
        {t('All together')}: <strong>{fmtInt(hoursOf(global.totals.seconds))}</strong> {t('hours across')} <strong>{global.totals.userCount}</strong> {t('viewers')}
      </p>
    </div>
  )
}
