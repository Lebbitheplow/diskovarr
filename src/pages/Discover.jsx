import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  discoverApi,
  plexApi,
  watchlistApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import DetailModal from '../components/DetailModal'
import { useToast } from '../context/ToastContext'

const DECADES = [
  { label: 'Any', value: '' },
  { label: '2020s', value: '2020' },
  { label: '2010s', value: '2010' },
  { label: '2000s', value: '2000' },
  { label: '1990s', value: '1990' },
  { label: '1980s', value: '1980' },
  { label: '1970s', value: '1970' },
]

const RATING_VALUES = [0, 5, 6, 7, 7.5, 8, 8.5, 9, 9.5, 10]

const SORT_OPTIONS = [
  { value: 'rating', label: 'Highest Rated' },
  { value: 'added', label: 'Recently Added' },
  { value: 'year_desc', label: 'Newest First' },
  { value: 'year_asc', label: 'Oldest First' },
  { value: 'title', label: 'A–Z' },
]

const TYPE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'movie', label: 'Movies' },
  { value: 'show', label: 'TV Shows' },
  { value: 'anime', label: 'Anime' },
]

export default function Discover() {
  const { error: toastError, success: toastSuccess } = useToast()

  const [type, setType] = useState('all')
  const [decade, setDecade] = useState('')
  const [minRating, setMinRating] = useState(0)
  const [sort, setSort] = useState('rating')
  const [genres, setGenres] = useState(new Set())
  const [search, setSearch] = useState('')
  const [genresList, setGenresList] = useState([])
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalResults, setTotalResults] = useState(0)
  const [watchlistCache, setWatchlistCache] = useState({})
  const [initialLoad, setInitialLoad] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)
  const [loadingGenres, setLoadingGenres] = useState(true)
  const [panel, setPanel] = useState(null)
  const debounceRef = useRef(null)
  const loadingRef = useRef(false)

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

  const loadGenres = useCallback(async () => {
    setLoadingGenres(true)
    try {
      const { data } = await discoverApi.getGenres()
      setGenresList(data.genres || [])
    } catch (e) {
      toastError('Failed to load genres')
    } finally {
      setLoadingGenres(false)
    }
  }, [toastError])

  const fetchResults = useCallback(async (reset = true, overridePage) => {
    if (loadingRef.current) return
    loadingRef.current = true
    if (reset) {
      setLoading(true)
      setPage(1)
      setInitialLoad(false)
    }

    const params = new URLSearchParams({
      type,
      decade,
      minRating,
      sort,
      genres: [...genres].join(','),
      page: reset ? 1 : (overridePage || page),
      q: search,
    })

    try {
      const { data } = await discoverApi.getDiscover(params)
      if (reset) {
        setResults(data.items || [])
      } else {
        setResults(prev => [...prev, ...(data.items || [])])
      }
      setTotalPages(data.pages || 1)
      setTotalResults(data.total || 0)
    } catch (e) {
      toastError('Failed to load results')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [type, decade, minRating, sort, genres, search, page, toastError])

  useEffect(() => {
    loadGenres()
    loadWatchlist()
  }, [loadGenres, loadWatchlist])

  // Debounced fetch for search input — fires 120ms after user stops typing
  const debouncedFetch = useCallback((reset) => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchResults(reset), 120)
  }, [fetchResults])

  // Re-fetch when non-search filters change (immediate)
  useEffect(() => {
    fetchResults(true)
  }, [type, decade, minRating, sort, genres]) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePanel = useCallback((key) => {
    setPanel(p => p === key ? null : key)
  }, [])

  const handleSearchChange = useCallback((e) => {
    setSearch(e.target.value)
    debouncedFetch(true)
  }, [debouncedFetch])

  const handleSearchClear = useCallback(() => {
    setSearch('')
    debouncedFetch(true)
  }, [debouncedFetch])

  const handleTypeChange = useCallback((newType) => {
    setType(newType)
  }, [])

  const handleDecadeChange = useCallback((newDecade) => {
    setDecade(newDecade)
  }, [])

  const handleRatingChange = useCallback((e) => {
    const idx = parseInt(e.target.value)
    setMinRating(RATING_VALUES[idx])
  }, [])

  const handleRatingCommit = useCallback(() => {
    fetchResults(true)
  }, [fetchResults])

  const handleSortChange = useCallback((value) => {
    setSort(value)
  }, [])

  const handleGenreToggle = useCallback((genre) => {
    setGenres(prev => {
      const next = new Set(prev)
      if (next.has(genre.toLowerCase())) {
        next.delete(genre.toLowerCase())
      } else {
        next.add(genre.toLowerCase())
      }
      return next
    })
  }, [])

  const handleClearAll = useCallback(() => {
    setType('all')
    setDecade('')
    setMinRating(0)
    setSort('rating')
    setGenres(new Set())
    setSearch('')
    setPanel(null)
  }, [])

  const handleLoadMore = useCallback(() => {
    const nextPage = page + 1
    setPage(nextPage)
    fetchResults(false, nextPage)
  }, [page, fetchResults])

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
      setResults(prev => prev.filter(i => i.ratingKey !== key))
      setTotalResults(prev => prev - 1)
      toastSuccess('Not interested')
    } catch (e) {
      toastError('Dismiss failed')
    }
  }, [toastSuccess, toastError])

  const handleOpenModal = useCallback((item) => {
    setSelectedItem(item)
  }, [])

  const ratingLabel = minRating === 0 ? 'Any' : minRating

  return (
    <>
    <main className="main-content">
      <div className="hero" style={{ marginBottom: '28px' }}>
        <h1 className="hero-title">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="22" height="22" fill="none" aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: '8px' }}>
            <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="6" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          Filter
        </h1>
        <p className="hero-sub">Browse and filter your entire library</p>
      </div>

      <div className="filter-bar" id="filter-bar">
        {/* Search input — always visible at the top */}
        <div className="search-input-wrap">
          <svg className="search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
            <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            id="filter-search"
            className="filter-search"
            placeholder="Search titles in library…"
            autoComplete="off"
            spellCheck="false"
            value={search}
            onChange={handleSearchChange}
          />
          <button className={'search-clear' + (search ? ' visible' : '')} id="search-clear" aria-label="Clear search" onClick={handleSearchClear}>✕</button>
        </div>

        {/* Horizontal filter chip row */}
        <div className="filter-chips-row">
          {/* Type */}
          <button
            className={`filter-chip${type !== 'all' ? ' active' : ''}${panel === 'type' ? ' open' : ''}`}
            onClick={() => togglePanel('type')}
          >
            {type !== 'all' ? TYPE_OPTIONS.find(t => t.value === type)?.label : 'Type'}
            <span className="filter-chip-caret" />
          </button>

          {/* Decade */}
          <button
            className={`filter-chip${decade ? ' active' : ''}${panel === 'decade' ? ' open' : ''}`}
            onClick={() => togglePanel('decade')}
          >
            {decade ? DECADES.find(d => d.value === decade)?.label : 'Decade'}
            <span className="filter-chip-caret" />
          </button>

          {/* Rating */}
          <button
            className={`filter-chip${minRating > 0 ? ' active' : ''}${panel === 'rating' ? ' open' : ''}`}
            onClick={() => togglePanel('rating')}
          >
            {minRating > 0 ? `★ ${ratingLabel}+` : 'Rating'}
            <span className="filter-chip-caret" />
          </button>

          {/* Genre */}
          <button
            className={`filter-chip${genres.size > 0 ? ' active' : ''}${panel === 'genre' ? ' open' : ''}`}
            onClick={() => togglePanel('genre')}
          >
            {genres.size > 0 ? `Genre · ${genres.size}` : 'Genre'}
            <span className="filter-chip-caret" />
          </button>

          {/* Sort */}
          <button
            className={`filter-chip${sort !== 'rating' ? ' active' : ''}${panel === 'sort' ? ' open' : ''}`}
            onClick={() => togglePanel('sort')}
          >
            {SORT_OPTIONS.find(s => s.value === sort)?.label || 'Sort'}
            <span className="filter-chip-caret" />
          </button>
        </div>

        {/* Type panel */}
        {panel === 'type' && (
          <div className="filter-panel">
            {TYPE_OPTIONS.map(t => (
              <button
                key={t.value}
                className={`filter-pill${type === t.value ? ' active' : ''}`}
                onClick={() => handleTypeChange(t.value)}
              >
                {type === t.value && <span className="filter-pill-check">✓</span>}
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Decade panel */}
        {panel === 'decade' && (
          <div className="filter-panel">
            {DECADES.map(d => (
              <button
                key={d.value}
                className={`filter-pill${decade === d.value ? ' active' : ''}`}
                onClick={() => handleDecadeChange(d.value)}
              >
                {decade === d.value && <span className="filter-pill-check">✓</span>}
                {d.label}
              </button>
            ))}
          </div>
        )}

        {/* Rating panel */}
        {panel === 'rating' && (
          <div className="filter-panel" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
            <input
              type="range"
              id="filter-rating"
              min="0"
              max="9"
              step="1"
              value={RATING_VALUES.indexOf(minRating)}
              className="rating-slider"
              onChange={handleRatingChange}
              onBlur={handleRatingCommit}
            />
            <div className="rating-ticks">
              {RATING_VALUES.map((v, i) => (
                <span key={i}>{v === 0 ? 'Any' : v}</span>
              ))}
            </div>
            {minRating > 0 && (
              <button className="filter-panel-clear" onClick={() => { setMinRating(0); fetchResults(true) }}>Clear</button>
            )}
          </div>
        )}

        {/* Genre panel */}
        {panel === 'genre' && (
          <div className="filter-panel">
            {loadingGenres ? (
              <span className="filter-panel-empty">Loading genres…</span>
            ) : (
              genresList.map(genre => (
                <button
                  key={genre}
                  className={`filter-pill${genres.has(genre.toLowerCase()) ? ' active' : ''}`}
                  onClick={() => handleGenreToggle(genre)}
                >
                  {genres.has(genre.toLowerCase()) && <span className="filter-pill-check">✓</span>}
                  {genre}
                </button>
              ))
            )}
            {genres.size > 0 && (
              <button className="filter-panel-clear" onClick={() => setGenres(new Set())}>Clear</button>
            )}
          </div>
        )}

        {/* Sort panel */}
        {panel === 'sort' && (
          <div className="filter-panel">
            {SORT_OPTIONS.map(s => (
              <button
                key={s.value}
                className={`filter-pill${sort === s.value ? ' active' : ''}`}
                onClick={() => handleSortChange(s.value)}
              >
                {sort === s.value && <span className="filter-pill-check">✓</span>}
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {totalResults > 0 && (
        <div className="discover-results-header" id="results-header">
          <span id="results-count" className="results-count">
            {totalResults.toLocaleString()} result{totalResults !== 1 ? 's' : ''}
          </span>
          <button className="chip-sm" id="btn-clear-filters" onClick={handleClearAll}>Clear all filters</button>
        </div>
      )}

      <div className="card-grid" id="discover-grid">
        {initialLoad ? (
          <div className="discover-empty" id="discover-initial">
            <div className="discover-empty-icon">◈</div>
            <p>Set your filters above and results will appear here</p>
          </div>
        ) : results.length === 0 ? (
          <div className="discover-empty">
            <div className="discover-empty-icon">◈</div>
            <p>No results match your filters</p>
          </div>
        ) : (
          results.map(item => (
            <MediaCard
              key={item.ratingKey}
              item={{ ...item, mediaType: 'movie' }}
              variant="home"
              onOpenModal={handleOpenModal}
              onToggleWatchlist={handleToggleWatchlist}
              onDismiss={handleDismiss}
              isInWatchlist={!!watchlistCache[item.ratingKey]}
            />
          ))
        )}
      </div>

      {page < totalPages && (
        <div id="load-more-wrap" style={{ textAlign: 'center', padding: '32px 0' }}>
          <button className="btn-load-more" id="btn-load-more" onClick={handleLoadMore} disabled={loading}>
            Load more
          </button>
        </div>
      )}
    </main>

      {selectedItem && (
        <DetailModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </>
  )
}
