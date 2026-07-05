import React from 'react'
import { useTranslation } from 'react-i18next'
import { fmtInt } from './format'

// Slide body: requests / reviews / ratings / reactions on Diskovarr itself.
export default function WrappedActivity({ payload }) {
  const { t } = useTranslation()
  const a = payload.activity

  return (
    <div className="wrapped-stats-grid activity">
      <div className="wrapped-stat-card">
        <div className="wrapped-stat-value">{fmtInt(a.requests)}</div>
        <div className="wrapped-stat-label">{t('requests made')}</div>
      </div>
      <div className="wrapped-stat-card">
        <div className="wrapped-stat-value">{fmtInt(a.reviews)}</div>
        <div className="wrapped-stat-label">{t('reviews written')}</div>
      </div>
      <div className="wrapped-stat-card">
        <div className="wrapped-stat-value">{a.avgRating != null ? `${a.avgRating}★` : '—'}</div>
        <div className="wrapped-stat-label">{t('average rating given')}</div>
      </div>
      <div className="wrapped-stat-card">
        <div className="wrapped-stat-value">{fmtInt(a.reactionsReceived)}</div>
        <div className="wrapped-stat-label">{t('reactions received')}</div>
      </div>
    </div>
  )
}
