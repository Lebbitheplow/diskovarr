import React, { useState, useCallback } from 'react'
import { socialReviewsApi, followApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import StarsDisplay from './StarsDisplay'
import ShareButton from './ShareButton'
import ReviewComments from './ReviewComments'
import { posterUrl } from '../utils/media'
import { useTranslation } from 'react-i18next'

function fmtTime(ts) {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) { const m = Math.floor(diff / 60); return m + 'm ago' }
  if (diff < 86400) { const h = Math.floor(diff / 3600); return h + 'h ago' }
  if (diff < 604800) { const d = Math.floor(diff / 86400); return d + 'd ago' }
  return new Date(ts * 1000).toLocaleDateString()
}

function fmtDate(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function Avatar({ src, name, size = '36px' }) {
  if (src) {
    return <img src={posterUrl(src)} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--accent-dim2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--accent)', flexShrink: 0 }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}

function MediaPoster({ posterUrl, title }) {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  return (
    <div
      style={{
        width: '80px', minHeight: '120px', borderRadius: '6px', overflow: 'hidden', flexShrink: 0,
        background: 'var(--bg-secondary)', position: 'relative',
      }}
    >
      {posterUrl && !error ? (
        <img
          src={posterUrl}
          alt={title || ''}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          onError={() => setError(true)}
          loading="lazy"
        />
      ) : (
        <div style={{ width: '100%', height: '120px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
          {t('No poster')}
        </div>
      )}
    </div>
  )
}

export default function ReviewPost({ review, onOpenMediaModal }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const [reacted, setReacted] = useState(review.hasReacted || false)
  const [reactionCount, setReactionCount] = useState(review.reactionCount || 0)
  const [commentCount, setCommentCount] = useState(review.commentCount || 0)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [reacting, setReacting] = useState(false)
  // Per-instance spoiler reveal — revealing this post never affects sibling posts.
  const [revealed, setRevealed] = useState(false)
  const [following, setFollowing] = useState(review.isFollowing || false)
  const [followingBtnLoading, setFollowingBtnLoading] = useState(false)

  const handleReact = useCallback(async () => {
    if (reacting) return
    setReacting(true)
    const prevReacted = reacted
    const prevCount = reactionCount
    setReacted(!prevReacted)
    setReactionCount(prev => prevReacted ? prev - 1 : prev + 1)
    try {
      const { data } = await socialReviewsApi.toggleReaction(review.id)
      setReacted(data.reacted)
      setReactionCount(data.count)
    } catch (e) {
      setReacted(prevReacted)
      setReactionCount(prevCount)
      toastError(e?.message || t('Failed to toggle reaction'))
    } finally {
      setReacting(false)
    }
  }, [review.id, reacting, reacted, reactionCount, toastError, t])

  const handleFollowToggle = useCallback(async () => {
    if (followingBtnLoading || review.isOwn) return
    setFollowingBtnLoading(true)
    const prevFollowing = following
    setFollowing(!prevFollowing)
    try {
      if (!prevFollowing) {
        await followApi.follow(review.userId)
      } else {
        await followApi.unfollow(review.userId)
      }
    } catch (e) {
      setFollowing(prevFollowing)
      toastError(e?.message || t('Failed to update follow status'))
    } finally {
      setFollowingBtnLoading(false)
    }
  }, [review.userId, review.isOwn, followingBtnLoading, following, toastError, t])

  const handleCommentCountChange = useCallback((delta) => {
    setCommentCount(prev => Math.max(0, prev + delta))
  }, [])

  const handleOpenMedia = useCallback(() => {
    if (review.tmdbId) {
      onOpenMediaModal({
        tmdbId: review.tmdbId,
        mediaType: review.mediaType,
        title: review.title,
        year: review.year,
      })
    }
  }, [review, onOpenMediaModal])

  const currentUserId = user?.userId || user?.id
  const isOwn = review.isOwn || review.userId === currentUserId

  return (
    <article className="review-post" style={{
      background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
      overflow: 'hidden', transition: 'border-color 0.2s',
    }}>
      {/* Header */}
      <div className="review-post-header" style={{ padding: '14px 16px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <a href={`/user/${review.userId}`} style={{ display: 'block', textDecoration: 'none' }}>
          <Avatar src={review.userAvatar} name={review.username} />
        </a>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <a
              href={`/user/${review.userId}`}
              style={{ fontWeight: '600', fontSize: '0.92rem', color: 'var(--text-primary)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {review.username}
            </a>
            {isOwn && (
              <span style={{ fontSize: '0.65rem', background: 'var(--accent-dim)', color: 'var(--accent)', padding: '1px 6px', borderRadius: '10px', fontWeight: '500' }}>
                {t('You')}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            <span>{fmtTime(review.createdAt)}</span>
            {review.watchedDate && (
              <>
                <span>·</span>
                <span>watched {fmtDate(review.watchedDate)}</span>
              </>
            )}
          </div>
        </div>
        {!isOwn && (
          <button
            className={following ? 'btn-page' : 'btn-page'}
            onClick={handleFollowToggle}
            disabled={followingBtnLoading}
            style={{
              fontSize: '0.75rem', padding: '4px 12px', borderRadius: '20px',
              border: following ? '1px solid var(--accent-border)' : '1px solid var(--border)',
              background: following ? 'var(--accent-dim)' : 'transparent',
              color: following ? 'var(--accent)' : 'var(--text-secondary)',
              cursor: 'pointer', fontWeight: '500', flexShrink: 0,
            }}
          >
            {followingBtnLoading ? '...' : following ? 'Following' : 'Follow'}
          </button>
        )}
      </div>

      {/* Media Info */}
      <div className="review-post-media" style={{ padding: '12px 16px', display: 'flex', gap: '14px', alignItems: 'flex-start', cursor: 'pointer' }} onClick={handleOpenMedia}>
        <MediaPoster posterUrl={review.posterUrl} title={review.title} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {review.title}
          </h3>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {review.year && (
              <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{review.year}</span>
            )}
            {review.mediaType && (
              <span style={{ fontSize: '0.7rem', background: 'var(--accent-dim)', color: 'var(--accent)', padding: '1px 6px', borderRadius: '4px', textTransform: 'uppercase', fontWeight: '500' }}>
                {review.mediaType === 'tv' ? 'TV' : 'Movie'}
              </span>
            )}
            {review.contentRating && (
              <span style={{ fontSize: '0.7rem', border: '1px solid var(--border-hover)', color: 'var(--text-secondary)', padding: '1px 6px', borderRadius: '4px', fontWeight: '500' }}>
                {review.contentRating}
              </span>
            )}
          </div>
          <div style={{ marginTop: '2px' }}>
            <StarsDisplay rating={review.rating} size="1.45rem" />
          </div>
        </div>
      </div>

      {/* Review Content */}
      <div className="review-post-body" style={{ padding: '0 16px 12px' }}>
        {review.reviewText && (
          <div className={review.spoiler && !revealed ? 'review-spoiler' : undefined}>
            <p
              className={review.spoiler && !revealed ? 'review-spoiler-text' : undefined}
              aria-hidden={review.spoiler && !revealed ? 'true' : undefined}
              style={{ margin: 0, fontSize: '0.9rem', lineHeight: '1.6', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}
            >
              {review.reviewText}
            </p>
            {review.spoiler && !revealed && (
              <button
                type="button"
                className="review-spoiler-reveal"
                onClick={() => setRevealed(true)}
                aria-label={t('Reveal spoiler — this review contains spoilers')}
              >
                <span aria-hidden="true">👁</span> {t('Reveal spoiler')}
              </button>
            )}
            {review.spoiler && revealed && (
              <button
                type="button"
                className="review-spoiler-hide"
                onClick={() => setRevealed(false)}
              >
                {t('Hide spoiler')}
              </button>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
          {review.spoiler && (
            <span style={{ fontSize: '0.7rem', background: 'rgba(248,113,113,0.15)', color: '#f87171', padding: '2px 8px', borderRadius: '4px', fontWeight: '500' }}>
              {t('Spoiler')}
            </span>
          )}
          {review.rewatch && (
            <span style={{ fontSize: '0.7rem', background: 'rgba(52,211,153,0.15)', color: '#34d399', padding: '2px 8px', borderRadius: '4px', fontWeight: '500' }}>
              {t('Would Rewatch')}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="review-post-actions" style={{
        padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: '4px', alignItems: 'center',
      }}>
        <button
          className="review-action-btn"
          onClick={handleReact}
          disabled={reacting}
          style={{
            display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', borderRadius: '20px',
            border: 'none', background: reacted ? 'var(--accent-dim)' : 'transparent',
            color: reacted ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer', fontSize: '0.82rem', fontWeight: '500', transition: 'all 0.15s',
          }}
        >
          <span style={{ fontSize: '1.1rem' }}>{reacted ? '❤️' : '🤍'}</span>
          <span>{reactionCount || ''}</span>
        </button>

        <button
          className="review-action-btn"
          onClick={() => setCommentsOpen(!commentsOpen)}
          style={{
            display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', borderRadius: '20px',
            border: 'none', background: commentsOpen ? 'var(--accent-dim)' : 'transparent',
            color: commentsOpen ? 'var(--accent)' : 'var(--text-secondary)',
            cursor: 'pointer', fontSize: '0.82rem', fontWeight: '500', transition: 'all 0.15s',
          }}
        >
          <span style={{ fontSize: '1.1rem' }}>💬</span>
          <span>{commentCount || ''}</span>
        </button>

        <ShareButton reviewId={review.id} review={review} />
      </div>

      {/* Comments — mount fresh on open so it loads with a clean state */}
      {commentsOpen && (
        <ReviewComments
          reviewId={review.id}
          onCommentCountChange={handleCommentCountChange}
        />
      )}
    </article>
  )
}
