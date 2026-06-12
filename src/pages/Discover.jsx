import React, { useState, useCallback, useEffect, useRef } from 'react'
import {
  discoverApi,
  plexApi,
  watchlistApi,
} from '../services/api'
import MediaCard from '../components/MediaCard'
import DetailModal from '../components/DetailModal'
import { useToast } from '../context/ToastContext'
import FilterControls from '../components/FilterControls'
import { SCORE_VALUES, FACET_FIELDS } from '../components/filterConstants'
import { useTranslation } from 'react-i18next'

const emptyTags = () => Object.fromEntries(FACET_FIELDS.map(f => [f.field, new Set()]))

export default function Discover() {
  const { t } = useTranslation()
  const { error: toastError, success: toastSuccess } = useToast()

  const [type, setType] = useState('all')
  const [decade, setDecade] = useState('')
  const [minScore, setMinScore] = useState(0)
  const [sort, setSort] = useState('rating')
  const [filterContentRatings, setFilterContentRatings] = useState([])
  const [availableContentRatings, setAvailableContentRatings] = useState([])
  const [tags, setTags] = useState(emptyTags)
  const [year, setYear] = useState('')
  const [releaseFrom, setReleaseFrom] = useState('')
  const [releaseTo, setReleaseTo] = useState('')
  const [durationMin, setDurationMin] = useState('')
  const [durationMax, setDurationMax] = useState('')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [totalResults, setTotalResults] = useState(0)
  const [watchlistCache, setWatchlistCache] = useState({})
  const [initialLoad, setInitialLoad] = useState(true)
  const [selectedItem, setSelectedItem] = useState(null)
  const debounceRef = useRef(null)
  const loadingRef = useRef(false)

  const loadWatchlist = useCallback(async () => {
    try {
      const { data } = await watchlistApi.getWatchlist()
      const cache = {}
      ;(data.items || []).forEach(item => { cache[item.ratingKey] = true })
      setWatchlistCache(cache)
    } catch { /* ignore */ }
  }, [])

  const fetchResults = useCallback(async (reset = true, overridePage, searchOverride) => {
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
      page: reset ? 1 : (overridePage || page),
      q: searchOverride !== undefined ? searchOverride : search,
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
      setAvailableContentRatings(data.availableContentRatings || [])
    } catch (e) {
      toastError(t('Failed to load results'))
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [type, decade, minScore, sort, tags, filterContentRatings, year, releaseFrom, releaseTo, durationMin, durationMax, search, page, toastError, t])

  useEffect(() => {
    ;(async () => { await loadWatchlist() })()
  }, [loadWatchlist])

  // Debounced fetch for search input — fires 120ms after user stops typing
  const debouncedFetch = useCallback((reset) => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchResults(reset), 120)
  }, [fetchResults])

  // Re-fetch when non-text filters change (immediate). Range/value inputs (year, release,
  // duration) commit via onRangeCommit on blur instead, so they're excluded here.
  useEffect(() => {
    ;(async () => { await fetchResults(true) })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, decade, minScore, sort, tags, filterContentRatings])

  const handleSearchChange = useCallback((e) => {
    setSearch(e.target.value)
    debouncedFetch(true)
  }, [debouncedFetch])

  const handleSearchClear = useCallback(() => {
    setSearch('')
    fetchResults(true, undefined, '')
  }, [fetchResults])

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
    setSearch('')
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
      await plexApi.dismissItem(item.ratingKey)
      const key = item.ratingKey
      setResults(prev => prev.filter(i => i.ratingKey !== key))
      setTotalResults(prev => prev - 1)
      toastSuccess(t('Not interested'))
    } catch (e) {
      toastError(t('Dismiss failed'))
    }
  }, [toastSuccess, toastError, t])

  const handleOpenModal = useCallback((item) => setSelectedItem(item), [])

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
        minScore={minScore} onScoreChange={handleScoreChange} onScoreCommit={() => fetchResults(true)} onScoreClear={() => { setMinScore(0); fetchResults(true) }}
        sort={sort} onSort={setSort}
        contentRatings={filterContentRatings} availableContentRatings={availableContentRatings}
        onToggleContentRating={handleToggleContentRating} onClearContentRatings={() => setFilterContentRatings([])}
        tags={tags} onToggleTag={handleToggleTag} onClearTag={handleClearTag}
        year={year} onYear={setYear}
        releaseFrom={releaseFrom} releaseTo={releaseTo} onReleaseFrom={setReleaseFrom} onReleaseTo={setReleaseTo}
        durationMin={durationMin} durationMax={durationMax} onDurationMin={setDurationMin} onDurationMax={setDurationMax}
        onRangeCommit={() => fetchResults(true)}
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
