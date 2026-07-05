import React from 'react'
import { useTranslation } from 'react-i18next'
import { posterSrc, fmtHM, hoursOf, fmtInt } from './format'

// Spotify-style feature slides: one big #1 stat, smaller supporting stats under it.

function FeaturePoster({ thumb }) {
  const src = posterSrc(thumb)
  return src ? (
    <img className="wrapped-feature-poster" src={src} alt="" loading="lazy" />
  ) : (
    <div className="wrapped-feature-poster placeholder">?</div>
  )
}

function TopOneSlide({ items, totalsLine }) {
  const { t } = useTranslation()
  const top = items[0]
  if (!top) return null
  return (
    <div className="wrapped-feature">
      <FeaturePoster thumb={top.thumb} />
      <div className="wrapped-feature-info">
        <span className="wrapped-feature-rank">#1</span>
        <span className="wrapped-feature-title">{top.title}</span>
        <span className="wrapped-feature-meta">{fmtHM(top.seconds)} · {top.plays} {t('plays')}</span>
        <ol className="wrapped-list" start={2}>
          {items.slice(1, 5).map((it) => (
            <li key={it.ratingKey || it.title}>
              <span className="wrapped-list-title">{it.title}</span>
              <span className="wrapped-list-meta">{fmtHM(it.seconds)}</span>
            </li>
          ))}
        </ol>
        <span className="wrapped-feature-total">{totalsLine}</span>
      </div>
    </div>
  )
}

export function TopMovieSlide({ payload }) {
  const { t } = useTranslation()
  const m = payload.totals.movies
  return (
    <TopOneSlide
      items={payload.topMovies.bySeconds}
      totalsLine={`${fmtInt(m.count)} ${t('movies')} · ${fmtInt(hoursOf(m.seconds))}${t('h this year')}`}
    />
  )
}

export function TopShowSlide({ payload }) {
  const { t } = useTranslation()
  const s = payload.totals.shows
  return (
    <TopOneSlide
      items={payload.topShows.bySeconds}
      totalsLine={`${fmtInt(s.count)} ${t('shows')} · ${fmtInt(s.episodes)} ${t('episodes')} · ${fmtInt(hoursOf(s.seconds))}${t('h this year')}`}
    />
  )
}

export function OldestSlide({ payload }) {
  const { t } = useTranslation()
  const o = payload.oldest
  if (!o) return null
  return (
    <div className="wrapped-feature">
      <FeaturePoster thumb={o.thumb} />
      <div className="wrapped-feature-info">
        <span className="wrapped-feature-kicker">{t('The oldest thing you watched')}</span>
        <span className="wrapped-feature-big">{o.year}</span>
        <span className="wrapped-feature-title">{o.title}</span>
        <span className="wrapped-feature-meta">
          {payload.year - o.year} {t('years old when you pressed play')}
        </span>
      </div>
    </div>
  )
}
