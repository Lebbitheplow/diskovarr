import React, { useState, useEffect, useCallback } from 'react'
import { reviewsApi, searchApi, tmdbApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import ShareModal from './ShareModal'
import { useTranslation } from 'react-i18next'

// Letterboxd-style rating: 5 stars, each selectable in half-star increments.
// The left half of a star selects X.5 below the whole; the right half selects
// the whole star. Clicking the current value again clears the rating.
function StarRating({ value, onChange, readOnly = false, size = 28 }) {
  const [hover, setHover] = useState(0)
  const display = hover || value

  const setVal = (val) => {
    if (readOnly) return
    onChange(value === val ? 0 : val)
  }

  return (
    <div
      className="star-rating"
      style={{ display: 'flex', gap: '4px', alignItems: 'center' }}
      onMouseLeave={() => !readOnly && setHover(0)}
    >
      {Array.from({ length: 5 }, (_, i) => {
        const fullVal = i + 1
        const halfVal = fullVal - 0.5
        const filledFull = display >= fullVal
        const filledHalf = !filledFull && display >= halfVal
        return (
          <span
            key={i}
            className="star-wrap"
            style={{ position: 'relative', display: 'inline-block', width: `${size}px`, height: `${size}px`, lineHeight: `${size}px`, fontSize: `${size}px` }}
          >
            <span style={{ position: 'absolute', inset: 0, color: 'var(--text-muted)', opacity: readOnly ? 1 : 0.6 }}>★</span>
            {(filledFull || filledHalf) && (
              <span style={{ position: 'absolute', inset: 0, width: filledHalf ? '50%' : '100%', overflow: 'hidden', color: 'var(--accent)' }}>★</span>
            )}
            {!readOnly && (
              <>
                <button
                  type="button"
                  aria-label={`${halfVal} stars`}
                  onMouseEnter={() => setHover(halfVal)}
                  onClick={() => setVal(halfVal)}
                  style={{ position: 'absolute', top: 0, left: 0, width: '50%', height: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                />
                <button
                  type="button"
                  aria-label={`${fullVal} stars`}
                  onMouseEnter={() => setHover(fullVal)}
                  onClick={() => setVal(fullVal)}
                  style={{ position: 'absolute', top: 0, right: 0, width: '50%', height: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                />
              </>
            )}
          </span>
        )
      })}
      <span style={{ marginLeft: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', minWidth: '28px' }}>
        {display > 0 ? display.toFixed(1) : '—'}
      </span>
    </div>
  )
}

function fmtWatchedDate(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function ReviewModal({ onClose, historyItem, onSave }) {
  const { t } = useTranslation()
  const { success: toastSuccess, error: toastError } = useToast()
  const { user } = useAuth()
  // After a successful save we keep the modal open on a "posted" success panel
  // (social-app style) instead of closing immediately.
  const [postedId, setPostedId] = useState(null)
  const [showShare, setShowShare] = useState(false)

  const isEpisode = historyItem?.mediaType === 'episode'
  const reviewMediaType = isEpisode ? 'tv' : (historyItem?.mediaType === 'show' ? 'tv' : 'movie')
  const reviewTmdbId = historyItem?.tmdbId
  // Fallback identity for library items with no TMDB match (keyed by Plex rating_key).
  const reviewRatingKey = historyItem?.reviewRatingKey || historyItem?.ratingKey || null
  // Items with no TMDB id are reviewed via their Plex rating_key; the history
  // endpoint attaches the existing review inline, so seed initial state from it.
  const seededReview = (!reviewTmdbId && reviewRatingKey && historyItem?.review) ? historyItem.review : null

  // This modal mounts fresh each time it opens (parent renders it conditionally),
  // so initial state is seeded directly from the watch-history row — the Plex data
  // already carries title/poster/year, and a TMDB lookup enriches it below.
  const [loading, setLoading] = useState(!!reviewTmdbId)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [mediaInfo, setMediaInfo] = useState(() => ({
    posterUrl: historyItem?.posterUrl || null,
    title: historyItem?.parentTitle || historyItem?.title || 'Unknown',
    year: historyItem?.year || null,
    contentRating: historyItem?.contentRating || '',
  }))

  const [rating, setRating] = useState(seededReview?.rating || 0)
  const [reviewText, setReviewText] = useState(seededReview?.reviewText || '')
  const [spoiler, setSpoiler] = useState(!!seededReview?.spoiler)
  const [rewatch, setRewatch] = useState(!!seededReview?.rewatch)
  const [pushToTmdb, setPushToTmdb] = useState(false)
  const [tmdbConnected, setTmdbConnected] = useState(false)
  const [tmdbSyncing, setTmdbSyncing] = useState(false)
  // Star rating last successfully pushed to TMDB for this review (null = never).
  const [tmdbSyncedRating, setTmdbSyncedRating] = useState(null)

  useEffect(() => {
    // Only TMDB-backed items need the async lookup; rating-key items are seeded above.
    if (!reviewTmdbId) return
    let active = true
    Promise.all([
      reviewsApi.getReview(reviewMediaType, reviewTmdbId).catch(() => null),
      searchApi.getDetails(reviewTmdbId, reviewMediaType).catch(() => null),
    ]).then(([reviewRes, detailsRes]) => {
      if (!active) return
      const review = reviewRes?.data || null
      const details = detailsRes?.data || null

      if (review) {
        setRating(review.rating)
        setReviewText(review.reviewText || '')
        setSpoiler(review.spoiler || false)
        setRewatch(review.rewatch || false)
        setTmdbSyncedRating(review.tmdbSyncedRating ?? null)
      }

      if (details) {
        setMediaInfo(prev => ({
          posterUrl: details.posterUrl || prev?.posterUrl || null,
          title: details.title || prev?.title || 'Unknown',
          year: details.year || prev?.year || null,
          contentRating: details.contentRating || prev?.contentRating || '',
        }))
      }
      setLoading(false)
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [reviewMediaType, reviewTmdbId])

  // Load TMDB connection status
  useEffect(() => {
    tmdbApi.getConnection().then(({ data }) => {
      setTmdbConnected(data?.connected && data?.status !== 'needs_reconnect')
      setPushToTmdb(false)
    }).catch(() => {
      setTmdbConnected(false)
      setPushToTmdb(false)
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (rating === 0) {
      toastError(t('Please select a star rating'))
      return
    }
    setSaving(true)
    try {
      // Find an existing review to update: by TMDB id, or (for rating_key items)
      // from the inline review the history endpoint already attached.
      const existingId = reviewTmdbId
        ? (await reviewsApi.getReview(reviewMediaType, reviewTmdbId).catch(() => null))?.data?.id
        : (historyItem?.review?.id || null)
      const payload = {
        mediaType: reviewMediaType,
        tmdbId: reviewTmdbId || null,
        ratingKey: reviewTmdbId ? null : reviewRatingKey,
        title: mediaInfo?.title || historyItem?.parentTitle || historyItem?.title || '',
        year: mediaInfo?.year || historyItem?.year || null,
        rating,
        reviewText,
        spoiler,
        rewatch,
        watchedDate: historyItem?.watchedAt || Math.floor(Date.now() / 1000),
      }

      let reviewId
      if (existingId) {
        await reviewsApi.updateReview(existingId, payload)
        reviewId = existingId
        toastSuccess(t('Review updated'))
      } else {
        const created = await reviewsApi.createReview(payload)
        reviewId = created?.data?.id
        toastSuccess(t('Review saved'))
      }

      // Push rating to TMDB if requested
      if (pushToTmdb && tmdbConnected && reviewId) {
        setTmdbSyncing(true)
        try {
          await tmdbApi.syncRating(reviewId)
        } catch (syncErr) {
          if (syncErr?.status === 401) {
            toastError(t('TMDB session expired. Reconnect in Settings.'))
            setTmdbConnected(false)
          } else if (syncErr?.status === 429) {
            toastError(t('TMDB rate limited. Rating saved locally.'))
          } else {
            toastError(t('Failed to push to TMDB. Rating saved locally.'))
          }
        } finally {
          setTmdbSyncing(false)
        }
      }

      onSave?.()
      // Reload history behind the modal, then surface the share success panel.
      if (reviewId) setPostedId(reviewId)
      else onClose()
    } catch (e) {
      toastError(e.message || t('Failed to save review'))
    }
    setSaving(false)
  }, [rating, reviewText, spoiler, rewatch, reviewMediaType, reviewTmdbId, reviewRatingKey, historyItem, mediaInfo, onSave, onClose, toastSuccess, toastError, pushToTmdb, tmdbConnected, t])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      const existingId = reviewTmdbId
        ? (await reviewsApi.getReview(reviewMediaType, reviewTmdbId).catch(() => null))?.data?.id
        : (historyItem?.review?.id || null)
      if (existingId) {
        await reviewsApi.deleteReview(existingId)
        toastSuccess(t('Review deleted'))
        onSave?.()
      }
      onClose()
    } catch (e) {
      toastError(e.message || t('Failed to delete review'))
    }
    setDeleting(false)
  }, [reviewMediaType, reviewTmdbId, historyItem, onSave, onClose, toastSuccess, toastError, t])


  const hasReview = rating > 0 || reviewText.trim()

  const copyPostedLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/review/${postedId}`)
      toastSuccess(t('Review link copied!'))
    } catch { toastError(t('Copy failed')) }
  }, [postedId, toastSuccess, toastError, t])

  const downloadPostedImage = useCallback(async () => {
    try {
      const res = await fetch(`/og/review/${postedId}.png`)
      if (!res.ok) throw new Error('fetch failed')
      const href = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = href; a.download = `diskovarr-review-${postedId}.png`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href)
    } catch { toastError(t('Could not download image')) }
  }, [postedId, toastError, t])

  const postBtn = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    padding: '11px 14px', borderRadius: '10px', border: '1px solid var(--border)',
    background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer',
    fontSize: '0.9rem', fontWeight: 500,
  }

  return (
    <div className="modal-backdrop open" onClick={onClose}>
      <div className="modal-card review-modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('Close')}>✕</button>

        {postedId ? (
          <div style={{ textAlign: 'center', padding: '8px 4px' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', fontSize: '1.7rem' }}>✓</div>
            <h2 style={{ margin: '0 0 6px', fontSize: '1.2rem', fontWeight: 700 }}>{t('Review posted successfully')}</h2>
            <p style={{ margin: '0 0 22px', color: 'var(--text-secondary)', fontSize: '0.88rem' }}>{mediaInfo?.title}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '320px', margin: '0 auto' }}>
              <button onClick={() => setShowShare(true)} style={{ ...postBtn, background: 'var(--accent)', color: '#000', border: 'none', fontWeight: 600 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>
                {t('Share Review')}
              </button>
              <button onClick={copyPostedLink} style={postBtn}>{t('Copy Link')}</button>
              <button onClick={downloadPostedImage} style={postBtn}>{t('Download Share Image')}</button>
              <button onClick={onClose} style={{ ...postBtn, background: 'transparent', color: 'var(--text-secondary)' }}>{t('Close')}</button>
            </div>
          </div>
        ) : loading ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('Loading...')}</div>
        ) : (
          <>
            <div className="review-modal-header">
              {mediaInfo?.posterUrl && (
                <img className="review-modal-poster" src={mediaInfo.posterUrl} alt="" loading="lazy" />
              )}
              <div className="review-modal-info">
                <h2 className="review-modal-title" style={{ margin: '0 0 4px', fontSize: '1.15rem', fontWeight: '700' }}>
                  {mediaInfo?.title || 'Unknown'}
                </h2>
                <div className="review-modal-meta" style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {mediaInfo?.year && <span>{mediaInfo.year}</span>}
                  {mediaInfo?.contentRating && <span className="content-rating-badge" style={{ display: 'inline-block', padding: '1px 6px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: '600', background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>{mediaInfo.contentRating}</span>}
                </div>
                <div className="review-watched-date" style={{ marginTop: '8px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  Watched: {fmtWatchedDate(historyItem?.watchedAt)}
                </div>
                <div style={{ marginTop: '12px' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {t('Your Rating')}
                  </div>
                  <StarRating value={rating} onChange={setRating} />
                </div>
                {tmdbConnected && reviewTmdbId && rating > 0 && (() => {
                  // Locked = already pushed and rating unchanged → checked + disabled.
                  // ratingChanged = pushed before but rating now differs → actionable
                  // "Update TMDB review" checkbox. Otherwise the normal opt-in push.
                  const synced = tmdbSyncedRating != null
                  const ratingChanged = synced && rating !== tmdbSyncedRating
                  const locked = synced && !ratingChanged
                  const label = locked ? 'Rating pushed to TMDB' : ratingChanged ? 'Update TMDB rating' : 'Push rating to TMDB'
                  return (
                    <div style={{ marginTop: '12px' }}>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '0.82rem', color: 'var(--text-secondary)', cursor: locked ? 'default' : 'pointer', userSelect: 'none', opacity: locked ? 0.7 : 1 }}>
                        <input
                          type="checkbox"
                          checked={locked ? true : pushToTmdb}
                          disabled={locked || tmdbSyncing}
                          onChange={e => setPushToTmdb(e.target.checked)}
                          style={{ accentColor: 'var(--accent)', width: '16px', height: '16px', marginTop: '2px', flexShrink: 0 }}
                        />
                        <span>
                          {label}
                          {tmdbSyncing && <span style={{ marginLeft: '6px', opacity: 0.6 }}>(syncing...)</span>}
                        </span>
                      </label>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px', marginLeft: '24px' }}>
                        {locked
                          ? 'Your rating is already on TMDB. Change your rating to push an update.'
                          : ratingChanged
                            ? 'Your TMDB rating changed — check to update it on your profile.'
                            : 'Only your star rating will be sent. Review text and watch date stay local.'}
                      </div>
                    </div>
                  )
                })()}
              </div>
            </div>

            <div className="review-modal-body" style={{ marginTop: '16px' }}>
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '0.78rem', fontWeight: '600', color: 'var(--text-secondary)', display: 'block', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {t('Review')}
                </label>
                <textarea
                  className="review-textarea"
                  placeholder={t('Write your review...')}
                  rows="4"
                  maxLength={2000}
                  value={reviewText}
                  onChange={e => setReviewText(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text)',
                    fontSize: '0.88rem',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                    lineHeight: 1.5,
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ textAlign: 'right', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {reviewText.length}/2000
                </div>
              </div>

              <div className="review-toggles" style={{ display: 'flex', gap: '16px', marginBottom: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={spoiler}
                    onChange={e => setSpoiler(e.target.checked)}
                    style={{ accentColor: 'var(--accent)', width: '16px', height: '16px' }}
                  />
                  {t('Contains spoilers')}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    checked={rewatch}
                    onChange={e => setRewatch(e.target.checked)}
                    style={{ accentColor: 'var(--accent)', width: '16px', height: '16px' }}
                  />
                  {t('Would rewatch')}
                </label>
              </div>

              {spoiler && reviewText.trim() && (
                <div style={{ background: 'rgba(255,82,82,0.08)', border: '1px solid rgba(255,82,82,0.2)', borderRadius: '6px', padding: '8px 12px', fontSize: '0.78rem', color: '#ff5252', marginBottom: '12px' }}>
                  {t('⚠ Review marked as containing spoilers')}
                </div>
              )}

              {!reviewTmdbId && !reviewRatingKey && (
                <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', padding: '8px 12px', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  Not matched to a library item — can't save a review for this entry.
                </div>
              )}

              <div className="review-modal-actions" style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {hasReview && !deleteConfirm && (
                  <button
                    className="btn-queue-delete"
                    onClick={() => setDeleteConfirm(true)}
                    style={{ fontSize: '0.82rem', padding: '6px 14px' }}
                  >
                    {t('Delete')}
                  </button>
                )}
                {deleteConfirm ? (
                  <>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', alignSelf: 'center', marginRight: 'auto' }}>{t('Delete this review?')}</span>
                    <button className="edit-modal-cancel" onClick={() => setDeleteConfirm(false)}>{t('Cancel')}</button>
                    <button className="btn-queue-delete" onClick={handleDelete} disabled={deleting}>
                      {deleting ? 'Deleting...' : 'Confirm Delete'}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="edit-modal-cancel" onClick={onClose}>{t('Cancel')}</button>
                    <button
                      className="edit-modal-save"
                      onClick={handleSave}
                      disabled={saving || rating === 0 || !reviewTmdbId}
                      style={{ opacity: (rating === 0 || !reviewTmdbId) ? 0.5 : 1 }}
                    >
                      {saving ? 'Saving...' : 'Save Review'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {showShare && postedId && (
        <ShareModal
          reviewId={postedId}
          review={{ title: mediaInfo?.title, username: user?.username, rating, reviewText, spoiler }}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  )
}
