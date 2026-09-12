import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { tmdbApi } from '../services/api'
import ReviewPost from './ReviewPost'

const TMDB_PREVIEW_CHARS = 420

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function TmdbReview({ review }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const long = review.content.length > TMDB_PREVIEW_CHARS
  const text = expanded || !long ? review.content : review.content.slice(0, TMDB_PREVIEW_CHARS).replace(/\s+\S*$/, '') + '…'
  return (
    <article className="review-post" style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        {review.avatar
          ? <img src={review.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          : <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-dim2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, color: 'var(--accent)', flexShrink: 0 }}>{(review.author || '?')[0].toUpperCase()}</div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{review.author}</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
            {t('on TMDB')}{review.createdAt ? ` · ${fmtDate(review.createdAt)}` : ''}
          </div>
        </div>
        {review.rating != null && (
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' }}>★ {review.rating}/10</span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{text}</p>
      <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: '0.78rem' }}>
        {long && <button type="button" className="review-action-btn" onClick={() => setExpanded(v => !v)}>{expanded ? t('Show less') : t('Read more')}</button>}
        {review.url && <a href={review.url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-muted)' }}>{t('View on TMDB')}</a>}
      </div>
    </article>
  )
}

// Reviews tab in the item detail modal: reviews from users on this server
// (public ones plus your own) followed by TMDB's public reviews. `serverReviews`
// is pre-fetched by the modal so the tab label can carry the count; TMDB
// reviews load lazily when the tab is opened.
export default function ReviewsTab({ mediaType, tmdbId, serverReviews, serverLoading, onWriteReview, posterUrl }) {
  const { t } = useTranslation()
  // { key, reviews, error } — reviews null while loading; the key ties the
  // result to the title so a stale response for the previous item is ignored.
  const key = `${mediaType}:${tmdbId}`
  const [tmdbState, setTmdbState] = useState({ key: null, reviews: null, error: null })
  const tmdb = tmdbState.key === key ? tmdbState.reviews : null
  const tmdbError = tmdbState.key === key ? tmdbState.error : null

  useEffect(() => {
    let cancelled = false
    const done = (reviews, error) => { if (!cancelled) setTmdbState({ key, reviews, error }) }
    if (!tmdbId) done([], null)
    else tmdbApi.getReviews(mediaType, tmdbId)
      .then(r => done(r.data?.reviews || [], null))
      .catch(e => done([], e?.message || 'TMDB reviews unavailable'))
    return () => { cancelled = true }
  }, [key, mediaType, tmdbId])

  const server = (serverReviews || []).map(r => (r.posterUrl || !posterUrl ? r : { ...r, posterUrl }))

  return (
    <div className="reviews-tab" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 12 }}>
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h4 style={{ margin: 0, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
            {t('From this server')}{server.length ? ` · ${server.length}` : ''}
          </h4>
          {onWriteReview && <button type="button" className="review-action-btn" onClick={onWriteReview}>{t('Write a review')}</button>}
        </div>
        {serverLoading && !server.length && <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('Loading…')}</div>}
        {!serverLoading && !server.length && (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('Nobody on this server has reviewed this yet.')}</div>
        )}
        {server.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {server.map(r => <ReviewPost key={r.id} review={r} onOpenMediaModal={() => {}} />)}
          </div>
        )}
      </section>

      <section>
        <h4 style={{ margin: '0 0 8px', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
          {t('From TMDB')}{tmdb?.length ? ` · ${tmdb.length}` : ''}
        </h4>
        {tmdb === null && <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('Loading…')}</div>}
        {tmdbError && <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{tmdbError}</div>}
        {tmdb && tmdb.length === 0 && !tmdbError && (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('No TMDB reviews for this title.')}</div>
        )}
        {tmdb && tmdb.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {tmdb.map(r => <TmdbReview key={r.id} review={r} />)}
          </div>
        )}
      </section>
    </div>
  )
}
