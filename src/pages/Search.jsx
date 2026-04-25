import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import FilterBar from '../components/FilterBar'
import {
  searchApi,
  watchlistApi,
  plexApi,
  exploreApi,
  issuesApi,
  queueApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import SkeletonLoader from '../components/SkeletonLoader'
import DetailModal from '../components/DetailModal'
import Modal from '../components/Modal'
import { useToast } from '../context/ToastContext'

function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}

export default function Search() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { error: toastError, success: toastSuccess } = useToast()

  // URL is the source of truth for committed search state
  const urlQuery = searchParams.get('q') || ''
  const urlGenre = searchParams.get('genre') || ''

  const [inputValue, setInputValue] = useState(urlQuery)
  const [activeTab, setActiveTab] = useState('all')
  const [hideLibrary, setHideLibrary] = useState(!!urlGenre)
  const [filterGenres, setFilterGenres] = useState([])
  const [filterYearFrom, setFilterYearFrom] = useState('')
  const [filterYearTo, setFilterYearTo] = useState('')
  const [filterContentRatings, setFilterContentRatings] = useState([])
  const [filterMinScore, setFilterMinScore] = useState(null)
  const [results, setResults] = useState([])
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
  const suggestTimerRef = useRef(null)
  const searchInputRef = useRef(null)

  // Sync input box when URL changes externally (e.g. navbar search)
  useEffect(() => {
    setInputValue(urlQuery)
  }, [urlQuery])

  // Reset filters and tab when search changes
  useEffect(() => {
    setActiveTab('all')
    setHideLibrary(!!urlGenre)
    setFilterGenres([])
    setFilterYearFrom('')
    setFilterYearTo('')
    setFilterContentRatings([])
    setFilterMinScore(null)
  }, [urlQuery, urlGenre])

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {}
      ;(data.items || []).forEach(item => { cache[item.ratingKey] = true })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  // fetchSearchResults takes q/g/pg as args so it doesn't close over stale state
  const fetchSearchResults = useCallback(async (q, g, pg = 1, append = false) => {
    if (!q && !g) { setResults([]); return }
    if (!append) setLoading(true)
    try {
      const { data } = await searchApi.search(q, pg, g || undefined)
      if (append) {
        setResults(prev => [...prev, ...(data.results || [])])
      } else {
        setResults(data.results || [])
      }
      setTotalPages(data.pages || 1)
      setTotalResults(data.total || 0)
    } catch {
      toastError('Search failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [toastError])

  // Fire search whenever the URL's q or genre param changes
  useEffect(() => {
    setPage(1)
    fetchSearchResults(urlQuery, urlGenre, 1, false)
  }, [urlQuery, urlGenre]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadWatchlist()
    exploreApi.getServices().then(({ data }) => setServices(data || {})).catch(() => {})
  }, [loadWatchlist])

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

  const handleSuggestionClick = useCallback((title) => {
    setInputValue(title)
    setSuggestions([])
    setShowSuggestions(false)
    navigate('/search?q=' + encodeURIComponent(title))
  }, [navigate])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      if (activeSuggestionIdx >= 0 && activeSuggestionIdx < suggestions.length) {
        e.preventDefault()
        handleSuggestionClick(suggestions[activeSuggestionIdx].title)
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
      setResults(prev => prev.filter(i => i.ratingKey !== item.ratingKey))
      toastSuccess('Not interested')
    } catch (e) {
      toastError('Dismiss failed')
    }
  }, [toastSuccess, toastError])

  const handleOpenModal = useCallback((item) => {
    setSelectedItem(item)
  }, [])

  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    fetchSearchResults(urlQuery, urlGenre, nextPage, true)
  }, [page, urlQuery, urlGenre, fetchSearchResults])

  const handleClearGenre = useCallback(() => {
    setActiveTab('all')
    navigate('/search')
  }, [navigate])

  const availableGenres = useMemo(() => {
    const set = new Set()
    results.forEach(r => (r.genres || []).forEach(g => set.add(g)))
    return [...set].sort()
  }, [results])

  const availableContentRatings = useMemo(() => {
    const order = ['G','PG','PG-13','R','NC-17','TV-G','TV-PG','TV-14','TV-MA']
    const set = new Set(results.map(r => r.contentRating).filter(Boolean))
    return order.filter(r => set.has(r))
  }, [results])

  const displayResults = useMemo(() => {
    let r = hideLibrary ? results.filter(i => !i.inLibrary) : results
    if (filterGenres.length > 0)
      r = r.filter(i => filterGenres.every(g => (i.genres || []).includes(g)))
    if (filterYearFrom)
      r = r.filter(i => i.year >= parseInt(filterYearFrom))
    if (filterYearTo)
      r = r.filter(i => i.year <= parseInt(filterYearTo))
    if (filterContentRatings.length > 0)
      r = r.filter(i => filterContentRatings.includes(i.contentRating))
    if (filterMinScore)
      r = r.filter(i => (i.voteAverage || 0) >= filterMinScore)
    return r
  }, [results, hideLibrary, filterGenres, filterYearFrom, filterYearTo, filterContentRatings, filterMinScore])

  const movieResults = displayResults.filter(item => item.mediaType === 'movie')
  const tvResults = displayResults.filter(item => item.mediaType === 'tv')

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
      toastSuccess('Request submitted for ' + requestItem.title)
      setRequestItem(null)
      setSelectedSeasons(['all'])
    } catch (e) {
      toastError(e.message || 'Request failed')
    }
  }, [requestItem, selectedSeasons, toastSuccess, toastError, services])

  useEffect(() => {
    if (requestItem) {
      handleSeasonsFetch(requestItem.tmdbId)
    }
  }, [requestItem, handleSeasonsFetch])

  return (
    <main className="main-content">
      <div className="search-page-header">
        <button
          className="search-back-btn"
          aria-label="Back"
          onClick={() => {
            if (history.length > 1) history.back()
            else navigate('/')
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
            <path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
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
                placeholder="Search movies & TV shows…"
                spellcheck="false"
                autoFocus
              />
              {inputValue && (
                <button type="button" className="search-page-clear" onClick={() => { setInputValue(''); setSuggestions([]); setShowSuggestions(false) }} aria-label="Clear">✕</button>
              )}
              {suggestions.length > 0 && showSuggestions && (
                <div className="search-page-dropdown">
                  {suggestions.slice(0, 6).map((item, idx) => (
                    <div
                      key={item.tmdbId || idx}
                      className={'hero-suggest-row' + (idx === activeSuggestionIdx ? ' active' : '')}
                      onMouseDown={(e) => { e.preventDefault(); handleSuggestionClick(item.title) }}
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
            {displayResults.length.toLocaleString()} result{displayResults.length !== 1 ? 's' : ''}{urlGenre ? ' in ' + urlGenre : ' for "' + urlQuery + '"'}
          </span>
          {urlGenre && (
            <div className="genre-filter-badge">
              <span>Genre: {urlGenre}</span>
              <button onClick={handleClearGenre} aria-label="Clear genre filter">×</button>
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
                      <span className="badge-in-library">In Library</span>
                    ) : (
                      <span className={'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '')}>
                        {item.isRequested ? 'Requested' : 'Not in Library'}
                      </span>
                    )}
                    {item.isWatched && (
                      <div className="card-watched-badge" title="Watched">
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
                    <span className="badge-in-library">In Library</span>
                  ) : (
                    <span className={'badge-not-in-library' + (item.isRequested ? ' badge-requested' : '')}>
                      {item.isRequested ? 'Requested' : 'Not in Library'}
                    </span>
                  )}
                  {item.isWatched && (
                    <div className="card-watched-badge" title="Watched">
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
      ) : (
        <div className="search-empty" style={{ gridColumn: '1/-1' }}>
          <p>No results found for "{urlGenre ? urlGenre : urlQuery}".</p>
        </div>
      )}

      {page < totalPages && displayResults.length > 0 && (
        <div id="search-load-more-wrap" style={{ display: 'text-align: center', padding: '32px 0' }}>
          <button className="btn-load-more" id="btn-search-load-more" onClick={handleLoadMore} disabled={loading}>
            Load more
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
    </main>
  )
}
