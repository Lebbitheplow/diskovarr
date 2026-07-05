import React from 'react'
import { useTranslation } from 'react-i18next'

// Slide body: seconds-weighted genre bars.
export default function WrappedGenres({ payload }) {
  const { t } = useTranslation()
  const genres = payload.genres.slice(0, 6)
  if (!genres.length) return null
  const max = genres[0].seconds || 1

  return (
    <div className="wrapped-genres wrapped-center-stack">
      <div className="wrapped-hero-label">{t('Your year looked a lot like')}</div>
      <div className="wrapped-hero-number genre">{genres[0].name}</div>
      <div className="wrapped-bars">
        {genres.slice(1).map((g) => (
          <div className="wrapped-bar-row" key={g.name}>
            <span className="wrapped-bar-label">{g.name}</span>
            <div className="wrapped-bar-track">
              <div className="wrapped-bar-fill" style={{ width: `${Math.max(4, Math.round((g.seconds / max) * 100))}%` }} />
            </div>
            <span className="wrapped-bar-value">{g.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}
