import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  exploreApi,
  watchlistApi,
  plexApi,
  searchApi,
  issuesApi,
  queueApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import Carousel from '../components/Carousel'
import DetailModal from '../components/DetailModal'
import SkeletonLoader from '../components/SkeletonLoader'
import ToggleSwitch from '../components/ToggleSwitch'
import Modal from '../components/Modal'
import { useToast } from '../context/ToastContext'

const GENRE_META = {
  'Action':          { gradient: 'linear-gradient(145deg, #7f1d1d 0%, #c2410c 60%, #ea580c 100%)', emoji: '💥' },
  'Adventure':       { gradient: 'linear-gradient(145deg, #164e63 0%, #0369a1 60%, #0891b2 100%)', emoji: '🗺️' },
  'Animation':       { gradient: 'linear-gradient(145deg, #4c1d95 0%, #7c3aed 60%, #a855f7 100%)', emoji: '✨' },
  'Comedy':          { gradient: 'linear-gradient(145deg, #78350f 0%, #d97706 60%, #fbbf24 100%)', emoji: '😂' },
  'Crime':           { gradient: 'linear-gradient(145deg, #0f172a 0%, #1e293b 60%, #334155 100%)', emoji: '🔫' },
  'Documentary':     { gradient: 'linear-gradient(145deg, #14532d 0%, #15803d 60%, #4ade80 100%)', emoji: '🎥' },
  'Drama':           { gradient: 'linear-gradient(145deg, #3b0764 0%, #6d28d9 60%, #8b5cf6 100%)', emoji: '🎭' },
  'Fantasy':         { gradient: 'linear-gradient(145deg, #312e81 0%, #4338ca 60%, #818cf8 100%)', emoji: '🧙' },
  'Horror':          { gradient: 'linear-gradient(145deg, #1a0000 0%, #7f1d1d 60%, #b91c1c 100%)', emoji: '💀' },
  'Mystery':         { gradient: 'linear-gradient(145deg, #0c1a3b 0%, #1e3a5f 60%, #1d4ed8 100%)', emoji: '🔍' },
  'Romance':         { gradient: 'linear-gradient(145deg, #500724 0%, #be185d 60%, #f472b6 100%)', emoji: '❤️' },
  'Science Fiction': { gradient: 'linear-gradient(145deg, #0c4a6e 0%, #0e7490 60%, #22d3ee 100%)', emoji: '🚀' },
  'Thriller':        { gradient: 'linear-gradient(145deg, #0c0a09 0%, #292524 60%, #57534e 100%)', emoji: '🔪' },
  'War':             { gradient: 'linear-gradient(145deg, #1c1009 0%, #44301e 60%, #78716c 100%)', emoji: '🪖' },
  'Western':         { gradient: 'linear-gradient(145deg, #451a03 0%, #92400e 60%, #d97706 100%)', emoji: '🤠' },
  'Family':          { gradient: 'linear-gradient(145deg, #064e3b 0%, #059669 60%, #34d399 100%)', emoji: '🏡' },
  'Music':           { gradient: 'linear-gradient(145deg, #4a044e 0%, #86198f 60%, #e879f9 100%)', emoji: '🎵' },
  'Reality':         { gradient: 'linear-gradient(145deg, #7c2d12 0%, #c2410c 60%, #fb923c 100%)', emoji: '📺' },
}
const GENRES = Object.keys(GENRE_META)

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
  const [buildProgress, setBuildProgress] = useState(0)
  const intervalRef = useRef(null)
  const pollingRef = useRef(false)
  const buildStartRef = useRef(null)

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
        if (!buildStartRef.current) buildStartRef.current = Date.now()
        setBuilding(true)
        if (!pollingRef.current) {
          pollingRef.current = true
          setPolling(true)
          intervalRef.current = setInterval(async () => {
            try {
              const { data: pollData } = await exploreApi.getRecommendations(params)
              if (pollData.status !== 'building') {
                clearInterval(intervalRef.current)
                pollingRef.current = false
                buildStartRef.current = null
                setBuilding(false)
                setPolling(false)
                setRecommendations(pollData)
              }
            } catch { /* ignore */ }
          }, 5000)
        }
        return
      }
      buildStartRef.current = null
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
  }, [matureEnabled, hideRequested, toastError])

  useEffect(() => {
    loadServices()
    loadWatchlist()
  }, [loadServices, loadWatchlist])

  useEffect(() => {
    fetchRecommendations(false)
  }, [fetchRecommendations])

  // Clear polling interval on unmount to prevent state updates on dead component
  useEffect(() => {
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  // Animate progress bar while building — asymptotic curve toward 95%
  useEffect(() => {
    if (!building) { setBuildProgress(0); return }
    const tick = setInterval(() => {
      const elapsed = buildStartRef.current ? (Date.now() - buildStartRef.current) / 1000 : 0
      setBuildProgress(95 * (1 - Math.exp(-elapsed / 150)))
    }, 1000)
    return () => clearInterval(tick)
  }, [building])

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

  const handleNotify = useCallback(async (item) => {
    try {
      await exploreApi.followRecommendation(item.tmdbId, item.mediaType)
      setRecommendations(prev => {
        if (!prev) return prev
        const updateItem = (items) => items.map(i => {
          if (i.tmdbId === item.tmdbId && i.mediaType === item.mediaType) {
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
      toastSuccess('You\'ll be notified when ' + item.title + ' is available')
    } catch (e) {
      toastError('Notify failed')
    }
  }, [toastSuccess, toastError])

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

  const handleSubmitRequest = useCallback(async (service) => {
    if (!requestItem) return
    const seasons = selectedSeasons[0] === 'all' || selectedSeasons.length === 0 ? null : selectedSeasons.map(Number)

    try {
      await queueApi.createRequest({
        tmdbId: requestItem.tmdbId,
        mediaType: requestItem.mediaType,
        title: requestItem.title,
        year: requestItem.year || null,
        service: service || services.defaultService || 'overseerr',
        seasons: seasons,
      })
      toastSuccess('Request submitted for ' + requestItem.title)
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
      const msg = e.response?.data?.error || e.response?.data?.message || e.message || 'Request failed'
      toastError(msg)
    }
  }, [requestItem, selectedSeasons, toastSuccess, toastError, services])

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
          <div style={{ padding: '28px 24px 20px', maxWidth: '480px', margin: '0 auto' }}>
            <p style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '6px' }}>Building your recommendations…</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginBottom: '14px' }}>Analyzing your watch history and preferences. This takes a few minutes on first run.</p>
            <div style={{ background: 'var(--bg-secondary)', borderRadius: '999px', height: '8px', overflow: 'hidden', border: '1px solid var(--border)' }}>
              <div style={{ height: '100%', width: `${buildProgress}%`, background: 'var(--accent)', borderRadius: '999px', transition: 'width 1s linear' }} />
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: '6px', textAlign: 'right' }}>{Math.round(buildProgress)}%</p>
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
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => handleOpenModal(item)}>
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
                            {!item.ratingKey && (
                              <button
                                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? handleNotify(item) : openRequestDialog(item)) }}
                                disabled={item.isMyRequest}
                              >
                                {item.isMyRequest ? 'Requested ✓' : (item.isRequested ? 'Notify Me' : 'Request')}
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
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => handleOpenModal(item)}>
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
                            {!item.ratingKey && (
                              <button
                                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? handleNotify(item) : openRequestDialog(item)) }}
                                disabled={item.isMyRequest}
                              >
                                {item.isMyRequest ? 'Requested ✓' : (item.isRequested ? 'Notify Me' : 'Request')}
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
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => handleOpenModal(item)}>
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
                            {!item.ratingKey && (
                              <button
                                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? handleNotify(item) : openRequestDialog(item)) }}
                                disabled={item.isMyRequest}
                              >
                                {item.isMyRequest ? 'Requested ✓' : (item.isRequested ? 'Notify Me' : 'Request')}
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
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => handleOpenModal(item)}>
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
                            {!item.ratingKey && (
                              <button
                                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? handleNotify(item) : openRequestDialog(item)) }}
                                disabled={item.isMyRequest}
                              >
                                {item.isMyRequest ? 'Requested ✓' : (item.isRequested ? 'Notify Me' : 'Request')}
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

            {filteredRecommendations()?.trendingMovies && filteredRecommendations().trendingMovies.length >= 8 && (
              <section className="section" id="section-trending-movies">
                <div className="section-header">
                  <h2 className="section-title">Trending Movies</h2>
                  <span className="section-badge">Outside Your Library</span>
                </div>
                <Carousel>
                  {filteredItems(filteredRecommendations()?.trendingMovies).map(item => (
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => handleOpenModal(item)}>
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
                            {!item.ratingKey && (
                              <button
                                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? handleNotify(item) : openRequestDialog(item)) }}
                                disabled={item.isMyRequest}
                              >
                                {item.isMyRequest ? 'Requested ✓' : (item.isRequested ? 'Notify Me' : 'Request')}
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

            {filteredRecommendations()?.trendingTV && filteredRecommendations().trendingTV.length >= 8 && (
              <section className="section" id="section-trending-tv">
                <div className="section-header">
                  <h2 className="section-title">Trending TV Shows</h2>
                  <span className="section-badge">Outside Your Library</span>
                </div>
                <Carousel>
                  {filteredItems(filteredRecommendations()?.trendingTV).map(item => (
                    <div key={item.tmdbId + item.mediaType} className="card" data-tmdb-id={item.tmdbId} data-adult={item.adult ? 'true' : undefined} data-request-tmdb={item.tmdbId} onClick={() => handleOpenModal(item)}>
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
                            {!item.ratingKey && (
                              <button
                                className={'btn-icon btn-request' + (item.isMyRequest ? ' btn-request-sent' : '')}
                                onClick={(e) => { e.stopPropagation(); !item.isMyRequest && (item.isRequested ? handleNotify(item) : openRequestDialog(item)) }}
                                disabled={item.isMyRequest}
                              >
                                {item.isMyRequest ? 'Requested ✓' : (item.isRequested ? 'Notify Me' : 'Request')}
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
        <section className="section" id="section-genre-browse">
          <div className="section-header">
            <h2 className="section-title">Browse by Genre</h2>
          </div>
          <Carousel variant="genre">
            {GENRES.map((genre, idx) => {
              const meta = GENRE_META[genre] || { gradient: 'linear-gradient(145deg, #1e293b, #334155)', emoji: '🎬' }
              return (
                <Link
                  key={`${genre}-${idx}`}
                  to={`/search?genre=${encodeURIComponent(genre)}`}
                  className="genre-tile"
                  style={{ background: meta.gradient }}
                >
                  <span className="genre-tile-emoji">{meta.emoji}</span>
                  <div className="genre-tile-footer">
                    <span className="genre-tile-name">{genre}</span>
                  </div>
                </Link>
              )
            })}
          </Carousel>
        </section>
      </main>

      {selectedItem && (
        <DetailModal
          item={{
            ...selectedItem,
            type: selectedItem.mediaType === 'tv' ? 'show' : 'movie',
            thumb: selectedItem.posterUrl,
            art: selectedItem.backdropUrl,
            mediaType: selectedItem.mediaType,
            inLibrary: !!selectedItem.ratingKey,
          }}
          onClose={() => setSelectedItem(null)}
          onRequest={openRequestDialog}
          onNotify={() => {
            setRequestItem(selectedItem)
            setSelectedItem(null)
          }}
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
                <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>Seasons</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  <button
                    type="button"
                    className={'chip-sm' + (selectedSeasons[0] === 'all' ? ' active' : '')}
                    style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => setSelectedSeasons(['all'])}
                  >
                    All
                  </button>
                  {seasons.map(s => (
                    <button
                      type="button"
                      key={s}
                      className={'chip-sm' + (!selectedSeasons.includes('all') && selectedSeasons.includes(String(s)) ? ' active' : '')}
                      style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                      onClick={() => handleSeasonToggle(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(() => {
              const hasOverseerr = services.overseerr
              const hasRiven = services.riven
              const hasDirect = requestItem.mediaType === 'movie' ? services.radarr : services.sonarr
              const directName = requestItem.mediaType === 'movie' ? 'Radarr' : 'Sonarr'
              const directSvc = requestItem.mediaType === 'movie' ? 'radarr' : 'sonarr'
              const hasAggregator = hasOverseerr || hasRiven
              const defaultAggregator = hasOverseerr ? 'overseerr' : (hasRiven ? 'riven' : null)
              const hasBothSides = hasAggregator && hasDirect
              const defaultSvc = !hasOverseerr && !hasRiven && !hasDirect ? 'none'
                : hasBothSides
                  ? (services.defaultService === 'direct' ? directSvc : defaultAggregator)
                  : hasAggregator ? defaultAggregator : directSvc
              const altOptions = []
              if (defaultSvc !== 'overseerr' && hasOverseerr) altOptions.push({ svc: 'overseerr', name: 'Overseerr' })
              if (defaultSvc !== 'riven' && hasRiven) altOptions.push({ svc: 'riven', name: 'Riven' })
              if (defaultSvc !== directSvc && hasDirect) altOptions.push({ svc: directSvc, name: directName })
              return (
                <>
                  {altOptions.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <button
                        type="button"
                        className="chip-sm"
                        style={{ border: '1px solid var(--border)', cursor: 'pointer', width: '100%', textAlign: 'center' }}
                        onClick={(e) => {
                          const panel = document.getElementById('request-adv-panel')
                          const toggle = document.getElementById('request-adv-toggle')
                          if (panel) {
                            const isOpen = panel.style.display !== 'none'
                            panel.style.display = isOpen ? 'none' : ''
                            toggle.textContent = isOpen ? 'Advanced ▸' : 'Advanced ▾'
                          }
                        }}
                        id="request-adv-toggle"
                      >
                        Advanced ▸
                      </button>
                      <div id="request-adv-panel" style={{ display: 'none', marginTop: '8px' }}>
                        {altOptions.map(opt => (
                          <button
                            key={opt.svc}
                            type="button"
                            className="chip-sm"
                            style={{ border: '1px solid var(--border)', cursor: 'pointer', width: '100%', marginBottom: '6px', textAlign: 'left' }}
                            onClick={() => handleSubmitRequest(opt.svc)}
                          >
                            Send to {opt.name} instead
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
                    <button className="chip-sm" onClick={() => setRequestItem(null)}>Cancel</button>
                    <button className="chip-sm" style={{ background: 'var(--accent)', color: '#000', fontWeight: '600', border: 'none' }} onClick={() => handleSubmitRequest(defaultSvc)}>
                      Request
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </Modal>
    </>
  )
}
