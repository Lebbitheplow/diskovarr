import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { profileApi, followApi, watchlistApi, blacklistApi, searchApi } from '../services/api'
import ReviewPost from '../components/ReviewPost'
import ProfileEditForm from '../components/ProfileEditForm'
import SkeletonLoader from '../components/SkeletonLoader'
import DetailModal from '../components/DetailModal'

const PER_PAGE = 20

function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}

function Avatar({ src, name, size }) {
  const s = size || '80px'
  if (src) {
    return <img src={posterUrl(src)} alt="" style={{ width: s, height: s, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  }
  return (
    <div style={{ width: s, height: s, borderRadius: '50%', background: 'var(--accent-dim2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: s === '80px' ? '2rem' : '0.85rem', fontWeight: '600', color: 'var(--accent)', flexShrink: 0 }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}

export default function UserProfile() {
  const { userId } = useParams()
  // Key by userId so navigating between profiles remounts with fresh state
  // (loading spinner, reset tab) rather than correcting state inside effects.
  return <UserProfileView key={userId} userId={userId} />
}

function UserProfileView({ userId }) {
  const { user: currentUser } = useAuth()
  const { error: toastError, success: toastSuccess } = useToast()
  const [searchParams] = useSearchParams()
  // Tabs are Profile / Watchlist / Blacklist; legacy ?tab=reviews maps to profile.
  const rawTab = searchParams.get('tab') || 'profile'
  const initialTab = rawTab === 'reviews' ? 'profile' : rawTab

  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [activeTab, setActiveTab] = useState(initialTab)
  const [editing, setEditing] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followingLoading, setFollowingLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const currentUserId = currentUser?.id || currentUser?.userId

  useEffect(() => {
    let active = true
    profileApi.getProfile(userId)
      .then(({ data }) => {
        if (!active) return
        setProfile(data)
        setFollowing(data.isFollowing || false)
        setError(false)
      })
      .catch((e) => {
        if (!active) return
        setError(true)
        toastError(e?.message || 'Failed to load profile')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [userId, toastError, reloadKey])

  const handleRetry = useCallback(() => {
    setLoading(true)
    setError(false)
    setReloadKey(k => k + 1)
  }, [])

  const handleFollowToggle = useCallback(async () => {
    setFollowingLoading(true)
    const prev = following
    setFollowing(!prev)
    try {
      if (!prev) {
        await followApi.follow(userId)
      } else {
        await followApi.unfollow(userId)
      }
    } catch (e) {
      setFollowing(prev)
      toastError(e?.message || 'Failed to update follow status')
    } finally {
      setFollowingLoading(false)
    }
  }, [userId, following, toastError])

  const handleProfileUpdated = useCallback((updated) => {
    setProfile(prev => prev ? { ...prev, ...updated } : null)
    setEditing(false)
    toastSuccess('Profile updated')
  }, [toastSuccess])

  if (loading) {
    return (
      <div className="main-content">
        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontSize: '1.2rem', color: 'var(--text-secondary)', marginBottom: '24px' }}>Loading profile...</div>
          <SkeletonLoader count={4} />
        </div>
      </div>
    )
  }

  if (error || !profile) {
    return (
      <div className="main-content">
        <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', maxWidth: '480px', margin: '40px auto' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '16px' }}>⚠️</div>
          <h3 style={{ margin: '0 0 8px', color: 'var(--text-primary)' }}>Profile not found</h3>
          <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)' }}>This user profile could not be loaded.</p>
          <button className="btn-page" onClick={handleRetry} style={{ background: 'var(--accent)', color: '#000', fontWeight: '600', padding: '8px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer' }}>Retry</button>
        </div>
      </div>
    )
  }

  const isOwn = profile.isOwn || userId === currentUserId
  // Watchlist/Blacklist are owner-only; anyone else is pinned to the profile tab.
  let effectiveTab = activeTab === 'reviews' ? 'profile' : activeTab
  if ((effectiveTab === 'watchlist' || effectiveTab === 'blacklist') && !isOwn) effectiveTab = 'profile'

  return (
    <div className="main-content">
      <div className="profile-page">
        {/* Tabs sit at the very top; only the owner gets Watchlist/Blacklist */}
        {isOwn && (
          <ProfileTabs activeTab={effectiveTab} onTabChange={setActiveTab} />
        )}
        <div className="profile-tab-content">
          {effectiveTab === 'profile' && (
            <>
              <ProfileHeader
                profile={profile}
                isOwn={isOwn}
                editing={editing}
                following={following}
                followingLoading={followingLoading}
                onFollowToggle={handleFollowToggle}
                onEdit={() => setEditing(true)}
              />
              {editing && isOwn ? (
                <ProfileEditForm
                  profile={profile}
                  onCancel={() => setEditing(false)}
                  onUpdated={handleProfileUpdated}
                />
              ) : (
                <>
                  {profile.favoriteGenres?.length > 0 ? (
                    <div className="profile-section">
                      <h3 className="profile-section-title">Favorite Genres</h3>
                      <div className="profile-genres">
                        {profile.favoriteGenres.map((genre, i) => (
                          <span key={i} className="profile-genre-chip">{genre}</span>
                        ))}
                      </div>
                    </div>
                  ) : isOwn && (
                    <div className="profile-section">
                      <h3 className="profile-section-title">Favorite Genres</h3>
                      <div className="profile-empty-hint">No favorite genres yet — add some from Edit Profile.</div>
                    </div>
                  )}
                  {profile.favoriteMedia?.length > 0 ? (
                    <div className="profile-section">
                      <h3 className="profile-section-title">Favorite Media</h3>
                      <FavoriteMediaGrid items={profile.favoriteMedia} />
                    </div>
                  ) : isOwn && (
                    <div className="profile-section">
                      <h3 className="profile-section-title">Favorite Media</h3>
                      <div className="profile-empty-hint">No favorite media yet — add some from Edit Profile.</div>
                    </div>
                  )}
                  <div className="profile-section">
                    <h3 className="profile-section-title">Reviews</h3>
                    <UserReviewsTab userId={userId} />
                  </div>
                </>
              )}
            </>
          )}
          {effectiveTab === 'watchlist' && isOwn && (
            <WatchlistTab />
          )}
          {effectiveTab === 'blacklist' && isOwn && (
            <BlacklistTab />
          )}
        </div>
      </div>
    </div>
  )
}

function ProfileHeader({ profile, isOwn, editing, following, followingLoading, onFollowToggle, onEdit }) {
  return (
    <div className="profile-header">
      <div className="profile-header-main">
        <Avatar src={profile.thumb} name={profile.username} size="80px" />
        <div className="profile-header-info">
          <h1 className="profile-username">{profile.username}</h1>
          <div className="profile-stats">
            <span>{profile.reviewCount || 0} reviews</span>
          </div>
        </div>
        <div className="profile-header-actions">
          {isOwn ? (
            !editing && <button className="btn-page profile-edit-btn" onClick={onEdit}>Edit Profile</button>
          ) : (
            <button
              className="btn-page"
              onClick={onFollowToggle}
              disabled={followingLoading}
              style={{
                border: following ? '1px solid var(--accent-border)' : '1px solid var(--border)',
                background: following ? 'var(--accent-dim)' : 'transparent',
                color: following ? 'var(--accent)' : 'var(--text-secondary)',
              }}
            >
              {followingLoading ? '...' : following ? 'Following' : 'Follow'}
            </button>
          )}
        </div>
      </div>
      {profile.bio ? (
        <div className="profile-bio">{profile.bio}</div>
      ) : isOwn && !editing && (
        <div className="profile-bio profile-empty-hint">No bio yet — add one from Edit Profile.</div>
      )}
    </div>
  )
}

function ProfileTabs({ activeTab, onTabChange }) {
  const tabs = [
    { id: 'profile', label: 'Profile' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'blacklist', label: 'Blacklist' },
  ]

  return (
    <div className="profile-tabs">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`profile-tab ${activeTab === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function FavoriteMediaGrid({ items }) {
  const [selectedMedia, setSelectedMedia] = useState(null)

  const handleOpenModal = useCallback(async (item) => {
    if (!item.tmdbId) return
    try {
      const apiType = item.mediaType === 'tv' ? 'tv' : 'movie'
      const { data } = await searchApi.getDetails(item.tmdbId, apiType)
      setSelectedMedia({
        ...data,
        tmdbId: item.tmdbId,
        type: apiType === 'tv' ? 'show' : 'movie',
        mediaType: apiType,
        title: item.title || data?.title || data?.name || '',
        year: item.year || data?.year || null,
        thumb: data?.thumb || data?.posterUrl || null,
        art: data?.art || data?.backdropUrl || null,
      })
    } catch {
      setSelectedMedia({
        tmdbId: item.tmdbId,
        type: item.mediaType === 'tv' ? 'show' : 'movie',
        mediaType: item.mediaType === 'tv' ? 'tv' : 'movie',
        title: item.title || 'Unknown',
        year: item.year || null,
        inLibrary: false,
      })
    }
  }, [])

  return (
    <>
      <div className="profile-favorites-grid">
        {items.map((item, i) => (
          <div key={i} className="profile-favorite-card" onClick={() => handleOpenModal(item)}>
            {item.posterUrl ? (
              <img src={posterUrl(item.posterUrl)} alt={item.title || ''} loading="lazy" />
            ) : (
              <div className="profile-favorite-placeholder">{(item.title || '?')[0].toUpperCase()}</div>
            )}
            <div className="profile-favorite-title">{item.title || 'Unknown'}</div>
          </div>
        ))}
      </div>
      {selectedMedia && (
        <DetailModal item={selectedMedia} onClose={() => setSelectedMedia(null)} />
      )}
    </>
  )
}

function UserReviewsTab({ userId }) {
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [selectedMedia, setSelectedMedia] = useState(null)
  const sentinelRef = useRef(null)
  const { error: toastError } = useToast()

  const loadReviews = useCallback(async (pageNum, append = false) => {
    try {
      const { data } = await profileApi.getUserReviews(userId, { page: pageNum, perPage: PER_PAGE })
      if (append) {
        setReviews(prev => [...prev, ...(data.reviews || [])])
      } else {
        setReviews(data.reviews || [])
      }
      setHasMore(pageNum < (data.totalPages || 1))
      setError(false)
    } catch (e) {
      if (!append) setError(true)
      toastError(e?.message || 'Failed to load reviews')
    }
  }, [userId, toastError])

  useEffect(() => {
    let active = true
    ;(async () => {
      await loadReviews(1)
      if (active) setLoading(false)
    })()
    return () => { active = false }
  }, [loadReviews])

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const nextPage = page + 1
    setPage(nextPage)
    loadReviews(nextPage, true).finally(() => setLoadingMore(false))
  }, [loadingMore, hasMore, page, loadReviews])

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) loadMore() },
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
      setSelectedMedia({
        ...data,
        tmdbId,
        type: apiType === 'tv' ? 'show' : 'movie',
        mediaType: apiType,
        title: title || data?.title || data?.name || '',
        year: year || data?.year || null,
        thumb: data?.thumb || data?.posterUrl || null,
        art: data?.art || data?.backdropUrl || null,
      })
    } catch {
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
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading reviews...</div>
  }

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
        <p>Failed to load reviews</p>
        <button className="btn-page" onClick={() => loadReviews(1)} style={{ marginTop: '12px', background: 'var(--accent)', color: '#000', fontWeight: '600', padding: '6px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer' }}>Retry</button>
      </div>
    )
  }

  if (reviews.length === 0) {
    return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>No reviews yet</div>
  }

  return (
    <>
      <div className="review-feed" style={{ maxWidth: '640px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {reviews.map(review => (
          <ReviewPost key={review.id} review={review} onOpenMediaModal={handleOpenMediaModal} />
        ))}
        <div ref={sentinelRef} style={{ height: '1px' }} />
        {loadingMore && <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading more...</div>}
        {!hasMore && <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>End of reviews</div>}
      </div>
      {selectedMedia && <DetailModal item={selectedMedia} onClose={() => setSelectedMedia(null)} />}
    </>
  )
}

function WatchlistTab() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)
  const { success: toastSuccess, error: toastError } = useToast()
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data } = await watchlistApi.getWatchlist()
        if (active) setItems(data.items || [])
      } catch {
        if (active) toastError('Failed to load watchlist')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [toastError])

  const handleRemove = useCallback(async (ratingKey) => {
    try {
      await watchlistApi.removeFromWatchlist(ratingKey)
      setItems(prev => prev.filter(item => item.ratingKey !== ratingKey))
      toastSuccess('Removed from watchlist')
    } catch {
      toastError('Failed to remove from watchlist')
    }
  }, [toastSuccess, toastError])

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading watchlist...</div>

  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
        <p>Nothing saved yet.</p>
        <button className="btn-page" onClick={() => navigate('/')} style={{ marginTop: '12px', background: 'var(--accent)', color: '#000', fontWeight: '600', padding: '6px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer' }}>Browse Recommendations</button>
      </div>
    )
  }

  return (
    <>
      <div className="card-grid">
        {items.map(item => (
          <div key={item.ratingKey} className="card">
            <button className="card-poster-link" type="button" onClick={() => setSelectedItem(item)}>
              {item.thumb ? <img className="card-poster" src={posterUrl(item.thumb)} alt={item.title} loading="lazy" /> : <div className="card-poster card-poster-placeholder">🎬<span>{item.title}</span></div>}
            </button>
            <div className="card-info">
              <div className="card-title">{item.title}</div>
              <div className="card-meta">
                {item.year && <span className="card-year">{item.year}</span>}
                {item.audienceRating && <span className="card-rating">★ {item.audienceRating.toFixed(1)}</span>}
              </div>
              <button className="wl-remove-btn" onClick={() => handleRemove(item.ratingKey)}>✕ Remove</button>
            </div>
          </div>
        ))}
      </div>
      {selectedItem && <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </>
  )
}

function BlacklistTab() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)
  const { success: toastSuccess, error: toastError } = useToast()
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data } = await blacklistApi.getBlacklist()
        if (active) setItems(data.items || [])
      } catch {
        if (active) toastError('Failed to load blacklist')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [toastError])

  const handleRemove = useCallback(async (item) => {
    try {
      if (item.source === 'library') {
        await blacklistApi.removeFromBlacklist(item.ratingKey)
      } else {
        await blacklistApi.removeExploreFromBlacklist(item.tmdbId, item.mediaType)
      }
      setItems(prev => {
        if (item.source === 'library') return prev.filter(i => i.ratingKey !== item.ratingKey)
        return prev.filter(i => i.tmdbId !== item.tmdbId || i.mediaType !== item.mediaType)
      })
      toastSuccess('Removed from blacklist')
    } catch {
      toastError('Failed to remove from blacklist')
    }
  }, [toastSuccess, toastError])

  const handleOpenModal = useCallback((item) => {
    setSelectedItem({
      title: item.title,
      year: item.year,
      thumb: item.posterUrl,
      type: item.type,
      mediaType: item.type === 'show' ? 'tv' : 'movie',
      ratingKey: item.ratingKey || undefined,
      tmdbId: item.tmdbId || undefined,
      inLibrary: item.source === 'library',
    })
  }, [])

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Loading blacklist...</div>

  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
        <p>Nothing blacklisted yet.</p>
        <button className="btn-page" onClick={() => navigate('/')} style={{ marginTop: '12px', background: 'var(--accent)', color: '#000', fontWeight: '600', padding: '6px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer' }}>Browse Recommendations</button>
      </div>
    )
  }

  return (
    <>
      <div className="card-grid">
        {items.map(item => (
          <div key={`${item.source}-${item.ratingKey || item.tmdbId}`} className="card">
            <button className="card-poster-link" type="button" onClick={() => handleOpenModal(item)}>
              {item.posterUrl ? <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" /> : <div className="card-poster card-poster-placeholder">🎬<span>{item.title}</span></div>}
            </button>
            <div className="card-info">
              <div className="card-title">{item.title}</div>
              <div className="card-meta">
                {item.year && <span className="card-year">{item.year}</span>}
                <span className={'type-badge type-' + item.type}>{item.type === 'movie' ? 'Movie' : 'TV'}</span>
              </div>
              <button className="bl-remove-btn" onClick={() => handleRemove(item)}>✕ Remove</button>
            </div>
          </div>
        ))}
      </div>
      {selectedItem && <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </>
  )
}
