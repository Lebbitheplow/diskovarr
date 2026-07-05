import React from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar } from './shared'
import { fmtInt, hoursOf, fmtDayLong } from './format'

// Slide bodies for the "fun" stats — one component per story slide.

export function BingeSlide({ payload }) {
  const { t } = useTranslation()
  const { bingeDay, streak } = payload.time
  return (
    <div className="wrapped-duo">
      {bingeDay && (
        <div className="wrapped-big-fact">
          <div className="wrapped-big-fact-value">{hoursOf(bingeDay.seconds)}h</div>
          <div className="wrapped-big-fact-label">{t('hours in one day')}</div>
          <p>{fmtDayLong(bingeDay.date)} — {bingeDay.plays} {t('plays')}. {t('Your biggest binge.')}</p>
        </div>
      )}
      {streak && (
        <div className="wrapped-big-fact">
          <div className="wrapped-big-fact-value">{fmtInt(streak.days)}</div>
          <div className="wrapped-big-fact-label">{streak.days === 1 ? t('day streak') : t('days in a row')}</div>
          <p>{fmtDayLong(streak.start)} – {fmtDayLong(streak.end)}. {t('Not a single day missed.')}</p>
        </div>
      )}
    </div>
  )
}

export function PercentileSlide({ payload }) {
  const { t } = useTranslation()
  const pc = payload.percentile
  const fan = pc.topShow
  return (
    <div className="wrapped-center-stack">
      <div className="wrapped-hero-number">{t('Top')} {pc.viewer}%</div>
      <div className="wrapped-hero-label">{t('of all viewers on this server')}</div>
      <p className="wrapped-caption">#{pc.rank} {t('of')} {fmtInt(pc.userCount)} {t('by hours watched')}</p>
      {fan && fan.watcherCount > 1 && (
        <p className="wrapped-caption">
          {t('And you were in the top')} <strong>{fan.pct}%</strong> {t('of')} <strong>{fan.title}</strong> {t('fans')} (#{fan.rank} {t('of')} {fan.watcherCount})
        </p>
      )}
    </div>
  )
}

export function TasteAgeSlide({ payload }) {
  const { t } = useTranslation()
  const d = payload.decade
  if (!d.eligible) return null
  // Fallback for payloads cached before `age` existed.
  const age = d.age ?? (payload.year - (d.peakYear - 18))
  const max = Math.max(...d.distribution.map((x) => x.pct), 1)
  return (
    <div className="wrapped-center-stack">
      <div className="wrapped-hero-label">{t('Judging by what you watched, your taste age is')}</div>
      <div className="wrapped-hero-number">{age}</div>
      <div className="wrapped-decade-dist">
        {d.distribution.map((x) => (
          <div className="wrapped-decade-col" key={x.decade} title={`${x.decade}s: ${x.pct}%`}>
            <div
              className={`wrapped-decade-bar ${x.decade === Math.floor(d.peakYear / 10) * 10 ? 'peak' : ''}`}
              style={{ height: `${Math.max(6, Math.round((x.pct / max) * 90))}px` }}
            />
            <span>{String(x.decade).slice(2)}s</span>
          </div>
        ))}
      </div>
      <p className="wrapped-caption">
        {t('Nostalgia peak')}: <strong>{d.peakYear}</strong> · {t('taste born in the')} <strong>{d.decade}s</strong>
      </p>
    </div>
  )
}

export function BuddySlide({ payload }) {
  const { t } = useTranslation()
  const b = payload.buddy
  if (!b) return null
  return (
    <div className="wrapped-center-stack">
      <div className="wrapped-buddy-avatars big">
        <Avatar thumb={payload.user.thumb} name={payload.user.name} size={84} />
        <span className="wrapped-buddy-plus">+</span>
        <Avatar thumb={b.userThumb} name={b.userName} size={84} />
      </div>
      <div className="wrapped-hero-label">{t('Your show buddy is')} <strong>{b.userName}</strong></div>
      <p className="wrapped-caption">
        {t('Nobody matched your watch time on')} <strong>{b.showTitle}</strong>
      </p>
      <p className="wrapped-caption">{hoursOf(b.mySeconds)}h {t('you')} · {hoursOf(b.theirSeconds)}h {t('them')}</p>
    </div>
  )
}
