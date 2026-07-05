import React from 'react'
import { useTranslation } from 'react-i18next'
import { WEEKDAYS, MONTHS, fmtHourLabel, hoursOf } from './format'

// Slide body: month-by-month chart + most-active weekday/hour.
export default function WrappedTimeStats({ payload }) {
  const { t } = useTranslation()
  const time = payload.time
  const max = Math.max(...time.months, 1)

  return (
    <div className="wrapped-time">
      <div className="wrapped-months" role="img" aria-label={t('Watch time by month')}>
        {time.months.map((s, i) => (
          <div className="wrapped-month-col" key={MONTHS[i]} title={`${MONTHS[i]}: ${hoursOf(s)}h`}>
            <div
              className={`wrapped-month-bar ${s === max ? 'peak' : ''}`}
              style={{ height: `${Math.max(4, Math.round((s / max) * 100))}%` }}
            />
            <span className="wrapped-month-label">{MONTHS[i]}</span>
          </div>
        ))}
      </div>
      {time.peakWeekday != null && (
        <p className="wrapped-caption">
          {t('Most active on')} <strong>{WEEKDAYS[time.peakWeekday]}s</strong> {t('around')} <strong>{fmtHourLabel(time.peakHour)}</strong>
        </p>
      )}
    </div>
  )
}
