import { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

function parseIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

export default function useListFilters({ initialFilter = 'all', debounceMs = 300 }) {
  const [searchParams, setSearchParams] = useSearchParams()

  const urlSearch = searchParams.get('search') || ''
  const urlUserId = searchParams.get('userId') || ''
  const urlFilter = searchParams.get('filter') || initialFilter
  const urlFrom = parseIntOrNull(searchParams.get('from'))
  const urlTo = parseIntOrNull(searchParams.get('to'))

  const [searchQuery, setSearchQuery] = useState(urlSearch)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(urlSearch)
  const [selectedUser, setSelectedUser] = useState(urlUserId)
  const [currentFilter, setCurrentFilter] = useState(urlFilter)
  const [dateFrom, setDateFrom] = useState(urlFrom)
  const [dateTo, setDateTo] = useState(urlTo)
  const [users, setUsers] = useState([])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery), debounceMs)
    return () => clearTimeout(t)
  }, [searchQuery, debounceMs])

  const setDateRange = useCallback((next) => {
    setDateFrom(next?.from ?? null)
    setDateTo(next?.to ?? null)
  }, [])

  const syncUrl = useCallback(() => {
    const params = new URLSearchParams()
    if (currentFilter !== initialFilter) params.set('filter', currentFilter)
    if (debouncedSearchQuery) params.set('search', debouncedSearchQuery)
    if (selectedUser) params.set('userId', selectedUser)
    if (dateFrom) params.set('from', String(dateFrom))
    if (dateTo) params.set('to', String(dateTo))
    setSearchParams(params, { replace: true })
  }, [currentFilter, debouncedSearchQuery, selectedUser, dateFrom, dateTo, initialFilter, setSearchParams])

  useEffect(() => {
    syncUrl()
  }, [syncUrl])

  const hasActiveFilters = !!(searchQuery || selectedUser || dateFrom || dateTo || currentFilter !== initialFilter)

  const clearAllFilters = useCallback(() => {
    setSearchQuery('')
    setSelectedUser('')
    setCurrentFilter(initialFilter)
    setDateFrom(null)
    setDateTo(null)
  }, [initialFilter])

  return {
    searchQuery,
    setSearchQuery,
    debouncedSearchQuery,
    selectedUser,
    setSelectedUser,
    currentFilter,
    setCurrentFilter,
    dateFrom,
    dateTo,
    setDateRange,
    users,
    setUsers,
    hasActiveFilters,
    clearAllFilters,
  }
}
