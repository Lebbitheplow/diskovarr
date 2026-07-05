import React from 'react'
import { useTranslation } from 'react-i18next'
import { hoursOf, fmtInt } from './format'

// Slide body: the headline numbers of the year.
export default function WrappedHero({ payload }) {
  const { t } = useTranslation()
  const totals = payload.totals
  const hours = hoursOf(totals.seconds)

  return (
    <div className="wrapped-hero">
      <div className="wrapped-hero-number">{fmtInt(hours)}</div>
      <div className="wrapped-hero-label">{t('hours watched in')} {payload.year}</div>
      <div className="wrapped-stats-grid">
        <div className="wrapped-stat-card">
          <div className="wrapped-stat-value">{fmtInt(totals.plays)}</div>
          <div className="wrapped-stat-label">{t('plays')}</div>
        </div>
        <div className="wrapped-stat-card">
          <div className="wrapped-stat-value">{fmtInt(totals.distinctTitles)}</div>
          <div className="wrapped-stat-label">{t('different titles')}</div>
        </div>
        <div className="wrapped-stat-card">
          <div className="wrapped-stat-value">{fmtInt(totals.movies.count)}</div>
          <div className="wrapped-stat-label">{t('movies')} · {hoursOf(totals.movies.seconds)}h</div>
        </div>
        <div className="wrapped-stat-card">
          <div className="wrapped-stat-value">{fmtInt(totals.shows.count)}</div>
          <div className="wrapped-stat-label">{t('shows')} · {hoursOf(totals.shows.seconds)}h</div>
        </div>
        <div className="wrapped-stat-card">
          <div className="wrapped-stat-value">{totals.completionRate}%</div>
          <div className="wrapped-stat-label">{t('completion rate')}</div>
        </div>
      </div>
    </div>
  )
}
