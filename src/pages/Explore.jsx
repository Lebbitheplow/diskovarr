import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  exploreApi,
  watchlistApi,
  plexApi,
  searchApi,
  issuesApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import Carousel from '../components/Carousel'
import DetailModal from '../components/DetailModal'
import SkeletonLoader from '../components/SkeletonLoader'
import ToggleSwitch from '../components/ToggleSwitch'
import Modal from '../components/Modal'
import { useToast } from '../context/ToastContext'

const MATURE_RATINGS = new Set(['r', 'tv-ma', 'nc-17', 'x', 'nr'])

function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}

function makeReasonTag(text) {
  const tag = document.createElement('span')
  tag.className = 'reason-tag'
  const inner = document.createElement('span')
  inner.className = 'reason-tag-text'
  inner.textContent = text
  tag.appendChild(inner)
  setTimeout(() => {
    const cs = window.getComputedStyle(tag)
    const tagExtra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
    const overflow = inner.getBoundingClientRect().width - (tag.getBoundingClientRect().width - tagExtra)
    if (overflow > 1) {
      const dist = Math.ceil(overflow) + 6
      const dur = Math.max(3, (dist / 40 + 2)).toFixed(1) + 's'
      tag.style.setProperty('--tag-scroll-dist', '-' + dist + 'px')
      tag.style.setProperty('--tag-scroll-duration', dur)
      tag.classList.add('reason-tag-scroll')
    }
  }, 50)
  return tag
}

