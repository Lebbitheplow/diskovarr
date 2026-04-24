import React, { useState, useCallback, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  recommendationsApi,
  plexApi,
  watchlistApi,
  searchApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import Carousel from '../components/Carousel'
import DetailModal from '../components/DetailModal'
import SkeletonLoader from '../components/SkeletonLoader'
import ToggleSwitch from '../components/ToggleSwitch'
import { useToast } from '../context/ToastContext'

const MATURE_RATINGS = new Set(['r', 'tv-ma', 'nc-17', 'x', 'nr'])

function isMatureEnabled() {
  return localStorage.getItem('matureEnabled') === 'true'
}

function setMatureEnabled(checked) {
  localStorage.setItem('matureEnabled', checked ? 'true' : 'false')
  fetch('/api/user/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ show_mature: checked }),
  }).catch(() => {})
}

export default function Home() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { error: toastError, success: toastSuccess } = useToast()

  const [recommendations, setRecommendations] = useState(null)
  const [loading, setLoading] = useState(true)
  const [matureEnabled, setMatureEnabledState] = useState(isMatureEnabled())
  const [shuffling, setShuffling] = useState(false)
  const [selectedItem, setSelectedItem] = useState(null)
  const [watchlistCache, setWatchlistCache] = useState({})
  const [matureLoading, setMatureLoading] = useState(false)

  const openModalParam = searchParams.get('openModal')
  const mediaTypeParam = searchParams.get('mediaType')

  const hasMatureItems = useCallback((items) => {
    if (!items) return false
    return items.some(item => item.contentRating && MATURE_RATINGS.has(item.contentRating.toLowerCase()))
  }, [])

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {}
      (data.items || []).forEach(item => {
        cache[item.ratingKey] = true
      })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  const fetchRecommendations = useCallback(async (showMature) => {
    setLoading(true)
    try {
      const { data } = await recommendationsApi.getRecommendations()
      if (data) {
        if (showMature === false) {
          const filterItems = (items) => items.filter(item => {
            return !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
          })
          setRecommendations({
            topPicks: filterItems(data.topPicks || []),
            movies: filterItems(data.movies || []),
            tvShows: filterItems(data.tvShows || []),
            anime: filterItems(data.anime || []),
          })
        } else {
          setRecommendations(data)
        }
      }
    } catch (e) {
      toastError('Failed to load recommendations. Please refresh.')
    } finally {
      setLoading(false)
    }
  }, [toastError])

  useEffect(() => {
    fetchRecommendations(matureEnabled)
  }, [matureEnabled, fetchRecommendations])

  useEffect(() => {
    loadWatchlist()
  }, [loadWatchlist])

  useEffect(() => {
    if (!openModalParam || !mediaTypeParam) return
    const tmdbId = openModalParam
    const mediaType = mediaTypeParam
    history.replaceState(null, '', window.location.pathname)

    searchApi.getDetails(tmdbId, mediaType)
      .then(({ data }) => {
        if (data) {
          setSelectedItem({
            ratingKey: data.ratingKey || null,
            title: data.title,
            year: data.year,
            type: mediaType === 'tv' ? 'show' : 'movie',
            thumb: data.posterUrl || data.thumb || null,
            art: data.backdropUrl || data.art || null,
            rating: data.rating || null,
            audienceRating: data.audienceRating || null,
            contentRating: data.contentRating || null,
            genres: data.genres || [],
            summary: data.summary || data.overview || '',
            directors: data.directors || [],
            cast: data.cast || [],
            studio: data.studio || null,
            tmdbId: tmdbId,
            isWatched: data.isWatched || false,
            isInWatchlist: data.isInWatchlist || false,
          })
        }
      })
      .catch(() => {})
  }, [openModalParam, mediaTypeParam])

  const handleShuffle = useCallback(async () => {
    setShuffling(true)
    setMatureLoading(true)
    const prev = recommendations
    setRecommendations(null)

    setTimeout(async () => {
      try {
        await fetchRecommendations(matureEnabled)
      } catch (e) {
        setRecommendations(prev)
        toastError('Failed to shuffle recommendations')
      } finally {
        setShuffling(false)
        setMatureLoading(false)
      }
    }, 400)
  }, [matureEnabled, recommendations, fetchRecommendations, toastError])

  const handleMatureChange = useCallback((checked) => {
    setMatureEnabledState(checked)
    setMatureEnabled(checked)
  }, [])

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
      await plexApi.dismissItem(item.ratingKey)
      const key = item.ratingKey
      setRecommendations(prev => {
        if (!prev) return prev
        return {
          topPicks: prev.topPicks.filter(i => i.ratingKey !== key),
          movies: prev.movies.filter(i => i.ratingKey !== key),
          tvShows: prev.tvShows.filter(i => i.ratingKey !== key),
          anime: prev.anime.filter(i => i.ratingKey !== key),
        }
      })
      toastSuccess('Not interested')
    } catch (e) {
      toastError('Dismiss failed')
    }
  }, [toastSuccess, toastError])

  const handleModalClose = useCallback(() => {
    setSelectedItem(null)
  }, [])

  const handleModalRefresh = useCallback(() => {
    loadWatchlist()
  }, [loadWatchlist])

  const showTopPicks = (recommendations?.topPicks || []).filter(item =>
    !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showMovies = (recommendations?.movies || []).filter(item =>
    !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showTvShows = (recommendations?.tvShows || []).filter(item =>
    !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showAnime = (recommendations?.anime || []).filter(item =>
    !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )

  const username = window.location.href.includes('welcome=1') ? '' : ''

  return (
    <>
      <main className="main-content">
        <div className="hero">
          <h1 className="hero-title">Welcome back</h1>
          <p className="hero-sub">Personalized picks based on your watch history</p>
          <div className="hero-controls hero-controls-split">
            <ToggleSwitch
              checked={matureEnabled}
              onChange={handleMatureChange}
              label="Show mature content (R & TV-MA)"
            />
            <button
              type="button"
              id="btn-shuffle-all"
              className="btn-shuffle-all"
              title="Refresh picks"
              onClick={handleShuffle}
              disabled={shuffling}
              style={{ transition: 'transform 0.4s ease', transform: shuffling ? 'rotate(360deg)' : '' }}
            >
              {matureLoading ? '' : '↺'}
            </button>
          </div>
        </div>

        {loading ? (
          <>
            <section className="section" id="section-top-picks">
              <div className="section-header">
                <h2 className="section-title">Top Picks for You</h2>
                <span className="section-badge">Personalized</span>
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
            {showTopPicks.length > 0 && (
              <section className="section" id="section-top-picks">
                <div className="section-header">
                  <h2 className="section-title">Top Picks for You</h2>
                  <span className="section-badge">Personalized</span>
                </div>
                <Carousel>
                  {showTopPicks.map(item => (
                    <MediaCard
                      key={item.ratingKey}
                      item={{ ...item, mediaType: 'movie' }}
                      variant="home"
                      onOpenModal={handleOpenModal}
                      onToggleWatchlist={handleToggleWatchlist}
                      onDismiss={handleDismiss}
                      isInWatchlist={!!watchlistCache[item.ratingKey]}
                    />
                  ))}
                </Carousel>
              </section>
            )}

            {showMovies.length > 0 && (
              <section className="section" id="section-movies">
                <div className="section-header">
                  <h2 className="section-title">Movies</h2>
                </div>
                <Carousel>
                  {showMovies.map(item => (
                    <MediaCard
                      key={item.ratingKey}
                      item={{ ...item, mediaType: 'movie' }}
                      variant="home"
                      onOpenModal={handleOpenModal}
                      onToggleWatchlist={handleToggleWatchlist}
                      onDismiss={handleDismiss}
                      isInWatchlist={!!watchlistCache[item.ratingKey]}
                    />
                  ))}
                </Carousel>
              </section>
            )}

            {showTvShows.length > 0 && (
              <section className="section" id="section-tv">
                <div className="section-header">
                  <h2 className="section-title">TV Shows</h2>
                </div>
                <Carousel>
                  {showTvShows.map(item => (
                    <MediaCard
                      key={item.ratingKey}
                      item={{ ...item, mediaType: 'tv' }}
                      variant="home"
                      onOpenModal={handleOpenModal}
                      onToggleWatchlist={handleToggleWatchlist}
                      onDismiss={handleDismiss}
                      isInWatchlist={!!watchlistCache[item.ratingKey]}
                    />
                  ))}
                </Carousel>
              </section>
            )}

            {showAnime.length > 0 && (
              <section className="section" id="section-anime">
                <div className="section-header">
                  <h2 className="section-title">Anime</h2>
                </div>
                <Carousel>
                  {showAnime.map(item => (
                    <MediaCard
                      key={item.ratingKey}
                      item={{ ...item, mediaType: item.isAnime ? 'anime' : 'movie' }}
                      variant="home"
                      onOpenModal={handleOpenModal}
                      onToggleWatchlist={handleToggleWatchlist}
                      onDismiss={handleDismiss}
                      isInWatchlist={!!watchlistCache[item.ratingKey]}
                    />
                  ))}
                </Carousel>
              </section>
            )}
          </>
        )}
      </main>
      {selectedItem && (
        <DetailModal
          item={selectedItem}
          onClose={handleModalClose}
          onRefresh={handleModalRefresh}
        />
      )}
    </>
  )
}
