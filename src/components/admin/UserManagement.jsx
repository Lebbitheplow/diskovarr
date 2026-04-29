import React, { useState, useEffect, useCallback, useMemo } from 'react'
import adminApi, {
  adminUsers,
  adminUserSettings,
  adminSettings,
  adminRequestLimits,
  adminConnections,
} from '../../services/adminApi'

const PER_PAGE_OPTIONS = [10, 25, 50]

const WATCHLIST_MODES = ['Plex Watchlist', 'Diskovarr Playlist']

const USER_AVATAR_FALLBACK = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'28\' height=\'28\' viewBox=\'0 0 28\'28\'%3E%3Ccircle cx=\'14\' cy=\'14\' r=\'14\' fill=\'%236366f1\'/%3E%3Ctext x=\'14\' y=\'18\' text-anchor=\'middle\' font-size=\'12\' fill=\'white\' font-family=\'sans-serif\'%3E?%3C/text%3E%3C/svg%3E'

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never'
  const d = new Date(timestamp)
  const now = new Date()
  const diffMs = now - d
  if (diffMs < 0) return 'Just now'
  const diffMin = Math.floor(diffMs / 60000)
  const diffHrs = Math.floor(diffMin / 60)
  const diffDays = Math.floor(diffHrs / 24)
  const diffWeeks = Math.floor(diffDays / 7)
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHrs < 24) return `${diffHrs}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffWeeks < 5) return `${diffWeeks}w ago`
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return d.toLocaleDateString()
}

function getDefaultUserSettings() {
  return {
    auto_approve_movies: false,
    auto_approve_tv: false,
    auto_request_movies: false,
    auto_request_tv: false,
    allow_download: false,
    allow_live_tv: false,
    allow_mature_content: false,
    restrict_new_content_to_days: null,
    restrict_request_limit_movies: null,
    restrict_request_limit_tv: null,
    restrict_request_limit_ep_all: null,
  }
}

function Avatar({ url, username }) {
  const [error, setError] = useState(false)
  if (error || !url) {
    const fallbackText = (username || '?').charAt(0).toUpperCase()
    return (
      <img
        src={USER_AVATAR_FALLBACK}
        alt=""
        className="user-avatar-sm"
        aria-label={username}
      />
    )
  }
  return (
    <img
      src={url}
      alt={username}
      className="user-avatar-sm"
      onError={() => setError(true)}
      loading="lazy"
    />
  )
}

function BulkEditToolbar({
  selectedCount,
  onClearWatched,
  onClearDismissals,
  onClearRecCache,
  onOpenBulkSettings,
  loading,
}) {
  if (selectedCount === 0) return null
  return (
    <div className="admin-actions" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginRight: 8, lineHeight: '34px' }}>
        {selectedCount} user{selectedCount !== 1 ? 's' : ''} selected
      </span>
      <button
        className="btn-admin btn-primary btn-sm"
        onClick={onClearWatched}
        disabled={loading}
      >
        Clear Watched Caches
      </button>
      <button
        className="btn-admin btn-primary btn-sm"
        onClick={onClearDismissals}
        disabled={loading}
      >
        Clear Dismissals
      </button>
      <button
        className="btn-admin btn-primary btn-sm"
        onClick={onClearRecCache}
        disabled={loading}
      >
        Clear Rec Cache
      </button>
      <button
        className="btn-admin btn-secondary btn-sm"
        onClick={onOpenBulkSettings}
        disabled={loading}
      >
        Bulk Edit Settings
      </button>
    </div>
  )
}

function PaginationControls({
  currentPage,
  totalPages,
  perPage,
  totalItems,
  onPageChange,
  onPerPageChange,
}) {
  const startItem = (currentPage - 1) * perPage + 1
  const endItem = Math.min(currentPage * perPage, totalItems)

  return (
    <div className="admin-actions" style={{ marginTop: 16, justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
        Showing {totalItems > 0 ? startItem : 0}–{endItem} of {totalItems} users
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          Per page:{' '}
          <select
            value={perPage}
            onChange={(e) => onPerPageChange(Number(e.target.value))}
            className="conn-select"
            style={{ minWidth: 60, padding: '4px 8px', fontSize: '0.82rem' }}
          >
            {PER_PAGE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            className="btn-admin btn-sm"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            &larr; Prev
          </button>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)', minWidth: 40, textAlign: 'center' }}>
            {currentPage} / {totalPages}
          </span>
          <button
            className="btn-admin btn-sm"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            Next &rarr;
          </button>
        </div>
      </div>
    </div>
  )
}

export default function UserManagement({ onDataLoaded, onToast, connections, onOpenUserSettings, onOpenBulkSettings }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [totalPages, setTotalPages] = useState(0)
  const [totalItems, setTotalItems] = useState(0)

  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(10)

  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)

  const [serverOwner, setServerOwner] = useState('')
  const [savingOwner, setSavingOwner] = useState(false)
  const [allUsersList, setAllUsersList] = useState([])

  const [watchlistMode, setWatchlistMode] = useState('watchlist')
  const [savingWatchlistMode, setSavingWatchlistMode] = useState(false)
  const [watchlistLoading, setWatchlistLoading] = useState(false)

  const [individualSeasonsEnabled, setIndividualSeasonsEnabled] = useState(false)
  const [savingIndividualSeasons, setSavingIndividualSeasons] = useState(false)
  const [loadingIndividualSeasons, setLoadingIndividualSeasons] = useState(false)

  const [globalLimits, setGlobalLimits] = useState({
    enabled: false,
    movieLimit: 0,
    movieWindowDays: 7,
    seasonLimit: 0,
    seasonWindowDays: 7,
  })
  const [savingGlobalLimits, setSavingGlobalLimits] = useState(false)
  const [loadingGlobalLimits, setLoadingGlobalLimits] = useState(false)

  const [autoApproveMovies, setAutoApproveMovies] = useState(true)
  const [autoApproveTv, setAutoApproveTv] = useState(true)
  const [savingAutoApprove, setSavingAutoApprove] = useState(false)
  const [loadingAutoApprove, setLoadingAutoApprove] = useState(false)

  const [autoRequestMovies, setAutoRequestMovies] = useState(false)
  const [autoRequestTv, setAutoRequestTv] = useState(false)
  const [savingAutoRequest, setSavingAutoRequest] = useState(false)
  const [loadingAutoRequest, setLoadingAutoRequest] = useState(false)

  const showToast = useCallback((message, type = 'success') => {
    if (onToast) {
      onToast(message, type)
    }
  }, [onToast])

  const loadUsers = useCallback(async (pg, per) => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await adminUsers.getList(pg || page, per || perPage)
      const data = res.data
      setUsers(data.users || [])
      setTotalPages(data.totalPages || 0)
      setTotalItems(data.total || 0)
      if (data.page) setPage(data.page)
    } catch (err) {
      const msg = err.message || 'Failed to load users'
      setLoadError(msg)
      showToast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [page, perPage, showToast])

  const loadServerOwner = useCallback(async () => {
    try {
      const statusRes = await adminApi.get('/status')
      setServerOwner(statusRes.data?.ownerUserId || '')
    } catch {
      setServerOwner('')
    }
  }, [])

  const loadAllUsersList = useCallback(async () => {
    try {
      const res = await adminUsers.getList(1, 9999)
      const allUsers = res.data.users || []
      setAllUsersList(allUsers)
    } catch {
      showToast('Failed to load users list', 'error')
    }
  }, [showToast])

  const loadWatchlistMode = useCallback(async () => {
    setWatchlistLoading(true)
    try {
      const res = await adminSettings.getWatchlistMode()
      setWatchlistMode(res.data?.mode || 'watchlist')
    } catch {
      setWatchlistMode('watchlist')
    } finally {
      setWatchlistLoading(false)
    }
  }, [])

  const loadIndividualSeasons = useCallback(async () => {
    setLoadingIndividualSeasons(true)
    try {
      const res = await adminApi.get('/status')
      setIndividualSeasonsEnabled(res.data?.individualSeasonsEnabled ?? false)
      setDiscoverEnabled(res.data?.discoverEnabled ?? false)
    } catch {
      setIndividualSeasonsEnabled(false)
    } finally {
      setLoadingIndividualSeasons(false)
    }
  }, [])

  const loadGlobalLimits = useCallback(async () => {
    setLoadingGlobalLimits(true)
    try {
      const res = await adminRequestLimits.getGlobal()
      setGlobalLimits(res.data || {
        enabled: false,
        movieLimit: 0,
        movieWindowDays: 7,
        seasonLimit: 0,
        seasonWindowDays: 7,
      })
    } catch {
      setGlobalLimits({
        enabled: false,
        movieLimit: 0,
        movieWindowDays: 7,
        seasonLimit: 0,
        seasonWindowDays: 7,
      })
    } finally {
      setLoadingGlobalLimits(false)
    }
  }, [])

  const loadAutoApprove = useCallback(async () => {
    setLoadingAutoApprove(true)
    try {
      const res = await adminSettings.getAutoApprove()
      setAutoApproveMovies(res.data?.movies ?? true)
      setAutoApproveTv(res.data?.tv ?? true)
    } catch {
      setAutoApproveMovies(true)
      setAutoApproveTv(true)
    } finally {
      setLoadingAutoApprove(false)
    }
  }, [])

  const loadAutoRequest = useCallback(async () => {
    setLoadingAutoRequest(true)
    try {
      const res = await adminApi.get('/status')
      setAutoRequestMovies(res.data?.autoRequestMovies ?? false)
      setAutoRequestTv(res.data?.autoRequestTv ?? false)
    } catch {
      setAutoRequestMovies(false)
      setAutoRequestTv(false)
    } finally {
      setLoadingAutoRequest(false)
    }
  }, [])

  useEffect(() => {
    loadUsers()
    loadServerOwner()
    loadAllUsersList()
    loadWatchlistMode()
    loadIndividualSeasons()
    loadGlobalLimits()
    loadAutoApprove()
    loadAutoRequest()
  }, [loadUsers, loadServerOwner, loadAllUsersList, loadWatchlistMode, loadIndividualSeasons, loadGlobalLimits, loadAutoApprove, loadAutoRequest])

  const handlePageChange = useCallback((newPage) => {
    if (newPage < 1 || newPage > totalPages) return
    loadUsers(newPage, perPage)
  }, [loadUsers, perPage, totalPages])

  const handlePerPageChange = useCallback((newPerPage) => {
    const newPage = 1
    setPerPage(newPerPage)
    loadUsers(newPage, newPerPage)
  }, [loadUsers])

  const handleOwnerChange = useCallback((e) => {
    setServerOwner(e.target.value)
  }, [])

  const handleSaveOwner = useCallback(async () => {
    setSavingOwner(true)
    try {
      await adminSettings.setOwnerUser(serverOwner)
      showToast('Server owner updated successfully')
    } catch (err) {
      const msg = err.message || 'Failed to save server owner'
      showToast(msg, 'error')
    } finally {
      setSavingOwner(false)
    }
  }, [serverOwner, showToast])

  const handleWatchlistModeChange = useCallback(async () => {
    setSavingWatchlistMode(true)
    try {
      const newMode = watchlistMode === 'watchlist' ? 'playlist' : 'watchlist'
      await adminSettings.setWatchlistMode(newMode)
      setWatchlistMode(newMode)
      const displayName = newMode === 'watchlist' ? 'Plex Watchlist' : 'Diskovarr Playlist'
      showToast(`Watchlist mode set to ${displayName}`)
    } catch (err) {
      const msg = err.message || 'Failed to update watchlist mode'
      showToast(msg, 'error')
    } finally {
      setSavingWatchlistMode(false)
    }
  }, [watchlistMode, showToast])

  const handleIndividualSeasonsChange = useCallback(async (checked) => {
    setSavingIndividualSeasons(true)
    setIndividualSeasonsEnabled(checked)
    try {
      await adminConnections.save({ individual_seasons_enabled: checked })
      showToast(`Individual seasons ${checked ? 'enabled' : 'disabled'}`)
    } catch (err) {
      const msg = err.message || 'Failed to save individual seasons setting'
      showToast(msg, 'error')
      setIndividualSeasonsEnabled(!checked)
    } finally {
      setSavingIndividualSeasons(false)
    }
  }, [showToast])

  const handleMovieUnlimitedChange = useCallback((checked) => {
    setGlobalLimits((prev) => ({
      ...prev,
      movieLimit: checked ? 0 : (prev.movieLimit || 1),
    }))
  }, [])

  const handleSeasonUnlimitedChange = useCallback((checked) => {
    setGlobalLimits((prev) => ({
      ...prev,
      seasonLimit: checked ? 0 : (prev.seasonLimit || 1),
    }))
  }, [])

  const handleSaveGlobalLimits = useCallback(async () => {
    setSavingGlobalLimits(true)
    try {
      await adminRequestLimits.setGlobal({
        enabled: globalLimits.enabled ? '1' : '0',
        movieLimit: globalLimits.movieLimit,
        movieWindowDays: globalLimits.movieWindowDays || 7,
        seasonLimit: globalLimits.seasonLimit,
        seasonWindowDays: globalLimits.seasonWindowDays || 7,
      })
      showToast('Request limits saved')
      await loadGlobalLimits()
    } catch (err) {
      const msg = err.message || 'Failed to save request limits'
      showToast(msg, 'error')
    } finally {
      setSavingGlobalLimits(false)
    }
  }, [globalLimits, showToast, loadGlobalLimits])

  const handleAutoApproveChange = useCallback(async (type, checked) => {
    setSavingAutoApprove(true)
    try {
      await adminSettings.setAutoApprove(
        type === 'movies' ? checked : undefined,
        type === 'tv' ? checked : undefined,
      )
      if (type === 'movies') setAutoApproveMovies(checked)
      else setAutoApproveTv(checked)
      showToast(`Auto-approve ${type} ${checked ? 'enabled' : 'disabled'}`)
    } catch (err) {
      const msg = err.message || 'Failed to save auto-approve setting'
      showToast(msg, 'error')
    } finally {
      setSavingAutoApprove(false)
    }
  }, [showToast])

  const handleAutoRequestChange = useCallback(async (type, checked) => {
    setSavingAutoRequest(true)
    try {
      await adminSettings.setAutoRequest(type, checked)
      if (type === 'movies') setAutoRequestMovies(checked)
      else setAutoRequestTv(checked)
      showToast(`Auto-request ${type} ${checked ? 'enabled' : 'disabled'}`)
    } catch (err) {
      const msg = err.message || 'Failed to save auto-request setting'
      showToast(msg, 'error')
    } finally {
      setSavingAutoRequest(false)
    }
  }, [showToast])

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === users.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(users.map((u) => u.user_id)))
    }
  }, [users, selectedIds])

  const handleSelectUser = useCallback((userId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }, [])

  const handleBulkClearWatched = useCallback(async () => {
    if (selectedIds.size === 0) return
    setBulkLoading(true)
    try {
      if (selectedIds.size >= 50) {
        await adminUsers.clearAllWatched()
        showToast(`Cleared watched caches for all users`)
      } else {
        const promises = Array.from(selectedIds).map((id) => adminUsers.clearUserWatched(id))
        await Promise.all(promises)
        showToast(`Cleared watched caches for ${selectedIds.size} users`)
      }
      setSelectedIds(new Set())
    } catch (err) {
      const msg = err.message || 'Failed to clear watched caches'
      showToast(msg, 'error')
    } finally {
      setBulkLoading(false)
    }
  }, [selectedIds, showToast])

  const handleBulkClearDismissals = useCallback(async () => {
    if (selectedIds.size === 0) return
    setBulkLoading(true)
    try {
      if (selectedIds.size >= 50) {
        await adminUsers.clearAllDismissals()
        showToast(`Cleared dismissals for all users`)
      } else {
        const promises = Array.from(selectedIds).map((id) => adminUsers.clearUserDismissals(id))
        await Promise.all(promises)
        showToast(`Cleared dismissals for ${selectedIds.size} users`)
      }
      setSelectedIds(new Set())
    } catch (err) {
      const msg = err.message || 'Failed to clear dismissals'
      showToast(msg, 'error')
    } finally {
      setBulkLoading(false)
    }
  }, [selectedIds, showToast])

  const handleBulkClearRecCache = useCallback(async () => {
    setBulkLoading(true)
    try {
      await adminUsers.clearRecCache()
      showToast(`Cleared recommendation cache`)
    } catch (err) {
      const msg = err.message || 'Failed to clear recommendation cache'
      showToast(msg, 'error')
    } finally {
      setBulkLoading(false)
    }
  }, [showToast])

  const allSelected = useMemo(() => {
    return users.length > 0 && selectedIds.size === users.length
  }, [users, selectedIds])

  const ownerUser = useMemo(() => {
    return allUsersList.find((u) => u.user_id === serverOwner) || null
  }, [allUsersList, serverOwner])

  const [discoverEnabled, setDiscoverEnabled] = useState(connections?.discoverEnabled ?? false)

  if (loading) {
    return (
      <div className="admin-section">
        <div className="admin-section-header">
          <h2 className="section-title">Users</h2>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading users...</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="admin-section">
        <div className="admin-section-header">
          <h2 className="section-title">Users</h2>
        </div>
        <div className="error-banner">
          <span>{loadError}</span>
          <button className="btn-admin btn-primary" onClick={() => loadUsers()}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Server Owner & Watchlist Mode */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">Server Owner &amp; Watchlist Mode</h2>
            <p className="section-desc">
              Select the server owner user. The owner has full access to all admin features.
              Toggle the watchlist mode to switch between Plex Watchlist and Diskovarr Playlist.
            </p>
          </div>
        </div>

        <div className="admin-actions" style={{ flexWrap: 'wrap', gap: 24 }}>
          <div className="conn-field-group" style={{ flex: '1 1 260px', minWidth: 0 }}>
            <label className="conn-field-label">Server Owner</label>
            <div className="conn-input-wrap" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              <select
                className="conn-select"
                value={serverOwner}
                onChange={handleOwnerChange}
                style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                disabled={savingOwner}
              >
                <option value="">Select a user...</option>
                {allUsersList.map((u) => (
                  <option key={u.user_id} value={u.user_id}>
                    {u.username} {u.user_id ? `(${u.user_id})` : ''}
                  </option>
                ))}
              </select>
              {ownerUser && (
                <span className="conn-hint">
                  Currently: {ownerUser.username} {ownerUser.user_id && `(${ownerUser.user_id})`}
                </span>
              )}
            </div>
          </div>

          <button
            className="btn-admin btn-primary"
            onClick={handleSaveOwner}
            disabled={savingOwner || !serverOwner}
            style={{ alignSelf: 'flex-end' }}
          >
            {savingOwner ? 'Saving...' : 'Save Owner'}
          </button>
        </div>

        <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
            <div>
              <span className="conn-field-label" style={{ marginBottom: 4 }}>Watchlist Mode</span>
              <p className="section-desc" style={{ margin: 0 }}>
                Toggle between Plex Watchlist and Diskovarr Playlist. This determines how the watchlist is populated and managed.
              </p>
            </div>
            <div className="conn-toggle-row">
              <div style={{ display: 'flex', gap: 10, fontSize: '0.85rem', color: 'var(--text-muted)', alignItems: 'center' }}>
                <span style={{ fontWeight: watchlistMode === 'watchlist' ? 600 : 400, color: watchlistMode === 'watchlist' ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Plex Watchlist
                </span>
                <label className="slide-toggle slide-toggle-choice" style={{ width: 56 }}>
                  <input
                    type="checkbox"
                    checked={watchlistMode === 'playlist'}
                    onChange={handleWatchlistModeChange}
                    disabled={savingWatchlistMode || watchlistLoading}
                  />
                  <span className="slide-track" />
                </label>
                <span style={{ fontWeight: watchlistMode === 'playlist' ? 600 : 400, color: watchlistMode === 'playlist' ? 'var(--accent)' : 'var(--text-muted)' }}>
                  Diskovarr Playlist
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Individual Requests */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">Individual Requests</h2>
            <p className="section-desc" style={{ margin: 0 }}>
              When enabled, TV show requests present a season selector instead of requesting all seasons at once.
            </p>
          </div>
          <div className="conn-toggle-row" style={{ margin: 0 }}>
            <label className="slide-toggle">
              <input
                type="checkbox"
                checked={individualSeasonsEnabled}
                onChange={(e) => handleIndividualSeasonsChange(e.target.checked)}
                disabled={savingIndividualSeasons || loadingIndividualSeasons}
              />
              <span className="slide-track" />
            </label>
          </div>
        </div>
      </div>

      {/* Users & Watch Sync */}
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">Users &amp; Watch Sync</h2>
            <p className="section-desc">
              Manage individual user settings and permissions. Select users to perform bulk actions such as clearing watched caches or dismissals.
              The Settings column is only visible when Discover is enabled.
            </p>
          </div>
        </div>

        <BulkEditToolbar
          selectedCount={selectedIds.size}
          onClearWatched={handleBulkClearWatched}
          onClearDismissals={handleBulkClearDismissals}
          onClearRecCache={handleBulkClearRecCache}
          onOpenBulkSettings={() => onOpenBulkSettings?.(Array.from(selectedIds))}
          loading={bulkLoading}
        />

        <div className="user-table-wrap">
          <div className="user-table">
            <div
              className="user-table-header"
              style={{ gridTemplateColumns: discoverEnabled ? '36px minmax(140px,1fr) 110px 80px 120px 120px' : '36px minmax(140px,1fr) 110px 80px 120px' }}
            >
              <span>
                <label className="slide-toggle" style={{ width: 32, height: 20, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    className="themed-checkbox"
                    checked={allSelected}
                    onChange={handleSelectAll}
                    style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                  />
                  <span className="slide-track" style={{ width: 32, height: 20, borderRadius: 10 }} />
                </label>
              </span>
              <span>User</span>
              <span>Watched</span>
              <span>Requests</span>
              <span>Last Visit</span>
              {discoverEnabled && <span>Settings</span>}
            </div>

            {users.length === 0 ? (
              <div className="empty-state" style={{
                padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)',
                fontSize: '0.9rem',
              }}>
                No users found.
              </div>
            ) : (
              users.map((user) => {
                const isSelected = selectedIds.has(user.user_id)
                return (
                  <div
                    className="user-table-row"
                    key={user.user_id}
                    style={{
                      gridTemplateColumns: discoverEnabled ? '36px minmax(140px,1fr) 110px 80px 120px 120px' : '36px minmax(140px,1fr) 110px 80px 120px',
                      background: isSelected ? 'var(--accent-dim)' : undefined,
                    }}
                  >
                    <span>
                      <label className="slide-toggle" style={{ width: 32, height: 20, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          className="themed-checkbox"
                          checked={isSelected}
                          onChange={() => handleSelectUser(user.user_id)}
                          style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                        />
                        <span className="slide-track" style={{ width: 32, height: 20, borderRadius: 10 }} />
                      </label>
                    </span>
                    <span className="user-id">
                      <Avatar url={user.thumb} username={user.username} />
                      <div>
                        <span>{user.username}</span>
                        {user.user_id && (
                          <span className="user-id-sub">{user.user_id}</span>
                        )}
                      </div>
                    </span>
                    <span className="watched-count-cell">
                      {(user.watched_count ?? 0).toLocaleString()} items
                    </span>
                    <span>
                      {user.request_count > 0 ? user.request_count.toLocaleString() : '—'}
                    </span>
                    <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      {formatRelativeTime(user.last_login)}
                    </span>
                    {discoverEnabled && (
                      <span className="user-actions">
                        <button
                          className="btn-admin btn-sm"
                          onClick={() => onOpenUserSettings?.(user.user_id, user.username)}
                          title={`Edit settings for ${user.username}`}
                        >
                          Settings
                        </button>
                      </span>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        <PaginationControls
          currentPage={page}
          totalPages={totalPages}
          perPage={perPage}
          totalItems={totalItems}
          onPageChange={handlePageChange}
          onPerPageChange={handlePerPageChange}
        />

        {/* Bulk Clear ALL buttons */}
        <div className="admin-actions" style={{ marginTop: 16 }}>
          <button
            className="btn-admin btn-danger btn-sm"
            onClick={() => {
              if (window.confirm('Clear ALL watched caches for all users?')) {
                handleBulkClearWatched()
              }
            }}
            disabled={bulkLoading}
          >
            Clear All Watched Caches
          </button>
          <button
            className="btn-admin btn-danger btn-sm"
            onClick={() => {
              if (window.confirm('Clear ALL dismissals for all users?')) {
                handleBulkClearDismissals()
              }
            }}
            disabled={bulkLoading}
          >
            Clear All Dismissals
          </button>
          <button
            className="btn-admin btn-sm"
            onClick={handleBulkClearRecCache}
            disabled={bulkLoading}
          >
            Clear Rec Cache (All Users)
          </button>
        </div>

        {/* Global Request Limits (only when Discover enabled) */}
        {discoverEnabled && (
          <div className="admin-section" style={{ marginTop: 24 }}>
            <div className="admin-section-header">
              <h2 className="section-title">Global Request Limits</h2>
            </div>
            <p className="section-desc" style={{ marginBottom: 20 }}>
              Default limits applied to each user individually. Users with the override toggle enabled can have custom limits via <strong>Settings</strong>.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              {/* Movies */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 84, fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>Movies</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    className="themed-checkbox"
                    checked={globalLimits.movieLimit === 0}
                    onChange={handleMovieUnlimitedChange}
                    disabled={loadingGlobalLimits}
                  />
                  Unlimited
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: globalLimits.movieLimit === 0 ? 0.5 : 1, pointerEvents: globalLimits.movieLimit === 0 ? 'none' : 'auto' }}>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Count</label>
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      className="btn-admin limit-num"
                      value={globalLimits.movieLimit || 1}
                      onChange={(e) => setGlobalLimits((p) => ({ ...p, movieLimit: Math.min(9999, Math.max(1, Number(e.target.value) || 0))}))}
                    />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>movies per</span>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Days</label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      className="btn-admin limit-num"
                      value={globalLimits.movieWindowDays}
                      onChange={(e) => setGlobalLimits((p) => ({ ...p, movieWindowDays: Math.min(365, Math.max(1, Number(e.target.value) || 0))}))}
                    />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>days</span>
                </div>
              </div>

              {/* TV Seasons */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 84, fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>TV Seasons</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text-secondary)', userSelect: 'none' }}>
                  <input
                    type="checkbox"
                    className="themed-checkbox"
                    checked={globalLimits.seasonLimit === 0}
                    onChange={handleSeasonUnlimitedChange}
                    disabled={loadingGlobalLimits}
                  />
                  Unlimited
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: globalLimits.seasonLimit === 0 ? 0.5 : 1, pointerEvents: globalLimits.seasonLimit === 0 ? 'none' : 'auto' }}>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Count</label>
                    <input
                      type="number"
                      min="1"
                      max="9999"
                      className="btn-admin limit-num"
                      value={globalLimits.seasonLimit || 1}
                      onChange={(e) => setGlobalLimits((p) => ({ ...p, seasonLimit: Math.min(9999, Math.max(1, Number(e.target.value) || 0))}))}
                    />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>seasons per</span>
                  <div className="conn-field-group">
                    <label className="conn-field-label">Days</label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      className="btn-admin limit-num"
                      value={globalLimits.seasonWindowDays}
                      onChange={(e) => setGlobalLimits((p) => ({ ...p, seasonWindowDays: Math.min(365, Math.max(1, Number(e.target.value) || 0))}))}
                    />
                  </div>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>days</span>
                </div>
              </div>
            </div>
            <button
              className="btn-admin btn-primary btn-sm"
              onClick={handleSaveGlobalLimits}
              disabled={savingGlobalLimits || loadingGlobalLimits}
            >
              Save
            </button>

            {/* Auto-approve subsection */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Auto Approve Requests
              </p>
              <p className="section-desc" style={{ marginBottom: 14, fontSize: '0.82rem' }}>
                When enabled, requests go directly to the configured service. When disabled, requests enter the queue for review.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <label className="slide-toggle">
                    <input
                      type="checkbox"
                      checked={autoApproveMovies}
                      onChange={(e) => handleAutoApproveChange('movies', e.target.checked)}
                      disabled={savingAutoApprove || loadingAutoApprove}
                    />
                    <span className="slide-track" />
                  </label>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>Movies</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <label className="slide-toggle">
                    <input
                      type="checkbox"
                      checked={autoApproveTv}
                      onChange={(e) => handleAutoApproveChange('tv', e.target.checked)}
                      disabled={savingAutoApprove || loadingAutoApprove}
                    />
                    <span className="slide-track" />
                  </label>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>TV Shows</span>
                </div>
              </div>
            </div>

            {/* Auto-request watchlist subsection */}
            <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
              <p style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 14px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                Auto-Request Watchlist
              </p>
              <p className="section-desc" style={{ marginBottom: 14, fontSize: '0.82rem' }}>
                When enabled, items added to a user's Plex watchlist are automatically submitted as requests.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <label className="slide-toggle">
                    <input
                      type="checkbox"
                      checked={autoRequestMovies}
                      onChange={(e) => handleAutoRequestChange('movies', e.target.checked)}
                      disabled={savingAutoRequest || loadingAutoRequest}
                    />
                    <span className="slide-track" />
                  </label>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>Movies</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <label className="slide-toggle">
                    <input
                      type="checkbox"
                      checked={autoRequestTv}
                      onChange={(e) => handleAutoRequestChange('tv', e.target.checked)}
                      disabled={savingAutoRequest || loadingAutoRequest}
                    />
                    <span className="slide-track" />
                  </label>
                  <span style={{ fontSize: '0.9rem', color: '#fff', fontWeight: 500 }}>TV Shows</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
