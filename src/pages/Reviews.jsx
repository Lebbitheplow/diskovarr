import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { socialReviewsApi, followApi, searchApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import ReviewPost from '../components/ReviewPost'
import DetailModal from '../components/DetailModal'
import SkeletonLoader from '../components/SkeletonLoader'
import { useTranslation } from 'react-i18next'

const PER_PAGE = 20

export default function Reviews() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { error: toastError } = useToast()
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState(false)
  const sentinelRef = useRef(null)
  const [selectedMedia, setSelectedMedia] = useState(null)

  const loadFeed = useCallback(async (pageNum, append = false) => {
    try {
      const { data } = await socialReviewsApi.getFeed({ page: pageNum, perPage: PER_PAGE })
      if (append) {
        setReviews(prev => [...prev, ...(data.reviews || [])])
      } else {
        setReviews(data.reviews || [])
      }
      setHasMore(pageNum < (data.totalPages || 1))
      setError(false)
    } catch (e) {
      if (!append) setError(true)
      toastError(e?.message || t('Failed to load reviews'))
    }
  }, [toastError, t])

  const initFollows = useCallback(async () => {
    try {
      await followApi.initFollows()
    } catch (e) {
      console.warn('Failed to init follows', e)
    }
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      await Promise.all([initFollows(), loadFeed(1)])
      if (active) setLoading(false)
    })()
    return () => { active = false }
  }, [initFollows, loadFeed])

  const handleRetry = useCallback(() => {
    setLoading(true)
    setError(false)
    setPage(1)
    setHasMore(true)
    loadFeed(1).finally(() => setLoading(false))
  }, [loadFeed])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const nextPage = page + 1
    setPage(nextPage)
    loadFeed(nextPage, true).finally(() => setLoadingMore(false))
  }, [loadingMore, hasMore, page, loadFeed])

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { rootMargin: '400px' }
    )
    const el = sentinelRef.current
    if (el) observer.observe(el)
    return () => { if (el) observer.unobserve(el) }
  }, [loadMore])

  const handleOpenMediaModal = useCallback(async ({ tmdbId, mediaType, title, year }) => {
    try {
      const apiType = mediaType === 'tv' ? 'tv' : 'movie'
      const { data } = await searchApi.getDetails(tmdbId, apiType)
      // data already carries the real library state (inLibrary, ratingKey,
      // isInWatchlist, deepLink…); don't override it. Only fill in display fields.
      setSelectedMedia({
        ...data,
        tmdbId,
        type: apiType,
        mediaType: apiType,
        title: title || data?.title || data?.name || '',
        year: year || data?.year || data?.first_air_date?.substring(0, 4) || data?.release_date?.substring(0, 4) || null,
        // DetailModal reads thumb/art for poster + hero; map the TMDB image URLs
        // onto them (same convention as Explore).
        thumb: data?.thumb || data?.posterUrl || null,
        art: data?.art || data?.backdropUrl || null,
      })
    } catch (e) {
      setSelectedMedia({
        tmdbId,
        type: mediaType === 'tv' ? 'tv' : 'movie',
        mediaType: mediaType === 'tv' ? 'tv' : 'movie',
        title: title || 'Unknown',
        year: year || null,
        inLibrary: false,
      })
    }
  }, [])

  if (loading) {
    return (
      <div className="main-content">
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>{t('Loading reviews...')}</div>
          <SkeletonLoader count={6} />
        </div>
      </div>
    )
  }

  return (
    <div className="main-content">
      {/* Hero */}
      <div className="hero" style={{ marginBottom: '28px' }}>
        <h1 className="hero-title">
          <span className="accent">{t('Reviews')}</span>
        </h1>
        <p className="hero-sub">
          {t('A community feed of reviews from your server')}
        </p>
        <div className="hero-controls" style={{ marginTop: '12px' }}>
          <button
            className="btn-page"
            onClick={() => navigate('/history')}
            style={{
              background: 'var(--accent)', color: '#000', fontWeight: '600',
              padding: '8px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer',
              fontSize: '0.9rem', display: 'inline-flex', alignItems: 'center', gap: '6px',
            }}
          >
            <span>✍️</span> {t('Review Watched Content')}
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="review-feed" style={{ maxWidth: '640px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && reviews.length === 0 ? (
          <div className="review-empty-state" style={{
            textAlign: 'center', padding: '60px 20px', background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '16px' }}>⚠️</div>
            <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
              Couldn't load reviews
            </h3>
            <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '360px', marginLeft: 'auto', marginRight: 'auto' }}>
              {t('Something went wrong fetching the feed. Please try again.')}
            </p>
            <button
              className="btn-page"
              onClick={handleRetry}
              style={{
                background: 'var(--accent)', color: '#000', fontWeight: '600',
                padding: '8px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              {t('Retry')}
            </button>
          </div>
        ) : reviews.length === 0 ? (
          <div className="review-empty-state" style={{
            textAlign: 'center', padding: '60px 20px', background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '16px' }}>📝</div>
            <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
              {t('No reviews yet')}
            </h3>
            <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '360px', marginLeft: 'auto', marginRight: 'auto' }}>
              {t('Be the first to review something from your watch history!')}
            </p>
            <button
              className="btn-page"
              onClick={() => navigate('/history')}
              style={{
                background: 'var(--accent)', color: '#000', fontWeight: '600',
                padding: '8px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              {t('Go to Watch History')}
            </button>
          </div>
        ) : (
          reviews.map(review => (
            <ReviewPost
              key={review.id}
              review={review}
              onOpenMediaModal={handleOpenMediaModal}
            />
          ))
        )}

        {/* Sentinel for infinite scroll */}
        <div ref={sentinelRef} style={{ height: '1px' }} />

        {/* Loading more indicator */}
        {loadingMore && (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {t('Loading more reviews...')}
          </div>
        )}

        {/* End of feed */}
        {!hasMore && reviews.length > 0 && (
          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            You've reached the end
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selectedMedia && (
        <DetailModal
          item={selectedMedia}
          onClose={() => setSelectedMedia(null)}
        />
      )}
    </div>
  )
}
