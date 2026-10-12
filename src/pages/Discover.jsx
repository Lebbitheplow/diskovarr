import React, { useState, useCallback, useEffect, useEffectEvent, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  discoverApi,
  libraryApi,
  watchlistApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import DetailModal from '../components/DetailModal'
import { useToast } from '../context/ToastContext'
import FilterControls from '../components/FilterControls'
import { SCORE_VALUES, FACET_FIELDS } from '../components/filterConstants'
import { useTranslation } from 'react-i18next'
import { withViewTransition } from '../utils/viewTransition'
import { createLatestRequest } from '../utils/latestRequest'

const emptyTags = () => Object.fromEntries(FACET_FIELDS.map(f => [f.field, new Set()]))

export default function Discover() {
  const { t } = useTranslation()
  const { error: toastError, success: toastSuccess } = useToast()
  const [searchParams] = useSearchParams()

  const [type, setType] = useState('all')
  const [decade, setDecade] = useState('')
  const [minScore, setMinScore] = useState(0)
  const [sort, setSort] = useState('rating')
  const [filterContentRatings, setFilterContentRatings] = useState([])
  const [availableContentRatings, setAvailableContentRatings] = useState([])
  // Home's "Browse by Genre" tiles deep-link here as /discover?genre=X; seed the
  // genre facet from the URL so the shelf lands on filtered results immediately.
  const [tags, setTags] = useState(() => {
    const initial = emptyTags()
    const genre = (searchParams.get('genre') || '').trim()
    if (genre) initial.genre.add(genre)
    return initial
  })
  const [year, setYear] = useState('')
  const [releaseFrom, setReleaseFrom] = useState('')
  const [releaseTo, setReleaseTo] = useState('')
  const [durationMin, setDurationMin] = useState('')
  const [durationMax, setDurationMax] = useState('')
  // `search` is the text in the box; `query` is the text the results are for,
  // committed 120ms after typing stops
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  // Range inputs (year, release, runtime) apply on blur/Enter/Clear rather
  // than per keystroke; each commit bumps this to trigger the refetch
  const [rangeCommit, setRangeCommit] = useState(0)
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalResults, setTotalResults] = useState(0)
  const [watchlistCache, setWatchlistCache] = useState({})
  const [initialLoad, setInitialLoad] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)
  const debounceRef = useRef(null)
  // Latest query wins: a new one aborts whatever is in flight, and a reply
  // for a superseded query is dropped instead of replacing newer results
  const [requests] = useState(createLatestRequest)
  // Params behind the results on screen, so Load more pages through the same
  // query even while a range input holds an uncommitted edit
  const shownQueryRef = useRef(null)

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {}
      ;(data.items || []).forEach(item => { cache[item.ratingKey] = true })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  // Page 1 replaces the results; later pages append to them
  const loadPage = useCallback(async (params, pageNum) => {
    const reset = pageNum === 1
    if (reset) {
      setLoading(true)
      setInitialLoad(false)
    }
    const ticket = requests.start()
    try {
      const { data } = await discoverApi.getDiscover(
        new URLSearchParams({ ...params, page: pageNum }),
        { signal: ticket.signal },
      )
      if (!ticket.current) return
      if (reset) {
        shownQueryRef.current = params
        setResults(data.items || [])
      } else {
        setResults(prev => [...prev, ...(data.items || [])])
      }
      setPage(pageNum)
      setTotalPages(data.pages || 1)
      setTotalResults(data.total || 0)
      setAvailableContentRatings(data.availableContentRatings || [])
    } catch (e) {
      if (ticket.current) toastError(t('Failed to load results'))
    } finally {
      // A superseded request leaves the spinner to the one that replaced it
      if (requests.finish(ticket)) setLoading(false)
    }
  }, [requests, toastError, t])

  // Fetches page 1 for the filters as they are right now. An effect event
  // always sees the latest state, so the effect below only decides when.
  const fetchFirstPage = useEffectEvent(() => {
    loadPage({
      type,
      decade,
      minScore,
      sort,
      genres: [...tags.genre].join(','),
      directors: [...tags.director].join(','),
      actors: [...tags.actor].join(','),
      writers: [...tags.writer].join(','),
      producers: [...tags.producer].join(','),
      countries: [...tags.country].join(','),
      collections: [...tags.collection].join(','),
      studios: [...tags.studio].join(','),
      editions: [...tags.edition].join(','),
      labels: [...tags.label].join(','),
      contentRatings: filterContentRatings.join(','),
      year,
      releaseFrom,
      releaseTo,
      durationMin,
      durationMax,
      q: query,
    }, 1)
  })

  useEffect(() => {
    ;(async () => { await loadWatchlist() })()
  }, [loadWatchlist])

  // Refetch when a filter changes (immediately), the search text settles, or a
  // range input commits
  useEffect(() => {
    ;(async () => { await fetchFirstPage() })()
  }, [type, decade, minScore, sort, tags, filterContentRatings, query, rangeCommit])

  // Leaving the page: drop a pending search and abort the request in flight
  useEffect(() => () => {
    clearTimeout(debounceRef.current)
    requests.cancel()
  }, [requests])

  const handleSearchChange = useCallback((e) => {
    const value = e.target.value
    setSearch(value)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setQuery(value), 120)
  }, [])

  const handleSearchClear = useCallback(() => {
    clearTimeout(debounceRef.current)
    setSearch('')
    setQuery('')
  }, [])

  const commitRanges = useCallback(() => setRangeCommit(n => n + 1), [])

  const handleScoreChange = useCallback((e) => {
    setMinScore(SCORE_VALUES[parseInt(e.target.value)])
  }, [])

  const handleToggleContentRating = useCallback((r) => {
    setFilterContentRatings(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])
  }, [])

  const handleToggleTag = useCallback((field, value) => {
    setTags(prev => {
      const next = { ...prev, [field]: new Set(prev[field]) }
      const existing = [...next[field]].find(v => v.toLowerCase() === value.toLowerCase())
      if (existing) next[field].delete(existing)
      else next[field].add(value)
      return next
    })
  }, [])

  const handleClearTag = useCallback((field) => {
    setTags(prev => ({ ...prev, [field]: new Set() }))
  }, [])

  const handleClearAll = useCallback(() => {
    setType('all')
    setDecade('')
    setMinScore(0)
    setSort('rating')
    setFilterContentRatings([])
    setTags(emptyTags())
    setYear('')
    setReleaseFrom('')
    setReleaseTo('')
    setDurationMin('')
    setDurationMax('')
    clearTimeout(debounceRef.current)
    setSearch('')
    setQuery('')
    setRangeCommit(n => n + 1)
  }, [])

  // Skipped while anything is loading: a page 1 in flight is about to replace
  // the list, and a second Load more would fetch the same page twice
  const handleLoadMore = useCallback(() => {
    if (requests.busy || !shownQueryRef.current) return
    loadPage(shownQueryRef.current, page + 1)
  }, [requests, loadPage, page])

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

  const handleDismiss = useCallback(async (item) => {
    try {
      await libraryApi.dismissItem(item.ratingKey)
      const key = item.ratingKey
      setResults(prev => prev.filter(i => i.ratingKey !== key))
      setTotalResults(prev => prev - 1)
      toastSuccess(t('Not interested'))
    } catch (e) {
      toastError(t('Dismiss failed'))
    }
  }, [toastSuccess, toastError, t])

  // Morphs the clicked poster into the modal's poster where supported
  const handleOpenModal = useCallback((item) => withViewTransition(() => setSelectedItem(item)), [])

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
          {t('Filter')}
        </h1>
        <p className="hero-sub">{t('Browse and filter your entire library')}</p>
      </div>

      <FilterControls
        search={search} onSearchChange={handleSearchChange} onSearchClear={handleSearchClear}
        type={type} onType={setType}
        decade={decade} onDecade={setDecade}
        // The score refetches as the slider moves (it's an immediate filter),
        // so there's nothing extra to commit on blur
        minScore={minScore} onScoreChange={handleScoreChange} onScoreClear={() => setMinScore(0)}
        sort={sort} onSort={setSort}
        contentRatings={filterContentRatings} availableContentRatings={availableContentRatings}
        onToggleContentRating={handleToggleContentRating} onClearContentRatings={() => setFilterContentRatings([])}
        tags={tags} onToggleTag={handleToggleTag} onClearTag={handleClearTag}
        year={year} onYear={setYear}
        releaseFrom={releaseFrom} releaseTo={releaseTo} onReleaseFrom={setReleaseFrom} onReleaseTo={setReleaseTo}
        durationMin={durationMin} durationMax={durationMax} onDurationMin={setDurationMin} onDurationMax={setDurationMax}
        onRangeCommit={commitRanges}
        onClearAll={handleClearAll}
      />

      {totalResults > 0 && (
        <div className="discover-results-header" id="results-header">
          <span id="results-count" className="results-count">
            {totalResults.toLocaleString()} {totalResults !== 1 ? t('results') : t('result')}
          </span>
        </div>
      )}

      <div className="card-grid" id="discover-grid">
        {initialLoad ? (
          <div className="discover-empty" id="discover-initial">
            <div className="discover-empty-icon">◈</div>
            <p>{t('Set your filters above and results will appear here')}</p>
          </div>
        ) : results.length === 0 ? (
          <div className="discover-empty">
            <div className="discover-empty-icon">◈</div>
            <p>{t('No results match your filters')}</p>
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
            {t('Load more')}
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
