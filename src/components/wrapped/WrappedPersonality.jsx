import React from 'react'
import { useTranslation } from 'react-i18next'
import { fmtInt } from './format'

// Slide body: the genre-derived archetype + behavioral trait chips.
export function PersonalitySlide({ payload }) {
  const { t } = useTranslation()
  const per = payload.personality
  if (!per) return null
  return (
    <div className="wrapped-center-stack">
      <div className="wrapped-hero-label">{t('Your Diskovarr personality is')}</div>
      <div className="wrapped-hero-number genre">{per.title}</div>
      <p className="wrapped-personality-blurb">{per.blurb}</p>
      {per.traits.length > 0 && (
        <div className="wrapped-trait-chips">
          {per.traits.map((tr) => (
            <span className="wrapped-trait-chip" key={tr.key} title={tr.desc}>
              {tr.label}
              <em>{tr.desc}</em>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// Slide body: the year in reviews — count big, favorites/harshest under it.
export function ReviewsSlide({ payload }) {
  const { t } = useTranslation()
  const r = payload.reviews
  if (!r) return null
  const row = (label, review) => review && (
    <div className="wrapped-review-row" key={label}>
      <span className="wrapped-review-label">{label}</span>
      <span className="wrapped-review-title">{review.title}</span>
      <span className="wrapped-review-rating">{review.rating}★</span>
      {review.reactions > 0 && <span className="wrapped-review-reactions">♥ {review.reactions}</span>}
    </div>
  )
  return (
    <div className="wrapped-center-stack">
      <div className="wrapped-hero-number">{fmtInt(r.count)}</div>
      <div className="wrapped-hero-label">
        {r.count === 1 ? t('review written') : t('reviews written')} · {t('average rating')} <strong>{r.avgRating}★</strong>
      </div>
      <div className="wrapped-review-rows">
        {row(t('Favorite'), r.highest)}
        {row(t('Harshest take'), r.lowest)}
        {row(t('Most loved'), r.mostLoved)}
      </div>
    </div>
  )
}
