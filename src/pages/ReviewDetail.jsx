import React, { useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { socialReviewsApi, publicReviewsApi, searchApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import ReviewPost from '../components/ReviewPost'
import ShareButton from '../components/ShareButton'
import DetailModal from '../components/DetailModal'
import SkeletonLoader from '../components/SkeletonLoader'

export default function ReviewDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { error: toastError } = useToast()
  const { user } = useAuth()
  const [review, setReview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [selectedMedia, setSelectedMedia] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      setNotFound(false)
      try {
        // Logged-in viewers get the full interactive review; logged-out visitors
        // (shared links) get the public, read-only projection.
        const { data } = user
          ? await socialReviewsApi.getReview(id)
          : await publicReviewsApi.getReview(id)
        if (active) setReview(data)
      } catch (e) {
        if (active) {
          if (e?.status === 404) setNotFound(true)
          else toastError(e?.message || 'Failed to load review')
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [id, user, toastError])

  const handleOpenMediaModal = useCallback(async ({ tmdbId, mediaType, title, year }) => {
    try {
      const apiType = mediaType === 'tv' ? 'tv' : 'movie'
      const { data } = await searchApi.getDetails(tmdbId, apiType)
      setSelectedMedia({
        ...data,
        tmdbId,
        type: apiType === 'tv' ? 'show' : 'movie',
        mediaType: apiType,
        title: title || data?.title || data?.name || '',
        year: year || data?.year || data?.first_air_date?.substring(0, 4) || data?.release_date?.substring(0, 4) || null,
        thumb: data?.thumb || data?.posterUrl || null,
        art: data?.art || data?.backdropUrl || null,
      })
    } catch (e) {
      setSelectedMedia({
        tmdbId,
        type: mediaType === 'tv' ? 'show' : 'movie',
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
        <div style={{ maxWidth: '640px', margin: '0 auto', padding: '40px 20px' }}>
          <SkeletonLoader count={3} />
        </div>
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="main-content">
        <div className="review-empty-state" style={{
          maxWidth: '480px', margin: '60px auto', textAlign: 'center', padding: '60px 20px',
          background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '16px' }}>🔍</div>
          <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)', fontSize: '1.1rem' }}>
            Review not found
          </h3>
          <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            This review may have been deleted or is set to private.
          </p>
          <button
            className="btn-page"
            onClick={() => navigate(user ? '/reviews' : '/login')}
            style={{
              background: 'var(--accent)', color: '#000', fontWeight: '600',
              padding: '8px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '0.9rem',
            }}
          >
            {user ? 'Back to Reviews' : 'Go to Diskovarr'}
          </button>
        </div>
      </div>
    )
  }

  // ── Public (logged-out) view ──────────────────────────────────────────────
  // The generated share card already contains the avatar, title, rating, text
  // (or spoiler badge) and Diskovarr branding, so we lead with it and offer a CTA.
  if (!user) {
    return (
      <div className="main-content" style={{ minHeight: '100vh' }}>
        <div style={{ maxWidth: '600px', margin: '0 auto', padding: '32px 16px 60px' }}>
          <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none', marginBottom: '24px' }}>
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.4" fill="var(--accent)" />
              <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="var(--accent)" />
              <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="var(--accent)" />
              <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="var(--accent)" />
              <circle cx="15" cy="9" r="5" stroke="var(--accent)" strokeWidth="2" fill="none" />
              <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <span style={{ fontWeight: 700, fontSize: '1.15rem', color: 'var(--text-primary)' }}>Diskovarr</span>
          </Link>

          <img
            src={`/og/review/${id}.png`}
            alt={review?.title ? `${review.title} review by ${review.username}` : 'Review'}
            style={{ width: '100%', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', display: 'block' }}
          />

          {!review?.spoiler && review?.reviewText && (
            <p style={{ marginTop: '20px', color: 'var(--text-primary)', fontSize: '1rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {review.reviewText}
            </p>
          )}

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '24px', alignItems: 'center' }}>
            <Link
              to="/login"
              style={{
                background: 'var(--accent)', color: '#000', fontWeight: 600, textDecoration: 'none',
                padding: '10px 22px', borderRadius: '10px', fontSize: '0.9rem',
              }}
            >
              Sign in to react & comment
            </Link>
            <ShareButton reviewId={id} review={review || {}} />
          </div>
        </div>
      </div>
    )
  }

  // ── Authenticated view — full interactive review ──────────────────────────
  return (
    <div className="main-content">
      <div style={{ maxWidth: '640px', margin: '0 auto', padding: '24px 16px' }}>
        <button
          className="btn-page"
          onClick={() => navigate(-1)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            background: 'transparent', border: 'none', color: 'var(--text-secondary)',
            cursor: 'pointer', fontSize: '0.85rem', marginBottom: '16px', padding: '4px 0',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
          </svg>
          Back
        </button>

        {review && (
          <ReviewPost
            review={review}
            onOpenMediaModal={handleOpenMediaModal}
          />
        )}
      </div>

      {selectedMedia && (
        <DetailModal
          item={selectedMedia}
          onClose={() => setSelectedMedia(null)}
        />
      )}
    </div>
  )
}
