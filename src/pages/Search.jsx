import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import FilterBar from '../components/FilterBar'
import {
  searchApi,
  watchlistApi,
  exploreApi,
  queueApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import Carousel from '../components/Carousel'
import SkeletonLoader from '../components/SkeletonLoader'
import DetailModal from '../components/DetailModal'
import Modal from '../components/Modal'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { posterUrl } from '../utils/media'
import { useTranslation } from 'react-i18next'

export default function Search() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { error: toastError, success: toastSuccess } = useToast()
  const { user } = useAuth()
  const isAdmin = !!(user?.isAdmin)

  // URL is the source of truth for committed search state
  const urlQuery = searchParams.get('q') || ''
  const urlGenre = searchParams.get('genre') || ''
  const selectedTmdbId = searchParams.get('selectedTmdbId') || ''
  const selectedType = searchParams.get('selectedType') || ''
  const personId = searchParams.get('personId') || ''
  const personName = searchParams.get('personName') || ''

  const [inputValue, setInputValue] = useState(urlQuery)
  const [activeTab, setActiveTab] = useState('all')
  const [hideLibrary, setHideLibrary] = useState(!!urlGenre)
  const [filterGenres, setFilterGenres] = useState([])
  const [filterYearFrom, setFilterYearFrom] = useState('')
  const [filterYearTo, setFilterYearTo] = useState('')
  const [filterContentRatings, setFilterContentRatings] = useState([])
  const [filterMinScore, setFilterMinScore] = useState(null)
  const [results, setResults] = useState([])
  const [availableContentRatings, setAvailableContentRatings] = useState([])
  const [availableGenres, setAvailableGenres] = useState([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalResults, setTotalResults] = useState(0)
  const [selectedItem, setSelectedItem] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestionIdx, setActiveSuggestionIdx] = useState(-1)
  const [watchlistCache, setWatchlistCache] = useState({})
  const [requestItem, setRequestItem] = useState(null)
  const [seasons, setSeasons] = useState([])
  const [selectedSeasons, setSelectedSeasons] = useState(['all'])
  const [services, setServices] = useState({})
  const [similarItems, setSimilarItems] = useState([])
  const [similarSourceTitle, setSimilarSourceTitle] = useState('')
  const [similarLoading, setSimilarLoading] = useState(false)
  const [personCredits, setPersonCredits] = useState([])
  const [personLoading, setPersonLoading] = useState(false)
  const suggestTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  // Guards against out-of-order responses when searches overlap (typing fast,
  // load-more racing a filter change): only the latest request may write state.
  const searchSeqRef = useRef(0)

  // Sync input box when URL changes externally (e.g. navbar search). Render-phase
  // adjustment, React's recommended alternative to a state-syncing effect.
  const [prevUrlQueryInput, setPrevUrlQueryInput] = useState(urlQuery)
  if (urlQuery !== prevUrlQueryInput) {
    setPrevUrlQueryInput(urlQuery)
    setInputValue(urlQuery)
  }

  // Reset filters, tab, and similar section when the search query/genre changes.
  // The refetch effect below picks up the reset filter snapshot on the next render.
  const searchResetKey = `${urlQuery}\u0000${urlGenre}`
  const [prevSearchResetKey, setPrevSearchResetKey] = useState(searchResetKey)
  if (searchResetKey !== prevSearchResetKey) {
    setPrevSearchResetKey(searchResetKey)
    setActiveTab('all')
    setHideLibrary(!!urlGenre)
    setFilterGenres([])
    setFilterYearFrom('')
    setFilterYearTo('')
    setFilterContentRatings([])
    setFilterMinScore(null)
    setSimilarItems([])
    setSimilarSourceTitle('')
    setPersonCredits([])
  }

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {}
      ;(data.items || []).forEach(item => { cache[item.ratingKey] = true })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  // fetchSearchResults takes args explicitly so it doesn't close over stale state
  const fetchSearchResults = useCallback(async (q, g, pg = 1, append = false, filters = {}) => {
    if (!q && !g) { setResults([]); return }
    const seq = ++searchSeqRef.current
    if (!append) setLoading(true)
    try {
      const { data } = await searchApi.search(q, pg, g || undefined, undefined, filters)
      if (seq !== searchSeqRef.current) return
      if (append) {
        setResults(prev => [...prev, ...(data.results || [])])
      } else {
        setResults(data.results || [])
      }
      setTotalPages(data.pages || 1)
      setTotalResults(data.total || 0)
      setAvailableContentRatings(data.availableContentRatings || [])
      setAvailableGenres(data.availableGenres || [])
    } catch {
      if (seq !== searchSeqRef.current) return
      toastError(t('Search failed. Please try again.'))
    } finally {
      if (seq === searchSeqRef.current) setLoading(false)
    }
  }, [toastError, t])

  // Refetch when query, genre, or any filter changes — reset to page 1
  useEffect(() => {
    ;(async () => {
      setPage(1)
      await fetchSearchResults(urlQuery, urlGenre, 1, false, {
        filterGenres,
        contentRatings: filterContentRatings,
        yearFrom: filterYearFrom,
        yearTo: filterYearTo,
        minScore: filterMinScore,
      })
    })()
  }, [urlQuery, urlGenre, filterGenres, filterContentRatings, filterYearFrom, filterYearTo, filterMinScore]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    ;(async () => {
      await loadWatchlist()
      exploreApi.getServices().then(({ data }) => setServices(data || {})).catch(() => {})
    })()
  }, [loadWatchlist])

  // Fetch "More Like This" when a specific item was selected via autocomplete
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!selectedTmdbId || !selectedType) {
        setSimilarItems([])
        setSimilarSourceTitle('')
        return
      }
      setSimilarLoading(true)
      setSimilarSourceTitle('')
      try {
        const { data } = await searchApi.getSimilar(selectedTmdbId, selectedType, hideLibrary)
        if (cancelled) return
        setSimilarSourceTitle(data.sourceTitle || '')
        setSimilarItems(data.similar || [])
      } catch {
        if (cancelled) return
        setSimilarItems([])
        setSimilarSourceTitle('')
      } finally {
        if (!cancelled) setSimilarLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedTmdbId, selectedType, hideLibrary])

  // Fetch "More with X" when a cast/crew member was opened from a detail modal.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!personId) {
        setPersonCredits([])
        return
      }
      setPersonLoading(true)
      try {
        const { data } = await searchApi.getPersonCredits(personId, hideLibrary)
        if (!cancelled) setPersonCredits(data.credits || [])
      } catch {
        if (!cancelled) setPersonCredits([])
      } finally {
        if (!cancelled) setPersonLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [personId, hideLibrary])

  const debouncedSuggestions = useCallback((q) => {
    clearTimeout(suggestTimerRef.current)
    if (q.length < 2) { setSuggestions([]); setShowSuggestions(false); return }
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchApi.getSuggestions(q)
        setSuggestions(data.results || [])
        setShowSuggestions(true)
      } catch { /* ignore */ }
    }, 280)
  }, [])

  const handleSubmit = useCallback((e) => {
    if (e && e.preventDefault) e.preventDefault()
    const q = inputValue.trim()
    if (!q) return
    setSuggestions([])
    setShowSuggestions(false)
    navigate('/search?q=' + encodeURIComponent(q))
  }, [inputValue, navigate])

  const handleInputChange = useCallback((e) => {
    setInputValue(e.target.value)
    debouncedSuggestions(e.target.value)
  }, [debouncedSuggestions])

  const handleSuggestionClick = useCallback((suggestion) => {
    setInputValue(suggestion.title)
    setSuggestions([])
    setShowSuggestions(false)
    const params = new URLSearchParams()
    params.set('q', suggestion.title)
    params.set('selectedTmdbId', suggestion.tmdbId)
    params.set('selectedType', suggestion.mediaType)
    navigate('/search?' + params.toString())
  }, [navigate])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      if (activeSuggestionIdx >= 0 && activeSuggestionIdx < suggestions.length) {
        e.preventDefault()
        handleSuggestionClick(suggestions[activeSuggestionIdx])
      } else {
        handleSubmit(e)
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestionIdx(prev => Math.min(prev + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestionIdx(prev => Math.max(prev - 1, -1))
    } else if (e.key === 'Escape') {
      setShowSuggestions(false)
      setActiveSuggestionIdx(-1)
    }
  }, [activeSuggestionIdx, suggestions, handleSuggestionClick, handleSubmit])

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

  const handleOpenModal = useCallback((item) => {
    setSelectedItem(item)
  }, [])

  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    fetchSearchResults(urlQuery, urlGenre, nextPage, true, {
      filterGenres,
      contentRatings: filterContentRatings,
      yearFrom: filterYearFrom,
      yearTo: filterYearTo,
      minScore: filterMinScore,
    })
  }, [page, urlQuery, urlGenre, fetchSearchResults, filterGenres, filterContentRatings, filterYearFrom, filterYearTo, filterMinScore])

  const handleClearGenre = useCallback(() => {
    setActiveTab('all')
    navigate('/search')
  }, [navigate])

  // Server applies all filters; hideLibrary is a view-only toggle kept client-side.
  const displayResults = useMemo(() => {
    return hideLibrary ? results.filter(i => !i.inLibrary) : results
  }, [results, hideLibrary])

  const movieResults = useMemo(() => displayResults.filter(item => item.mediaType === 'movie'), [displayResults])
  const tvResults = useMemo(() => displayResults.filter(item => item.mediaType === 'tv'), [displayResults])
  const displaySimilar = useMemo(() => {
    return hideLibrary ? similarItems.filter(i => !i.inLibrary) : similarItems
  }, [similarItems, hideLibrary])
  const displayPersonCredits = useMemo(() => {
    return hideLibrary ? personCredits.filter(i => !i.inLibrary) : personCredits
  }, [personCredits, hideLibrary])

  const handleSeasonToggle = useCallback((season) => {
    setSelectedSeasons(prev => {
      if (prev[0] === 'all' && prev.length === 1) {
        return [String(season)]
      }
      if (prev.includes(String(season))) {
        const next = prev.filter(s => String(s) !== String(season))
        return next.length === 0 ? ['all'] : next
      }
      return [...prev, String(season)]
    })
  }, [])

  const handleSeasonsFetch = useCallback(async (tmdbId) => {
    try {
      const { data } = await searchApi.getSeasons(tmdbId)
      setSeasons(data.seasons || [])
    } catch { /* ignore */ }
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
      toastSuccess(t('Request submitted for ') + requestItem.title)
      setRequestItem(null)
      setSelectedSeasons(['all'])
    } catch (e) {
      toastError(e.message || t('Request failed'))
    }
  }, [requestItem, selectedSeasons, toastSuccess, toastError, services, t])

  useEffect(() => {
    if (!requestItem) return
    ;(async () => { await handleSeasonsFetch(requestItem.tmdbId) })()
  }, [requestItem, handleSeasonsFetch])

  return (
    <main className="main-content">
      <div className="search-page-header">
        <button
          className="search-back-btn"
          aria-label={t('Back')}
          onClick={() => {
            if (history.length > 1) history.back()
            else navigate('/')
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {t('Back')}
        </button>
        <div className="search-page-query-wrap">
          <form className="search-page-form" onSubmit={handleSubmit} autocomplete="off">
            <div className="search-page-input-wrap" style={{ position: 'relative' }}>
              <svg className="search-page-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="17" height="17" fill="none" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <input
                ref={searchInputRef}
                type="search"
                name="q"
                className="search-page-input"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={t('Search movies & TV shows…')}
                spellcheck="false"
                autoFocus
              />
              {inputValue && (
                <button type="button" className="search-page-clear" onClick={() => {
                  setInputValue(''); setSuggestions([]); setShowSuggestions(false)
                  const params = new URLSearchParams(searchParams)
                  params.delete('q'); params.delete('selectedTmdbId'); params.delete('selectedType')
                  params.delete('personId'); params.delete('personName')
                  navigate('/search' + (params.toString() ? '?' + params.toString() : ''))
                }} aria-label={t('Clear')}>✕</button>
              )}
              {suggestions.length > 0 && showSuggestions && (
                <div className="search-page-dropdown open">
                  {suggestions.slice(0, 6).map((item, idx) => (
                    <div
                      key={item.tmdbId || idx}
                      className={'hero-suggest-row' + (idx === activeSuggestionIdx ? ' active' : '')}
                      onMouseDown={(e) => { e.preventDefault(); handleSuggestionClick(item) }}
                    >
                      <div className="hero-suggest-poster">
                        {item.posterUrl ? (
                          <img src={posterUrl(item.posterUrl)} alt="" loading="lazy" />
                        ) : (
                          item.title?.charAt(0) || '?'
                        )}
                      </div>
                      <div className="hero-suggest-text">
                        <span className="hero-suggest-title">{item.title}</span>
                        <span className="hero-suggest-meta">
                          {[item.year, item.mediaType === 'movie' ? 'Movie' : 'TV Show'].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                    </div>
                  ))}
                  <div
                    className="hero-suggest-row hero-suggest-all"
                    onMouseDown={(e) => { e.preventDefault(); handleSubmit() }}
                  >
                    See all results for "{inputValue.trim()}"
                  </div>
                </div>
              )}
            </div>
          </form>
        </div>
      </div>

      {(urlQuery || urlGenre) && (
        <FilterBar
          availableGenres={availableGenres}
          availableContentRatings={availableContentRatings}
          filterGenres={filterGenres}
          filterYearFrom={filterYearFrom}
          filterYearTo={filterYearTo}
          filterContentRatings={filterContentRatings}
          filterMinScore={filterMinScore}
          hideLibrary={hideLibrary}
          onGenres={setFilterGenres}
          onYearFrom={setFilterYearFrom}
          onYearTo={setFilterYearTo}
          onContentRatings={setFilterContentRatings}
          onMinScore={setFilterMinScore}
          onHideLibrary={setHideLibrary}
        />
      )}

      {results.length > 0 && (
        <div className="search-results-meta" id="search-results-header">
          <span id="search-results-count">
            {totalResults.toLocaleString()} result{totalResults !== 1 ? 's' : ''}{urlGenre ? ' in ' + urlGenre : ' for "' + urlQuery + '"'}
          </span>
          {urlGenre && (
            <div className="genre-filter-badge">
              <span>Genre: {urlGenre}</span>
              <button onClick={handleClearGenre} aria-label={t('Clear genre filter')}>×</button>
            </div>
          )}
        </div>
      )}

      {displayResults.length > 0 ? (
        urlGenre ? (
          <>
            <div className="genre-tab-bar">
              <button
                className={'genre-tab' + (activeTab === 'all' ? ' active' : '')}
                onClick={() => setActiveTab('all')}
              >
                All ({displayResults.length})
              </button>
              {movieResults.length > 0 && (
                <button
                  className={'genre-tab' + (activeTab === 'movies' ? ' active' : '')}
                  onClick={() => setActiveTab('movies')}
                >
                  Movies ({movieResults.length})
                </button>
              )}
              {tvResults.length > 0 && (
                <button
                  className={'genre-tab' + (activeTab === 'tv' ? ' active' : '')}
                  onClick={() => setActiveTab('tv')}
                >
                  TV Shows ({tvResults.length})
                </button>
              )}
            </div>
            <div className="card-grid" id="search-grid">
              {(activeTab === 'all' ? displayResults : activeTab === 'movies' ? movieResults : tvResults).map(item => (
                <div key={item.tmdbId} className="card search-card">
                  <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                    {item.posterUrl && (
                      <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />
                    )}
                    <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                    {item.inLibrary ? (
                      <span className="badge-in-library">{t('In Library')}</span>
                    ) : item.releaseDate && item.releaseDate > new Date().toISOString().slice(0, 10) ? (
                      <span className={'badge-upcoming-card' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Coming Soon'}
                      </span>
                    ) : (
                      <span className={'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Not in Library'}
                      </span>
                    )}
                    {item.isWatched && (
                      <div className="card-watched-badge" title={t('Watched')}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                    <div className="card-overlay">
                      <div className="card-overlay-actions">
                        {item.inLibrary && item.ratingKey ? (
                          <button
                            className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')}
                            onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}
                          >
                            {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                          </button>
                        ) : null}
                        {!item.inLibrary && (
                          <button
                            className={'btn-icon btn-request' + (item.isRequested ? ' btn-request-sent' : '')}
                            onClick={(e) => { e.stopPropagation(); setRequestItem(item) }}
                            disabled={item.isRequested}
                          >
                            {item.isRequested ? 'Requested ✓' : 'Request'}
                          </button>
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
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="card-grid" id="search-grid">
            {displayResults.map(item => (
              <div key={item.tmdbId} className="card search-card">
                <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                  {item.posterUrl && (
                    <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />
                  )}
                  <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                  {item.inLibrary ? (
                    <span className="badge-in-library">{t('In Library')}</span>
                  ) : item.releaseDate && item.releaseDate > new Date().toISOString().slice(0, 10) ? (
                    <span className={'badge-upcoming-card' + (item.isRequested ? ' badge-requested' : '')}>
                      {item.isRequested ? 'Requested' : 'Coming Soon'}
                    </span>
                  ) : (
                    <span className={'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '')}>
                      {item.isRequested ? 'Requested' : 'Not in Library'}
                    </span>
                  )}
                  {item.isWatched && (
                    <div className="card-watched-badge" title={t('Watched')}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  )}
                  <div className="card-overlay">
                    <div className="card-overlay-actions">
                      {item.inLibrary && item.ratingKey ? (
                        <button
                          className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')}
                          onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}
                        >
                          {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                        </button>
                      ) : null}
                      {!item.inLibrary && (
                        <button
                          className={'btn-icon btn-request' + (item.isRequested ? ' btn-request-sent' : '')}
                          onClick={(e) => { e.stopPropagation(); setRequestItem(item) }}
                          disabled={item.isRequested}
                        >
                          {item.isRequested ? 'Requested ✓' : 'Request'}
                        </button>
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
                </div>
              </div>
            ))}
          </div>
        )
      ) : personId ? null : (
        <div className="search-empty" style={{ gridColumn: '1/-1' }}>
          <p>No results found for "{urlGenre ? urlGenre : urlQuery}".</p>
        </div>
      )}

      {personId && (
        <section className="section" id="section-more-with-person">
          <div className="section-header">
            <h2 className="section-title">More with {personName || 'this person'}</h2>
            {!personLoading && (
              <span className="section-badge">
                {displayPersonCredits.length} title{displayPersonCredits.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {personLoading ? (
            <SkeletonLoader count={8} rows={1} />
          ) : displayPersonCredits.length > 0 ? (
            <Carousel>
              {displayPersonCredits.map(item => (
                <div key={item.tmdbId + item.mediaType} className="card search-card">
                  <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                    {item.posterUrl && (
                      <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />
                    )}
                    <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                    {item.inLibrary ? (
                      <span className="badge-in-library">{t('In Library')}</span>
                    ) : item.releaseDate && item.releaseDate > new Date().toISOString().slice(0, 10) ? (
                      <span className={'badge-upcoming-card' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Coming Soon'}
                      </span>
                    ) : (
                      <span className={'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Not in Library'}
                      </span>
                    )}
                    {item.isWatched && (
                      <div className="card-watched-badge" title={t('Watched')}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                    <div className="card-overlay">
                      <div className="card-overlay-actions">
                        {item.inLibrary && item.ratingKey ? (
                          <button
                            className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')}
                            onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}
                          >
                            {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                          </button>
                        ) : null}
                        {!item.inLibrary && (
                          <button
                            className={'btn-icon btn-request' + (item.isRequested ? ' btn-request-sent' : '')}
                            onClick={(e) => { e.stopPropagation(); setRequestItem(item) }}
                            disabled={item.isRequested}
                          >
                            {item.isRequested ? 'Requested ✓' : 'Request'}
                          </button>
                        )}
                      </div>
                    </div>
                  </button>
                  <div className="card-info">
                    <div className="card-title">{item.title}</div>
                    <div className="card-meta">
                      {item.year && <span className="card-year">{item.year}</span>}
                      {item.voteAverage ? <span className="card-rating">★ {item.voteAverage.toFixed(1)}</span> : null}
                    </div>
                  </div>
                </div>
              ))}
            </Carousel>
          ) : (
            <div className="search-empty">
              <p>No titles found for {personName || 'this person'}.</p>
            </div>
          )}
        </section>
      )}

      {similarSourceTitle && (
        <section className="section" id="section-more-like-this">
          <div className="section-header">
            <h2 className="section-title">{t('More Like This')}</h2>
            <span className="section-badge">
              Showing recommendations for: {similarSourceTitle}
            </span>
          </div>
          {similarLoading ? (
            <SkeletonLoader count={8} rows={1} />
          ) : displaySimilar.length > 0 ? (
            <Carousel>
              {displaySimilar.map(item => (
                <div key={item.tmdbId + item.mediaType} className="card search-card">
                  <button className="card-poster-link" onClick={() => handleOpenModal(item)} type="button">
                    {item.posterUrl && (
                      <img className="card-poster" src={posterUrl(item.posterUrl)} alt={item.title} loading="lazy" />
                    )}
                    <div className="card-poster-placeholder">{item.title?.charAt(0) || '?'}</div>
                    {item.inLibrary ? (
                      <span className="badge-in-library">{t('In Library')}</span>
                    ) : item.releaseDate && item.releaseDate > new Date().toISOString().slice(0, 10) ? (
                      <span className={'badge-upcoming-card' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Coming Soon'}
                      </span>
                    ) : (
                      <span className={'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Not in Library'}
                      </span>
                    )}
                    {item.isWatched && (
                      <div className="card-watched-badge" title={t('Watched')}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </div>
                    )}
                    <div className="card-overlay">
                      <div className="card-overlay-actions">
                        {item.inLibrary && item.ratingKey ? (
                          <button
                            className={'btn-icon btn-watchlist' + (watchlistCache[item.ratingKey] ? ' in-watchlist' : '')}
                            onClick={(e) => { e.stopPropagation(); handleToggleWatchlist(item) }}
                          >
                            {watchlistCache[item.ratingKey] ? '✓ In Watchlist' : '+ Watchlist'}
                          </button>
                        ) : null}
                        {!item.inLibrary && (
                          <button
                            className={'btn-icon btn-request' + (item.isRequested ? ' btn-request-sent' : '')}
                            onClick={(e) => { e.stopPropagation(); setRequestItem(item) }}
                            disabled={item.isRequested}
                          >
                            {item.isRequested ? 'Requested ✓' : 'Request'}
                          </button>
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
                  </div>
                </div>
              ))}
            </Carousel>
          ) : null}
        </section>
      )}

      {page < totalPages && displayResults.length > 0 && (
        <div id="search-load-more-wrap" style={{ display: 'text-align: center', padding: '32px 0' }}>
          <button className="btn-load-more" id="btn-search-load-more" onClick={handleLoadMore} disabled={loading}>
            {t('Load more')}
          </button>
        </div>
      )}

      {selectedItem && (
        <DetailModal
          item={{
            ...selectedItem,
            type: selectedItem.mediaType === 'tv' ? 'show' : 'movie',
            thumb: selectedItem.posterUrl,
            art: selectedItem.backdropUrl,
            mediaType: selectedItem.mediaType,
            inLibrary: selectedItem.inLibrary,
          }}
          onClose={() => setSelectedItem(null)}
          onRequest={() => {
            setRequestItem(selectedItem)
            setSelectedItem(null)
          }}
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
              {requestItem.year || ''} {requestItem.year ? ' · ' : ''}{requestItem.mediaType === 'movie' ? 'Movie' : 'TV Show'}
            </p>
            {requestItem.mediaType === 'tv' && seasons.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Seasons')}</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  <button
                    type="button"
                    className={'chip-sm' + (selectedSeasons[0] === 'all' ? ' active' : '')}
                    style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => setSelectedSeasons(['all'])}
                  >
                    {t('All')}
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
              // Radarr only handles movies, Sonarr only handles shows — pick the one for this media type
              const hasDirect = requestItem.mediaType === 'movie' ? services.radarr : services.sonarr
              const directName = requestItem.mediaType === 'movie' ? 'Radarr' : 'Sonarr'
              const directSvc = requestItem.mediaType === 'movie' ? 'radarr' : 'sonarr'
              // Services actually available for THIS media type
              const available = { overseerr: hasOverseerr, riven: hasRiven, [directSvc]: hasDirect }
              // Resolve the admin-configured default into a concrete, available service
              const rawDefault = services.defaultService === 'direct' ? directSvc : services.defaultService
              const defaultSvc = available[rawDefault] ? rawDefault
                : hasOverseerr ? 'overseerr'
                : hasRiven ? 'riven'
                : hasDirect ? directSvc
                : 'none'
              const altOptions = []
              if (defaultSvc !== 'overseerr' && hasOverseerr) altOptions.push({ svc: 'overseerr', name: 'Overseerr' })
              if (defaultSvc !== 'riven' && hasRiven) altOptions.push({ svc: 'riven', name: 'DUMB' })
              if (defaultSvc !== directSvc && hasDirect && (services.directRequestAccess !== '1' || isAdmin)) altOptions.push({ svc: directSvc, name: directName })
              return (
                <>
                  {altOptions.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                      <button
                        type="button"
                        className="chip-sm"
                        style={{ border: '1px solid var(--border)', cursor: 'pointer', width: '100%', textAlign: 'center' }}
                        onClick={() => {
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
                        {t('Advanced ▸')}
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
                    <button className="chip-sm" onClick={() => setRequestItem(null)}>{t('Cancel')}</button>
                    <button className="chip-sm" style={{ background: 'var(--accent)', color: '#000', fontWeight: '600', border: 'none' }} onClick={() => handleSubmitRequest(defaultSvc)}>
                      {t('Request')}
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </Modal>
    </main>
  )
}
