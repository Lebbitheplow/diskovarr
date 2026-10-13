import React, { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  recommendationsApi,
  popularApi,
  libraryApi,
  watchlistApi,
  searchApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import Carousel from '../components/Carousel'
import SpotlightHero from '../components/SpotlightHero'
import WrappedBanner from '../components/wrapped/WrappedBanner'
import DetailModal from '../components/DetailModal'
import SkeletonLoader from '../components/SkeletonLoader'
import ToggleSwitch from '../components/ToggleSwitch'
import GenreTiles from '../components/GenreTiles'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'
import { withViewTransition } from '../utils/viewTransition'
import { capturePositions, restorePositions } from '../utils/listRestore'

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
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const { error: toastError, success: toastSuccess, withAction: toastUndo } = useToast()
  const { user } = useAuth()

  const [recommendations, setRecommendations] = useState(null)
  const [loading, setLoading] = useState(true)
  const [popular, setPopular] = useState(null)
  const [popularLoading, setPopularLoading] = useState(true)
  const [matureEnabled, setMatureEnabledState] = useState(isMatureEnabled())
  const [shuffling, setShuffling] = useState(false)
  // The shuffle glyph keeps turning until the turn it is on completes, so it
  // comes to rest upright instead of snapping or unwinding
  const [spinning, setSpinning] = useState(false)
  // Keys the recommendation shelves, so each shuffle lands as fresh tracks
  // scrolled back to their start
  const [shuffleGen, setShuffleGen] = useState(0)
  const [selectedItem, setSelectedItem] = useState(null)
  const [watchlistCache, setWatchlistCache] = useState({})

  const openModalParam = searchParams.get('openModal')
  const mediaTypeParam = searchParams.get('mediaType')

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {};
      (data.items || []).forEach(item => {
        cache[item.ratingKey] = true
      })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  // Resolves to the picks to show (null when the server sent nothing); throws
  // on failure so each caller can word its own error.
  const loadRecommendations = useCallback(async (showMature) => {
    const { data } = await recommendationsApi.getRecommendations()
    if (!data) return null
    if (showMature !== false) return data
    const filterItems = (items) => items.filter(item => {
      return !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
    })
    return {
      topPicks: filterItems(data.topPicks || []),
      movies: filterItems(data.movies || []),
      tvShows: filterItems(data.tvShows || []),
      anime: filterItems(data.anime || []),
    }
  }, [])

  const fetchRecommendations = useCallback(async (showMature) => {
    setLoading(true)
    try {
      const next = await loadRecommendations(showMature)
      if (next) setRecommendations(next)
    } catch (e) {
      toastError(t('Failed to load recommendations. Please refresh.'))
    } finally {
      setLoading(false)
    }
  }, [loadRecommendations, toastError, t])

  useEffect(() => {
    ;(async () => { await fetchRecommendations(matureEnabled) })()
  }, [matureEnabled, fetchRecommendations])

  useEffect(() => {
    ;(async () => { await loadWatchlist() })()
  }, [loadWatchlist])

  const fetchPopular = useCallback(async () => {
    setPopularLoading(true)
    try {
      const { data } = await popularApi.getPopular()
      setPopular(data || { movies: [], tvShows: [] })
    } catch {
      setPopular({ movies: [], tvShows: [] })
    } finally {
      setPopularLoading(false)
    }
  }, [])

  useEffect(() => {
    ;(async () => { await fetchPopular() })()
  }, [fetchPopular])

  useEffect(() => {
    if (!openModalParam || !mediaTypeParam) return
    const tmdbId = openModalParam
    const mediaType = mediaTypeParam
    history.replaceState(null, '', window.location.pathname)

    searchApi.getDetails(tmdbId, mediaType)
      .then(({ data }) => {
        if (data) {
          // Keep the whole resolved item (library state, isRequested, links,
          // structured credits…) so the modal acts as it does from any other
          // page; only the display fields DetailModal reads are mapped.
          setSelectedItem({
            ...data,
            tmdbId: data.tmdbId || tmdbId,
            mediaType,
            type: mediaType === 'tv' ? 'show' : 'movie',
            thumb: data.posterUrl || data.thumb || null,
            art: data.backdropUrl || data.art || null,
            summary: data.summary || data.overview || '',
          })
        }
      })
      .catch(() => {})
  }, [openModalParam, mediaTypeParam])

  // The current picks stay on screen until the new ones replace them in a
  // single update. Clearing them first (with loading still false) dropped the
  // hero and every shelf for the length of the request, collapsing the page.
  const handleShuffle = useCallback(async () => {
    setShuffling(true)
    setSpinning(true)
    try {
      const next = await loadRecommendations(matureEnabled)
      if (next) {
        setRecommendations(next)
        setShuffleGen(g => g + 1)
      }
    } catch (e) {
      toastError(t('Failed to shuffle recommendations'))
    } finally {
      setShuffling(false)
    }
  }, [matureEnabled, loadRecommendations, toastError, t])

  const handleMatureChange = useCallback((checked) => {
    setMatureEnabledState(checked)
    setMatureEnabled(checked)
  }, [])

  // Morphs the clicked poster into the modal's poster where the browser
  // supports view transitions; a plain state update everywhere else.
  const handleOpenModal = useCallback((item) => {
    withViewTransition(() => setSelectedItem(item))
  }, [])

  const handleToggleWatchlist = useCallback(async (item) => {
    const ratingKey = item.ratingKey
    const isInWatchlist = watchlistCache[ratingKey] || false
    try {
      if (isInWatchlist) {
        await watchlistApi.removeFromWatchlist(ratingKey)
        setWatchlistCache(prev => { const next = { ...prev }; delete next[ratingKey]; return next })
        toastSuccess(t('Removed from watchlist'))
      } else {
        await watchlistApi.addToWatchlist(ratingKey)
        setWatchlistCache(prev => ({ ...prev, [ratingKey]: true }))
        toastSuccess(t('Added to watchlist'))
      }
    } catch (e) {
      toastError(e.message || t('Watchlist action failed'))
    }
  }, [watchlistCache, toastSuccess, toastError, t])

  // Dismissing is easy to do by accident, so it is offered back as an undo
  // rather than guarded by a confirm dialog — the restore endpoint already
  // exists, and a prompt on every dismiss punishes deliberate use.
  const handleDismiss = useCallback(async (item) => {
    const key = item.ratingKey
    const matches = (i) => i.ratingKey === key
    const positions = capturePositions(recommendations, matches)
    try {
      await libraryApi.dismissItem(key)
      setRecommendations(prev => {
        if (!prev) return prev
        return {
          topPicks: prev.topPicks.filter(i => !matches(i)),
          movies: prev.movies.filter(i => !matches(i)),
          tvShows: prev.tvShows.filter(i => !matches(i)),
          anime: prev.anime.filter(i => !matches(i)),
        }
      })
      toastUndo(t('Not interested'), t('Undo'), async () => {
        try {
          await libraryApi.restoreItem(key)
          setRecommendations(prev => restorePositions(prev, positions, item, matches))
          toastSuccess(t('Restored'))
        } catch (e) {
          toastError(t('Restore failed'))
        }
      })
    } catch (e) {
      toastError(t('Dismiss failed'))
    }
  }, [recommendations, toastUndo, toastSuccess, toastError, t])

  const handleModalClose = useCallback(() => {
    setSelectedItem(null)
  }, [])

  const handleModalRefresh = useCallback(() => {
    loadWatchlist()
  }, [loadWatchlist])

  // These four stripped mature content unconditionally, which meant the
  // "Show mature content" toggle only ever affected the popular shelves below.
  // Gated on matureEnabled now, so the toggle governs every shelf on the page.
  const showTopPicks = (recommendations?.topPicks || []).filter(item =>
    matureEnabled || !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showMovies = (recommendations?.movies || []).filter(item =>
    matureEnabled || !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showTvShows = (recommendations?.tvShows || []).filter(item =>
    matureEnabled || !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showAnime = (recommendations?.anime || []).filter(item =>
    matureEnabled || !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  // Popular = server-wide "what's trending" stats. Respect the mature toggle (show mature when
  // enabled) so the lists stay populated rather than always stripping R / TV-MA content.
  const showPopularMovies = (popular?.movies || []).filter(item =>
    matureEnabled || !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )
  const showPopularTvShows = (popular?.tvShows || []).filter(item =>
    matureEnabled || !item.contentRating || !MATURE_RATINGS.has(item.contentRating.toLowerCase())
  )

  return (
    <>
      <SpotlightHero
        items={showTopPicks}
        loading={loading}
        onOpenModal={handleOpenModal}
        onToggleWatchlist={handleToggleWatchlist}
        isInWatchlist={(it) => !!watchlistCache[it?.ratingKey]}
      />
      <main className="main-content">
        <div className="hero">
          <h1 className="hero-title">
            {t('Welcome back')}{user?.username ? <>, <span style={{ color: 'var(--accent)' }}>{user.username}</span></> : ''}
          </h1>
          <p className="hero-sub">{t('Personalized picks based on your watch history')}</p>
          <div className="hero-controls hero-controls-split">
            <ToggleSwitch
              checked={matureEnabled}
              onChange={handleMatureChange}
              label={t('Show mature content (R & TV-MA)')}
            />
            <button
              type="button"
              id="btn-shuffle-all"
              className="btn-shuffle-all"
              title={t('Refresh picks')}
              onClick={handleShuffle}
              disabled={shuffling}
              style={spinning ? { animation: 'spin 0.6s linear infinite' } : undefined}
              onAnimationIteration={() => { if (!shuffling) setSpinning(false) }}
              // Reduced motion cuts the spin to a single instant pass
              onAnimationEnd={() => setSpinning(false)}
            >
              ↺
            </button>
          </div>
        </div>

        <WrappedBanner />

        {loading ? (
          <>
            <section className="section" id="section-top-picks">
              <div className="section-header">
                <h2 className="section-title">{t('Top Picks for You')}</h2>
                <span className="section-badge">{t('Personalized')}</span>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-movies">
              <div className="section-header">
                <h2 className="section-title">{t('Movies')}</h2>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-tv">
              <div className="section-header">
                <h2 className="section-title">{t('TV Shows')}</h2>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-anime">
              <div className="section-header">
                <h2 className="section-title">{t('Anime')}</h2>
              </div>
              <SkeletonLoader count={12} rows={2} />
            </section>
            <section className="section" id="section-genre-browse">
              <div className="section-header">
                <h2 className="section-title">{t('Browse by Genre')}</h2>
              </div>
              <GenreTiles linkFor={(genre) => `/discover?genre=${encodeURIComponent(genre)}`} />
            </section>

            {popularLoading && (
              <>
                <section className="section" id="section-popular-movies">
                  <div className="section-header">
                    <h2 className="section-title">{t('Most Popular Movies on the Server')}</h2>
                    <span className="section-badge">{t('Last 90 Days')}</span>
                  </div>
                  <SkeletonLoader count={12} rows={2} />
                </section>
                <section className="section" id="section-popular-tv">
                  <div className="section-header">
                    <h2 className="section-title">{t('Most Popular TV Shows on the Server')}</h2>
                    <span className="section-badge">{t('Last 90 Days')}</span>
                  </div>
                  <SkeletonLoader count={12} rows={2} />
                </section>
              </>
            )}
          </>
        ) : (
          <>
            {showTopPicks.length > 0 && (
              <section className="section" id="section-top-picks">
                <div className="section-header">
                  <h2 className="section-title">{t('Top Picks for You')}</h2>
                  <span className="section-badge">{t('Personalized')}</span>
                </div>
                <Carousel key={shuffleGen}>
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
                  <h2 className="section-title">{t('Movies')}</h2>
                </div>
                <Carousel key={shuffleGen}>
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
                  <h2 className="section-title">{t('TV Shows')}</h2>
                </div>
                <Carousel key={shuffleGen}>
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
                  <h2 className="section-title">{t('Anime')}</h2>
                </div>
                <Carousel key={shuffleGen}>
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

            <section className="section" id="section-genre-browse">
              <div className="section-header">
                <h2 className="section-title">{t('Browse by Genre')}</h2>
              </div>
              <GenreTiles linkFor={(genre) => `/discover?genre=${encodeURIComponent(genre)}`} />
            </section>

            {showPopularMovies.length > 0 && (
              <section className="section" id="section-popular-movies">
                <div className="section-header">
                  <h2 className="section-title">{t('Most Popular Movies on the Server')}</h2>
                  <span className="section-badge">{t('Last 90 Days')}</span>
                </div>
                <Carousel>
                  {showPopularMovies.map(item => (
                    <MediaCard
                      key={item.ratingKey}
                      item={{ ...item, mediaType: 'movie' }}
                      variant="home"
                      onOpenModal={handleOpenModal}
                      onToggleWatchlist={handleToggleWatchlist}
                      onDismiss={handleDismiss}
                      isInWatchlist={!!watchlistCache[item.ratingKey]}
                      isWatched={item.isWatched}
                    />
                  ))}
                </Carousel>
              </section>
            )}

            {showPopularTvShows.length > 0 && (
              <section className="section" id="section-popular-tv">
                <div className="section-header">
                  <h2 className="section-title">{t('Most Popular TV Shows on the Server')}</h2>
                  <span className="section-badge">{t('Last 90 Days')}</span>
                </div>
                <Carousel>
                  {showPopularTvShows.map(item => (
                    <MediaCard
                      key={item.ratingKey}
                      item={{ ...item, mediaType: 'tv' }}
                      variant="home"
                      onOpenModal={handleOpenModal}
                      onToggleWatchlist={handleToggleWatchlist}
                      onDismiss={handleDismiss}
                      isInWatchlist={!!watchlistCache[item.ratingKey]}
                      isWatched={item.isWatched}
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
