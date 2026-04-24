import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  searchApi,
  watchlistApi,
  plexApi,
  exploreApi,
  issuesApi,
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

  const initialQuery = searchParams.get('q') || ''
  const [query, setQuery] = useState(initialQuery)
  const [inputValue, setInputValue] = useState(initialQuery)
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
  const suggestTimerRef = useRef(null)
  const searchInputRef = useRef(null)

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

  const fetchSearchResults = useCallback(async (reset = true) => {
    if (!inputValue.trim()) {
      if (reset) setResults([])
      return
    }
    if (reset) {
      setLoading(true)
      setPage(1)
    }

    try {
      const { data } = await searchApi.search(inputValue.trim(), reset ? 1 : page)
      if (reset) {
        setResults(data.results || [])
      } else {
        setResults(prev => [...prev, ...(data.results || [])])
      }
      setTotalPages(data.pages || 1)
      setTotalResults(data.total || 0)
    } catch (e) {
      toastError('Search failed. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [inputValue, page, toastError])

  const debouncedSuggestions = useCallback((q) => {
    clearTimeout(suggestTimerRef.current)
    if (q.length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    suggestTimerRef.current = setTimeout(async () => {
      try {
        const { data } = await searchApi.getSuggestions(q)
        setSuggestions(data.results || [])
      } catch { /* ignore */ }
    }, 280)
  }, [])

  useEffect(() => {
    if (initialQuery) {
      fetchSearchResults(true)
    }
    loadWatchlist()
  }, [initialQuery, fetchSearchResults, loadWatchlist])

  const handleSubmit = useCallback((e) => {
    e.preventDefault()
    const q = inputValue.trim()
    if (!q) return
    navigate('/search?q=' + encodeURIComponent(q))
    setResults([])
    setSuggestions([])
    setShowSuggestions(false)
    setQuery(q)
  }, [inputValue, navigate])

  const handleInputChange = useCallback((e) => {
    setInputValue(e.target.value)
    debouncedSuggestions(e.target.value)
  }, [debouncedSuggestions])

  const handleSuggestionClick = useCallback((title) => {
    setInputValue(title)
    setQuery(title)
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
    fetchSearchResults(false)
  }, [page, fetchSearchResults])

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

  const handleSubmitRequest = useCallback(async () => {
    if (!requestItem) return
    const seasons = selectedSeasons[0] === 'all' || selectedSeasons.length === 0 ? null : selectedSeasons.map(Number)
    try {
      await exploreApi.followRecommendation(requestItem.tmdbId, requestItem.mediaType)
      toastSuccess('You\'ll be notified when ' + requestItem.title + ' is available')
      setRequestItem(null)
      setSelectedSeasons(['all'])
    } catch (e) {
      toastError(e.message || 'Request failed')
    }
  }, [requestItem, selectedSeasons, toastSuccess, toastError])

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

      {results.length > 0 && (
        <div className="search-results-meta" id="search-results-header">
          <span id="search-results-count">
            {totalResults.toLocaleString()} result{totalResults !== 1 ? 's' : ''} for "{query}"
          </span>
        </div>
      )}

      <div className="card-grid" id="search-grid">
        {loading ? (
          <SkeletonLoader count={12} />
        ) : results.length === 0 ? (
          <div className="search-empty" style={{ gridColumn: '1/-1' }}>
            <p>No results found for "{query}".</p>
          </div>
        ) : (
          results.map(item => (
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
          ))
        )}
      </div>

      {page < totalPages && (
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
              {requestItem.year || ''} {requestItem.year ? ' · ' : ''}{requestItem.mediaType === 'movie' ? 'Movie' : 'TV Show'}
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
    </main>
  )
}
