import React, { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { watchlistApi, plexApi } from '../services/api'
import MediaCard from '../components/MediaCard'
import SkeletonLoader from '../components/SkeletonLoader'
import DetailModal from '../components/DetailModal'
import { useToast } from '../context/ToastContext'

function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}

export default function Watchlist() {
  const navigate = useNavigate()
  const { success: toastSuccess, error: toastError } = useToast()

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)

  const loadWatchlist = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await watchlistApi.getWatchlist()
      setItems(data.items || [])
    } catch (e) {
      toastError('Failed to load watchlist')
    } finally {
      setLoading(false)
    }
  }, [toastError])

  useEffect(() => {
    loadWatchlist()
  }, [loadWatchlist])

  const handleRemove = useCallback(async (ratingKey) => {
    try {
      await watchlistApi.removeFromWatchlist(ratingKey)
      setItems(prev => prev.filter(item => item.ratingKey !== ratingKey))
      toastSuccess('Removed from watchlist')
    } catch (e) {
      toastError('Failed to remove from watchlist')
    }
  }, [toastSuccess, toastError])

  const handleOpenModal = useCallback((item) => {
    setSelectedItem(item)
  }, [])

  const handleDismiss = useCallback(async (item) => {
    try {
      await plexApi.dismissItem(item.ratingKey)
      setItems(prev => prev.filter(i => i.ratingKey !== item.ratingKey))
      toastSuccess('Not interested')
    } catch (e) {
      toastError('Dismiss failed')
    }
  }, [toastSuccess, toastError])

  return (
    <main className="main-content">
      <div className="hero">
        <h1 className="hero-title">Your <span className="accent">Watchlist</span></h1>
        <p className="hero-sub">{items.length} saved item{items.length !== 1 ? 's' : ''}</p>
      </div>

      {loading ? (
        <section className="section">
          <SkeletonLoader count={12} />
        </section>
      ) : items.length === 0 ? (
        <div className="watchlist-empty">
          <p className="watchlist-empty-msg">Nothing saved yet.</p>
          <p className="watchlist-empty-sub">Browse recommendations and hit <strong>+ Watchlist</strong> to save things to watch later.</p>
          <button className="btn-plex" onClick={() => navigate('/')} style={{ display: 'inline-block', marginTop: '1rem', cursor: 'pointer' }}>
            Browse Recommendations
          </button>
        </div>
      ) : (
        <section className="section">
          <div className="card-grid" id="watchlist-grid">
            {items.map(item => (
              <div key={item.ratingKey} className="card" id={`wl-card-${item.ratingKey}`} data-rating-key={item.ratingKey}>
                <button className="card-poster-link" type="button" title={item.title} data-rating-key={item.ratingKey} onClick={() => handleOpenModal(item)}>
                  {item.thumb && (
                    <img className="card-poster" src={posterUrl(item.thumb)} alt={item.title} loading="lazy" />
                  )}
                  {!item.thumb && (
                    <div className="card-poster card-poster-placeholder">🎬<span>{item.title}</span></div>
                  )}
                </button>
                <div className="card-info">
                  <div className="card-title">{item.title}</div>
                  <div className="card-meta">
                    <span className="card-year">{item.year || ''}</span>
                    {item.audienceRating && <span className="card-rating">★ {item.audienceRating.toFixed(1)}</span>}
                  </div>
                  <button className="wl-remove-btn" data-rating-key={item.ratingKey} onClick={() => handleRemove(item.ratingKey)}>
                    ✕ Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {selectedItem && (
        <DetailModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </main>
  )
}
