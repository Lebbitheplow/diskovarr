import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchApi } from '../services/api'

// Typeahead state for the shell's search field: 280ms-debounced suggestions,
// keyboard navigation, and the object-vs-string navigation branch.
//
// Lifted out of NavigationBar during the rail refresh with its behaviour
// unchanged. The input ref lives here because Escape has to blur the field.
export default function useNavSearch() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [activeIdx, setActiveIdx] = useState(-1)
  const inputRef = useRef(null)
  const suggestTimerRef = useRef(null)

  const fetchSuggestions = useCallback(async (q) => {
    if (q.length < 2) {
      setResults([])
      return
    }
    try {
      const { data } = await searchApi.getSuggestions(q)
      setResults(data?.results || [])
      setActiveIdx(-1)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    clearTimeout(suggestTimerRef.current)
    // fetchSuggestions clears results for queries < 2 chars; routing both paths
    // through the debounce keeps any setState out of the synchronous effect body.
    suggestTimerRef.current = setTimeout(() => fetchSuggestions(query), 280)
    return () => clearTimeout(suggestTimerRef.current)
  }, [query, fetchSuggestions])

  const navigateToSearch = useCallback((itemOrQuery) => {
    setResults([])
    setQuery('')
    setOpen(false)
    if (itemOrQuery && typeof itemOrQuery === 'object' && itemOrQuery.tmdbId) {
      const params = new URLSearchParams()
      params.set('q', itemOrQuery.title)
      params.set('selectedTmdbId', itemOrQuery.tmdbId)
      params.set('selectedType', itemOrQuery.mediaType)
      navigate('/search?' + params.toString())
    } else {
      navigate(`/search?q=${encodeURIComponent(typeof itemOrQuery === 'string' ? itemOrQuery : '')}`)
    }
  }, [navigate])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      const q = query.trim()
      if (q) {
        if (activeIdx >= 0 && activeIdx < results.length) {
          navigateToSearch(results[activeIdx])
        } else {
          navigateToSearch(q)
        }
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, -1))
    }
  }, [query, activeIdx, results, navigateToSearch])

  // Opens the field and focuses it on the next tick, once the expanded
  // mobile layout has been committed.
  const openAndFocus = useCallback(() => {
    setOpen(true)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  const clear = useCallback(() => {
    setQuery('')
    inputRef.current?.focus()
  }, [])

  return {
    open, setOpen,
    query, setQuery,
    results, activeIdx,
    inputRef,
    handleKeyDown, navigateToSearch, openAndFocus, clear,
  }
}
