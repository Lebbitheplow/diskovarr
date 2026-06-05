import React, { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { blacklistApi } from '../services/api'
import SkeletonLoader from '../components/SkeletonLoader'
import DetailModal from '../components/DetailModal'
import { useToast } from '../context/ToastContext'

function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d)) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function Blacklist() {
  const navigate = useNavigate()
  const { success: toastSuccess, error: toastError } = useToast()

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)

  const loadBlacklist = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await blacklistApi.getBlacklist()
      setItems(data.items || [])
    } catch (e) {
      toastError('Failed to load blacklist')
    } finally {
      setLoading(false)
    }
  }, [toastError])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional external/async state sync
    loadBlacklist()
  }, [loadBlacklist])

  const handleRemove = useCallback(async (item) => {
    try {
      if (item.source === 'library') {
        await blacklistApi.removeFromBlacklist(item.ratingKey)
      } else {
        await blacklistApi.removeExploreFromBlacklist(item.tmdbId, item.mediaType)
      }
      setItems(prev => {
        if (item.source === 'library') {
          return prev.filter(i => i.ratingKey !== item.ratingKey)
        }
        return prev.filter(i => i.tmdbId !== item.tmdbId || i.mediaType !== item.mediaType)
      })
      toastSuccess('Removed from blacklist')
    } catch (e) {
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

  return (
    <main className="main-content">
      <div className="hero">
        <h1 className="hero-title">Your <span className="accent">Blacklist</span></h1>
        <p className="hero-sub">{items.length} blacklisted item{items.length !== 1 ? 's' : ''}</p>
      </div>

      {loading ? (
        <section className="section">
          <SkeletonLoader count={12} />
        </section>
      ) : items.length === 0 ? (
        <div className="blacklist-empty">
          <p className="blacklist-empty-msg">Nothing blacklisted yet.</p>
          <p className="blacklist-empty-sub">Items you mark as <strong>Not Interested</strong> will appear here so you can manage them.</p>
          <button className="btn-plex" onClick={() => navigate('/')} style={{ display: 'inline-block', marginTop: '1rem', cursor: 'pointer' }}>
            Browse Recommendations
          </button>
        </div>
      ) : (
        <section className="section">
          <div className="card-grid" id="blacklist-grid">
            {items.map(item => (
              <div key={`${item.source}-${item.ratingKey || item.tmdbId}`} className="card" data-source={item.source}>
                <button className="card-poster-link" type="button" title={item.title} onClick={() => handleOpenModal(item)}>
                  {item.posterUrl && (
                    <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />
                  )}
                  {!item.posterUrl && (
                    <div className="card-poster card-poster-placeholder">🎬<span>{item.title}</span></div>
                  )}
                </button>
                <div className="card-info">
                  <div className="card-title">{item.title}</div>
                  <div className="card-meta">
                    <span className="card-year">{item.year || ''}</span>
                    <span className={'type-badge type-' + item.type}>{item.type === 'movie' ? 'Movie' : 'TV'}</span>
                  </div>
                  {item.dismissed_at && (
                    <div className="bl-date">Blacklisted {formatDate(item.dismissed_at)}</div>
                  )}
                  <button className="bl-remove-btn" onClick={() => handleRemove(item)}>
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