export default function Explore() {
  const { error: toastError, success: toastSuccess } = useToast()

  const [recommendations, setRecommendations] = useState(null)
  const [loading, setLoading] = useState(true)
  const [matureEnabled, setMatureEnabled] = useState(() => localStorage.getItem('matureEnabled') === 'true')
  const [hideRequested, setHideRequested] = useState(() => localStorage.getItem('hideRequested') === 'true')
  const [services, setServices] = useState({})
  const [selectedItem, setSelectedItem] = useState(null)
  const [requestItem, setRequestItem] = useState(null)
  const [seasons, setSeasons] = useState([])
  const [selectedSeasons, setSelectedSeasons] = useState(['all'])
  const [watchlistCache, setWatchlistCache] = useState({})
  const [building, setBuilding] = useState(false)
  const [polling, setPolling] = useState(false)

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {}
      ;(data.items || []).forEach(item => {
        cache[item.ratingKey] = true
      })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  const loadServices = useCallback(async () => {
    try {
      const { data } = await exploreApi.getServices()
      setServices(data || {})
    } catch { /* ignore */ }
  }, [])

  const fetchRecommendations = useCallback(async (shuffle) => {
    if (shuffle) { setLoading(true); setRecommendations(null) }
    const params = new URLSearchParams()
    if (matureEnabled) params.set('mature', 'true')
    if (hideRequested) params.set('hideRequested', 'true')

    try {
      const { data } = await exploreApi.getRecommendations(params)
      if (data.status === 'building') {
        setBuilding(true)
        if (!polling) {
          setPolling(true)
          const interval = setInterval(async () => {
            try {
              const { data: pollData } = await exploreApi.getRecommendations(params)
              if (pollData.status !== 'building') {
                setBuilding(false)
                setPolling(false)
                clearInterval(interval)
                setRecommendations(pollData)
              }
            } catch { /* ignore */ }
          }, 5000)
        }
        return
      }
      setBuilding(false)
      setPolling(false)
      setRecommendations(data)
    } catch (e) {
      setBuilding(false)
      setPolling(false)
      toastError('Failed to load recommendations')
    } finally {
      setLoading(false)
    }
  }, [matureEnabled, hideRequested, polling, toastError])

  useEffect(() => {
    loadServices()
    loadWatchlist()
  }, [loadServices, loadWatchlist])

  useEffect(() => {
    fetchRecommendations(false)
  }, [fetchRecommendations])

  const handleShuffle = useCallback(async () => {
    await fetchRecommendations(true)
  }, [fetchRecommendations])

  const handleMatureChange = useCallback((checked) => {
    setMatureEnabled(checked)
    localStorage.setItem('matureEnabled', checked ? 'true' : 'false')
    fetchRecommendations(false)
  }, [fetchRecommendations])

  const handleHideRequestedChange = useCallback((checked) => {
    setHideRequested(checked)
    localStorage.setItem('hideRequested', checked ? 'true' : 'false')
    fetchRecommendations(false)
  }, [fetchRecommendations])

  const handleOpenModal = useCallback((item) => {
    setSelectedItem(item)
  }, [])

  const handleToggleWatchlist = useCallback(async (item) => {
    const ratingKey = item.ratingKey
    const isInWatchlist = watchlistCache[ratingKey] || false
    try {
      if (isInWatchlist) {
        await watchlistApi.removeFromWatchlist(ratingKey)
        setWatchlistCache(prev => { const next = { ...prev }; delete next[ratingKey]; return next })
        toastSuccess('Removed from watchlist')
      } else {
        await watchlistApi.addToWatchlist(ratingKey)
        setWatchlistCache(prev => ({ ...prev, [ratingKey]: true }))
        toastSuccess('Added to watchlist')
      }
    } catch (e) {
      toastError(e.message || 'Watchlist action failed')
    }
  }, [watchlistCache, toastSuccess, toastError])

  const handleDismiss = useCallback(async (item) => {
    try {
      await exploreApi.dismissRecommendation(item.tmdbId, item.mediaType)
      setSelectedItem(prev => prev && prev.tmdbId === item.tmdbId ? null : prev)
      setRecommendations(prev => {
        if (!prev) return prev
        const filterItems = (items) => items.filter(i => i.tmdbId !== item.tmdbId || i.mediaType !== item.mediaType)
        return {
          topPicks: filterItems(prev.topPicks || []),
          movies: filterItems(prev.movies || []),
          tvShows: filterItems(prev.tvShows || []),
          anime: filterItems(prev.anime || []),
          trendingMovies: filterItems(prev.trendingMovies || []),
          trendingTV: filterItems(prev.trendingTV || []),
        }
      })
      toastSuccess('Not interested')
    } catch (e) {
      toastError('Dismiss failed')
    }
  }, [toastSuccess, toastError])

  const openRequestDialog = useCallback((item) => {
    setRequestItem(item)
    setSelectedItem(null)
  }, [])

  const handleSeasonToggle = useCallback((season) => {
    setSelectedSeasons(prev => {
      if (prev[0] === 'all' && prev.length === 1) {
        return [String(season)]
      }
      const next = prev.filter(s => String(s) !== String(season))
      if (next.length === 0) return ['all']
      return next
    })
  }, [])

  const handleSelectAllSeasons = useCallback((checked) => {
    if (checked) {
      setSelectedSeasons(['all'])
    } else {
      setSelectedSeasons([])
    }
  }, [])

  const handleSubmitRequest = useCallback(async () => {
    if (!requestItem) return
    const seasons = selectedSeasons[0] === 'all' || selectedSeasons.length === 0 ? null : selectedSeasons.map(Number)

    try {
      await exploreApi.followRecommendation(requestItem.tmdbId, requestItem.mediaType)
      toastSuccess('You\'ll be notified when ' + requestItem.title + ' is available')
      setRequestItem(null)
      setSelectedSeasons(['all'])
      setRecommendations(prev => {
        if (!prev) return prev
        const updateItem = (items) => items.map(i => {
          if (i.tmdbId === requestItem.tmdbId && i.mediaType === requestItem.mediaType) {
            return { ...i, isMyRequest: true, badgeRequested: true }
          }
          return i
        })
        return {
          topPicks: updateItem(prev.topPicks || []),
          movies: updateItem(prev.movies || []),
          tvShows: updateItem(prev.tvShows || []),
          anime: updateItem(prev.anime || []),
          trendingMovies: updateItem(prev.trendingMovies || []),
          trendingTV: updateItem(prev.trendingTV || []),
        }
      })
    } catch (e) {
      toastError(e.message || 'Request failed')
    }
  }, [requestItem, selectedSeasons, toastSuccess, toastError])

  const handleSeasonsFetch = useCallback(async (tmdbId) => {
    try {
      const { data } = await searchApi.getSeasons(tmdbId)
      setSeasons(data.seasons || [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (requestItem) {
      handleSeasonsFetch(requestItem.tmdbId)
    }
  }, [requestItem, handleSeasonsFetch])

  const filteredRecommendations = useCallback(() => {
    if (!recommendations) return null
    if (matureEnabled) return recommendations
    const filterItems = (items) => items.filter(item => {
      return !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
    })
    return {
      topPicks: filterItems(recommendations.topPicks || []),
      movies: filterItems(recommendations.movies || []),
      tvShows: filterItems(recommendations.tvShows || []),
      anime: filterItems(recommendations.anime || []),
      trendingMovies: filterItems(recommendations.trendingMovies || []),
      trendingTV: filterItems(recommendations.trendingTV || []),
    }
  }, [recommendations, matureEnabled])

  const filteredItems = (items) => {
    if (!items) return []
    if (hideRequested) return items.filter(i => !i.isMyRequest && !i.badgeRequested)
    return items
  }

  return (
    <>
      <main className="main-content">
        {building && (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
            <div className="spinner" style={{ display: 'inline-block', margin: '0 auto 12px' }} />
            <p>Building your recommendations…</p>
          </div>
        )}
        <div className="hero">
          <h1 className="hero-title">Diskovarr <span className="accent">Requests</span></h1>
          <p className="hero-sub">Everything here is <strong>not yet in the library</strong> — picked for your taste based on your watch history.</p>
          <div className="hero-controls hero-controls-split">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <ToggleSwitch
                checked={matureEnabled}
                onChange={handleMatureChange}
                label="Show mature content (R & TV-MA)"
              />
              <ToggleSwitch
                checked={hideRequested}
                onChange={handleHideRequestedChange}
                label="Hide requested"
              />
            </div>
            <button
              type="button"
              className="btn-shuffle-all"
              title="Refresh picks"
              onClick={handleShuffle}
              disabled={loading}
              style={{ transition: 'transform 0.4s ease', transform: loading ? 'rotate(360deg)' : '' }}
            >
              ↺
            </button>
          </div>
        </div>

        {loading ? (
          <>
            <section className="section" id="section-top-picks">
              <div className="section-header">
                <h2 className="section-title">Top Picks for You</h2>
                <span className="section-badge">Outside Your Library</span>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-movies">
              <div className="section-header">
                <h2 className="section-title">Movies</h2>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-tv">
              <div className="section-header">
                <h2 className="section-title">TV Shows</h2>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-anime">
              <div className="section-header">
                <h2 className="section-title">Anime</h2>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
          </>
        ) : (
          <>
            {filteredItems(filteredRecommendations()?.topPicks).length > 0 && (
              <section className="section" id="section-top-picks">
                <div className="section-header">
                  <h2 className="section-title">Top Picks for You</h2>
                  <span className="section-badge">Outside Your Library</span>
                </div>
                <Carousel>
                  {filteredItems(filteredRecommendations()?.topPicks).map(item => (
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} onClick={() => handleOpenModal(item)}>
                      <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                        {item.posterUrl && (
                          <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />
                        )}
                        <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                        <span className={'badge-not-in-library' + (item.badgeRequested ? ' badge-requested' : '')}>{item.badgeRequested ? 'Requested' : 'Not in Library'}</span>
                        <div className="card-overlay">
                          <div className="card-overlay-actions">
                            {item.ratingKey && (
                              <button
                                className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')}
                                onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}
                              >
                                {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                              </button>
                            )}
                            {!item.badgeRequested && (
                              <button className="btn-icon btn-dismiss" onClick={(e) => { e.stopPropagation(); handleDismiss(item) }}>✕</button>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="card-info">
                        <div className="card-title">{item.title}</div>
                        <div className="card-meta">
                          {item.year && <span className="card-year">{item.year}</span>}
                          {item.voteAverage && <span className="card-rating">★ {item.voteAverage.toFixed(1)}</span>}
                        </div>
                        {item.reasons && item.reasons.length > 0 && (
                          <div className="card-reasons">
                            {item.reasons.slice(0, 2).map((r, i) => (
                              <span key={i} className="reason-tag"><span className="reason-tag-text">{r}</span></span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </Carousel>
              </section>
            )}

            {filteredItems(filteredRecommendations()?.movies).length > 0 && (
              <section className="section" id="section-movies">
                <div className="section-header"><h2 className="section-title">Movies</h2></div>
                <Carousel>
                  {filteredItems(filteredRecommendations()?.movies).map(item => (
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} onClick={() => handleOpenModal(item)}>
                      <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                        {item.posterUrl && <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />}
                        <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                        <span className={'badge-not-in-library' + (item.badgeRequested ? ' badge-requested' : '')}>{item.badgeRequested ? 'Requested' : 'Not in Library'}</span>
                        <div className="card-overlay">
                          <div className="card-overlay-actions">
                            {item.ratingKey && (
                              <button className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')} onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}>
                                {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                              </button>
                            )}
                            {!item.badgeRequested && (
                              <button className="btn-icon btn-dismiss" onClick={(e) => { e.stopPropagation(); handleDismiss(item) }}>✕</button>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="card-info">
                        <div className="card-title">{item.title}</div>
                        <div className="card-meta">
                          {item.year && <span className="card-year">{item.year}</span>}
                          {item.voteAverage && <span className="card-rating">★ {item.voteAverage.toFixed(1)}</span>}
                        </div>
                        {item.reasons && item.reasons.length > 0 && (
                          <div className="card-reasons">
                            {item.reasons.slice(0, 2).map((r, i) => (
                              <span key={i} className="reason-tag"><span className="reason-tag-text">{r}</span></span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </Carousel>
              </section>
            )}

            {filteredItems(filteredRecommendations()?.tvShows).length > 0 && (
              <section className="section" id="section-tv">
                <div className="section-header"><h2 className="section-title">TV Shows</h2></div>
                <Carousel>
                  {filteredItems(filteredRecommendations()?.tvShows).map(item => (
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} onClick={() => handleOpenModal(item)}>
                      <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                        {item.posterUrl && <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />}
                        <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                        <span className={'badge-not-in-library' + (item.badgeRequested ? ' badge-requested' : '')}>{item.badgeRequested ? 'Requested' : 'Not in Library'}</span>
                        <div className="card-overlay">
                          <div className="card-overlay-actions">
                            {item.ratingKey && (
                              <button className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')} onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}>
                                {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                              </button>
                            )}
                            {!item.badgeRequested && (
                              <button className="btn-icon btn-dismiss" onClick={(e) => { e.stopPropagation(); handleDismiss(item) }}>✕</button>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="card-info">
                        <div className="card-title">{item.title}</div>
                        <div className="card-meta">
                          {item.year && <span className="card-year">{item.year}</span>}
                          {item.voteAverage && <span className="card-rating">★ {item.voteAverage.toFixed(1)}</span>}
                        </div>
                        {item.reasons && item.reasons.length > 0 && (
                          <div className="card-reasons">
                            {item.reasons.slice(0, 2).map((r, i) => (
                              <span key={i} className="reason-tag"><span className="reason-tag-text">{r}</span></span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </Carousel>
              </section>
            )}

            {filteredItems(filteredRecommendations()?.anime).length > 0 && (
              <section className="section" id="section-anime">
                <div className="section-header"><h2 className="section-title">Anime</h2></div>
                <Carousel>
                  {filteredItems(filteredRecommendations()?.anime).map(item => (
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} onClick={() => handleOpenModal(item)}>
                      <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                        {item.posterUrl && <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />}
                        <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                        <span className={'badge-not-in-library' + (item.badgeRequested ? ' badge-requested' : '')}>{item.badgeRequested ? 'Requested' : 'Not in Library'}</span>
                        <div className="card-overlay">
                          <div className="card-overlay-actions">
                            {item.ratingKey && (
                              <button className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')} onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}>
                                {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                              </button>
                            )}
                            {!item.badgeRequested && (
                              <button className="btn-icon btn-dismiss" onClick={(e) => { e.stopPropagation(); handleDismiss(item) }}>✕</button>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="card-info">
                        <div className="card-title">{item.title}</div>
                        <div className="card-meta">
                          {item.year && <span className="card-year">{item.year}</span>}
                          {item.voteAverage && <span className="card-rating">★ {item.voteAverage.toFixed(1)}</span>}
                        </div>
                        {item.reasons && item.reasons.length > 0 && (
                          <div className="card-reasons">
                            {item.reasons.slice(0, 2).map((r, i) => (
                              <span key={i} className="reason-tag"><span className="reason-tag-text">{r}</span></span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </Carousel>
              </section>
            )}
          </>
        )}
      </main>

      {selectedItem && (
        <DetailModal
          item={{
            ...selectedItem,
            type: selectedItem.mediaType === 'tv' ? 'show' : 'movie',
            thumb: selectedItem.posterUrl,
            art: selectedItem.backdropUrl,
            mediaType: selectedItem.mediaType,
          }}
          onClose={() => setSelectedItem(null)}
        />
      )}

      <Modal isOpen={!!requestItem} onClose={() => setRequestItem(null)}>
        {requestItem && (
          <div>
            <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: '600' }}>
              Request "{requestItem.title}"?
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
              {requestItem.year} · {requestItem.mediaType === 'movie' ? 'Movie' : 'TV Show'}
            </p>
            {requestItem.mediaType === 'tv' && seasons.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <label className="edit-field-label">Seasons</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input
                      type="checkbox"
                      checked={selectedSeasons[0] === 'all' && selectedSeasons.length === 1}
                      onChange={() => setSelectedSeasons(['all'])}
                    />
                    All Seasons
                  </label>
                  {seasons.map(s => (
                    <label key={s} style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={!selectedSeasons.includes('all') && selectedSeasons.includes(String(s))}
                        onChange={() => handleSeasonToggle(s)}
                      />
                      Season {s}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button className="chip-sm" onClick={() => setRequestItem(null)}>Cancel</button>
              <button className="chip-sm" style={{ background: 'var(--accent)', color: '#000', fontWeight: '600', border: 'none' }} onClick={handleSubmitRequest}>
                Request
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
