import React, { useState, useCallback, useEffect } from 'react'
import { historyApi } from '../services/api'
import UserMultiSelect from '../components/UserMultiSelect'
import DateRangeFilter from '../components/DateRangeFilter'
import ReviewModal from '../components/ReviewModal'
import StarsDisplay from '../components/StarsDisplay'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${mm}/${dd}/${yyyy}`
}

// duration is the actual time watched, in seconds (from Tautulli) → e.g. "2h6m", "24m"
function fmtDuration(seconds) {
  if (!seconds) return ''
  const mins = Math.floor(seconds / 60)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

function fmtWatchedTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return `Watched at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function fmtClockTime(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function StarBadge({ rating }) {
  if (!rating) return null
  return <StarsDisplay rating={rating} size="0.82rem" />
}

export default function WatchHistory() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const isAdmin = !!(user?.isAdmin || user?.isPlexAdminUser || user?.isElevated || user?.isPrivileged)

  const [historyItems, setHistoryItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(() => parseInt(localStorage.getItem('diskovarr_history_per_page') || '25'))

  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [mediaType, setMediaType] = useState('all')
  // 'all' | 'complete' | 'incomplete' | 'reviewed' — 'reviewed' is a review filter,
  // the rest are watched-status filters (mutually exclusive here to save toolbar space).
  const [watchedStatus, setWatchedStatus] = useState('all')
  const [sortBy, setSortBy] = useState('date')
  const [sortDir, setSortDir] = useState('desc')
  const [dateFrom, setDateFrom] = useState(null)
  const [dateTo, setDateTo] = useState(null)
  // null = all users (default aggregate); array = explicit included-user subset
  const [selectedUserIds, setSelectedUserIds] = useState(null)
  const [users, setUsers] = useState([])

  const [reviewModalItem, setReviewModalItem] = useState(null)
  const [expandedGroups, setExpandedGroups] = useState(() => new Set())

  const toggleGroup = (key) => setExpandedGroups(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(t)
  }, [searchQuery])

  const loadHistory = useCallback(async (pageNum) => {
    setLoading(true)
    try {
      const params = {
        mediaType,
        // 'reviewed' isn't a watched-status; send it as the review filter instead.
        watchedStatus: watchedStatus === 'reviewed' ? 'all' : watchedStatus,
        sortBy,
        sortDir,
        page: pageNum,
        perPage,
      }
      if (debouncedSearch) params.search = debouncedSearch
      if (dateFrom) params.startDate = dateFrom
      if (dateTo) params.endDate = dateTo
      if (watchedStatus === 'reviewed') params.reviewedOnly = '1'

      // Admin user filter: null = all (omit); a subset → send userIds;
      // none selected → show nothing without hitting the API.
      if (isAdmin && selectedUserIds !== null) {
        if (selectedUserIds.length === 0) {
          setHistoryItems([]); setTotalPages(1); setTotal(0); setPage(1); setLoading(false)
          return
        }
        if (selectedUserIds.length < users.length) params.userIds = selectedUserIds.join(',')
      }

      const { data } = await historyApi.getHistory(params)
      setHistoryItems(data.items || [])
      setTotalPages(data.pages || 1)
      setTotal(data.total || 0)
      setPage(pageNum || 1)
    } catch (e) {
      toastError(t('Failed to load watch history'))
    } finally {
      setLoading(false)
    }
  }, [mediaType, watchedStatus, sortBy, sortDir, perPage, debouncedSearch, dateFrom, dateTo, isAdmin, selectedUserIds, users.length, toastError, t])

  useEffect(() => {
    ;(async () => { await loadHistory(1) })()
  }, [loadHistory])

  useEffect(() => {
    if (!isAdmin) return
    historyApi.getUsers()
      .then(({ data }) => setUsers(data.users || []))
      .catch(() => {})
  }, [isAdmin])

  const handleFilterChange = (setter) => (val) => {
    setter(val)
    setPage(1)
  }

  const handlePageChange = (delta) => {
    const newPage = page + delta
    if (newPage < 1 || newPage > totalPages) return
    loadHistory(newPage)
  }

  const handlePerPageChange = (e) => {
    const val = parseInt(e.target.value)
    setPerPage(val)
    localStorage.setItem('diskovarr_history_per_page', val)
    loadHistory(1)
  }

  const userFilterActive = isAdmin && selectedUserIds !== null && selectedUserIds.length !== users.length
  const hasActiveFilters = !!(debouncedSearch || userFilterActive || dateFrom || dateTo || mediaType !== 'all' || watchedStatus !== 'all')

  const clearAllFilters = () => {
    setSearchQuery('')
    setMediaType('all')
    setWatchedStatus('all')
    setSortBy('date')
    setSortDir('desc')
    setDateFrom(null)
    setDateTo(null)
    setSelectedUserIds(null)
  }

  const handleReviewSave = () => {
    loadHistory(page)
  }

  const handleDateRange = (next) => {
    setDateFrom(next?.from ?? null)
    setDateTo(next?.to ?? null)
    setPage(1)
  }

  // ── Row renderers (shared by single rows, group parents, and child episodes) ──

  const renderUserCell = (it) => (
    <td style={{ width: '120px' }}>
      <div className="queue-title-cell">
        {it.userAvatarUrl && (
          <img
            src={it.userAvatarUrl}
            alt=""
            onError={(e) => { e.currentTarget.style.display = 'none'; const ph = e.currentTarget.nextElementSibling; if (ph) ph.style.display = 'flex' }}
            style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
          />
        )}
        <div
          className="nav-avatar-placeholder"
          style={{ width: '28px', height: '28px', fontSize: '0.7rem', display: it.userAvatarUrl ? 'none' : 'flex' }}
        >
          {(it.userName || '?')[0].toUpperCase()}
        </div>
        <span style={{ fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {it.userName || '—'}
        </span>
      </div>
    </td>
  )

  const renderProgressCell = (it) => (
    <td>
      <div className="progress-bar-wrap" style={{ width: '80px', height: '6px', background: 'var(--bg-elevated)', borderRadius: '3px', overflow: 'hidden' }}>
        <div
          className="progress-bar-fill"
          style={{
            width: `${Math.min(100, it.percentComplete || 0)}%`,
            height: '100%',
            background: it.watchedStatus === 'complete' ? 'var(--accent)' : '#00b4d8',
            borderRadius: '3px',
            transition: 'width 0.3s',
          }}
        />
      </div>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px', display: 'block' }}>
        {Math.round(it.percentComplete || 0)}%{fmtDuration(it.duration) ? ` · ${fmtDuration(it.duration)}` : ''}
      </span>
    </td>
  )

  // Mirror of the backend eligibility rule: movies need >10% watched (or a
  // completed play) to review; shows qualify with any episode in history.
  const canReview = (it) => !!it.review || it.mediaType !== 'movie'
    || it.watchedStatus === 'complete' || (it.percentComplete || 0) > 10

  // Combined Review/Action cell: a single button that writes, or edits/views an
  // existing review (showing its rating).
  const renderReviewCell = (it) => (
    <td>
      {it.isOwnWatch && (
        <button
          className="btn-page"
          onClick={(e) => { e.stopPropagation(); setReviewModalItem(it) }}
          disabled={!canReview(it)}
          title={canReview(it) ? undefined : t('Watch at least 10% to review')}
          style={{ fontSize: '0.82rem', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          {it.review ? (<><StarBadge rating={it.review.rating} /> {t('Edit')}</>) : 'Write Review'}
        </button>
      )}
    </td>
  )

  const renderSingleRow = (item) => (
    <tr key={item.historyId} className="history-row" style={{ cursor: item.isOwnWatch && canReview(item) ? 'pointer' : 'default' }} onClick={() => { if (item.isOwnWatch && canReview(item)) setReviewModalItem(item) }}>
      <td>
        <div className="queue-title-cell">
          {item.posterUrl ? (
            <img className="queue-poster" src={item.posterUrl} alt="" loading="lazy" />
          ) : (
            <div className="queue-poster-placeholder">?</div>
          )}
          <div className="queue-title-info">
            <div className="queue-title">{item.title}</div>
            {item.mediaType === 'episode' && (item.parentTitle || (item.seasonNumber != null && item.episodeNumber != null)) && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {item.parentTitle}
                {item.seasonNumber != null && item.episodeNumber != null && `${item.parentTitle ? ' · ' : ''}S${item.seasonNumber}E${item.episodeNumber}`}
              </div>
            )}
            {item.resolution && (
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{item.resolution}</span>
            )}
          </div>
        </div>
      </td>
      {isAdmin && renderUserCell(item)}
      <td>
        <span className="scope-badge">
          {item.mediaType === 'movie' ? 'Movie' : item.mediaType === 'episode' ? 'TV' : item.mediaType}
        </span>
      </td>
      <td style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        <span title={fmtWatchedTime(item.watchedAt)}>{fmtDate(item.watchedAt)}</span>
      </td>
      {renderProgressCell(item)}
      {renderReviewCell(item)}
    </tr>
  )

  const renderGroupRow = (group) => {
    const expanded = expandedGroups.has(group.groupKey)
    const completed = group.children.filter(c => c.watchedStatus === 'complete').length
    return (
      <tr key={group.groupKey} className="history-row history-group-row" style={{ cursor: 'pointer' }} onClick={() => toggleGroup(group.groupKey)}>
        <td>
          <div className="queue-title-cell">
            <button
              className="history-expand-btn"
              onClick={(e) => { e.stopPropagation(); toggleGroup(group.groupKey) }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? '▾' : '▸'}
            </button>
            {group.posterUrl ? (
              <img className="queue-poster" src={group.posterUrl} alt="" loading="lazy" />
            ) : (
              <div className="queue-poster-placeholder">?</div>
            )}
            <div className="queue-title-info">
              <div className="queue-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {group.title}
                {!expanded && (
                  <span className="history-group-badge" title={`${group.episodeCount} episodes`}>{group.episodeCount}</span>
                )}
              </div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '2px' }}>
                {group.episodeCount} episodes
              </div>
            </div>
          </div>
        </td>
        {isAdmin && renderUserCell(group)}
        <td>
          <span className="scope-badge">{t('TV')}</span>
        </td>
        <td style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          <span title={fmtWatchedTime(group.watchedAt)}>{fmtDate(group.watchedAt)}</span>
        </td>
        <td>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{completed}/{group.episodeCount} watched</span>
          {fmtDuration(group.duration) && (
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px', display: 'block' }}>{fmtDuration(group.duration)}</span>
          )}
        </td>
        {renderReviewCell(group)}
      </tr>
    )
  }

  const renderChildRow = (child) => (
    <tr key={child.historyId} className="history-row history-child-row">
      <td>
        <div className="queue-title-cell" style={{ paddingLeft: '34px' }}>
          {child.posterUrl ? (
            <img className="queue-poster" src={child.posterUrl} alt="" loading="lazy" />
          ) : (
            <div className="queue-poster-placeholder">?</div>
          )}
          <div className="queue-title-info">
            <div className="queue-title" style={{ fontSize: '0.88rem' }}>
              {child.seasonNumber != null && child.episodeNumber != null && (
                <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>S{child.seasonNumber}E{child.episodeNumber}</span>
              )}
              {child.title}
            </div>
            {child.resolution && (
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{child.resolution}</span>
            )}
          </div>
        </div>
      </td>
      {isAdmin && <td />}
      <td />
      <td style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{fmtClockTime(child.watchedAt)}</td>
      {renderProgressCell(child)}
      <td />
    </tr>
  )

  return (
    <main className="main-content queue-page">
      <div className="queue-hero">
        <h1>{t('Watch History')}</h1>
        <p>{t('Your watch history. Click any item to write or edit a review.')}</p>
      </div>

      <div className="list-filter-toolbar">
        <div className="list-search-bar">
          <input
            className="list-search-input"
            type="search"
            placeholder={t('Search by title...')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
          {searchQuery && (
            <button className="list-search-clear" onClick={() => setSearchQuery('')} type="button">&times;</button>
          )}
        </div>

        <select
          className="filter-select"
          value={mediaType}
          onChange={e => { handleFilterChange(setMediaType)(e.target.value); setPage(1) }}
          style={{ fontSize: '0.85rem', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)' }}
        >
          <option value="all">{t('All Types')}</option>
          <option value="movie">{t('Movies')}</option>
          <option value="episode">{t('TV Shows')}</option>
        </select>

        <select
          className="filter-select"
          value={watchedStatus}
          onChange={e => { handleFilterChange(setWatchedStatus)(e.target.value); setPage(1) }}
          style={{ fontSize: '0.85rem', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)' }}
        >
          <option value="all">{t('All Status')}</option>
          <option value="complete">{t('Complete')}</option>
          <option value="incomplete">{t('Incomplete')}</option>
          <option value="reviewed">{t('Reviewed')}</option>
        </select>

        <DateRangeFilter
          value={{ from: dateFrom, to: dateTo }}
          onChange={handleDateRange}
          label={t('Date')}
          placeholder={t('Any date')}
        />

        {isAdmin && users.length > 0 && (
          <UserMultiSelect
            options={users}
            value={selectedUserIds ?? users.map(u => String(u.id))}
            onChange={(ids) => { setSelectedUserIds(ids); setPage(1) }}
            label={t('Users')}
          />
        )}

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <select
            value={sortBy}
            onChange={e => { setSortBy(e.target.value); setPage(1) }}
            style={{ fontSize: '0.85rem', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)' }}
          >
            <option value="date">{t('Date')}</option>
            <option value="title">{t('Title')}</option>
            <option value="duration">{t('Duration')}</option>
          </select>
          <button
            onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', color: 'var(--text)', fontSize: '0.85rem' }}
            title={`Sort ${sortDir === 'asc' ? 'descending' : 'ascending'}`}
          >
            {sortDir === 'asc' ? '↑' : '↓'}
          </button>
        </div>

        {hasActiveFilters && (
          <button className="chip-sm chip-sm-clear" onClick={clearAllFilters}>
            {t('Clear Filters')}
          </button>
        )}
      </div>

      {loading ? (
        <div className="queue-loading">{t('Loading watch history...')}</div>
      ) : historyItems.length === 0 ? (
        <div className="queue-empty">
          {hasActiveFilters
            ? 'No matching history found. Try adjusting your filters.'
            : 'No watch history found. Make sure Tautulli is connected.'}
        </div>
      ) : (
        <div className="table-scroll-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <th>{t('Title')}</th>
                {isAdmin && <th>{t('User')}</th>}
                <th>{t('Type')}</th>
                <th>{t('Date Watched')}</th>
                <th>{t('Progress')}</th>
                <th>{t('Review')}</th>
              </tr>
            </thead>
            <tbody>
              {historyItems.flatMap((item) => {
                if (!item.isGroup) return [renderSingleRow(item)]
                const rows = [renderGroupRow(item)]
                if (expandedGroups.has(item.groupKey)) {
                  for (const child of item.children) rows.push(renderChildRow(child))
                }
                return rows
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="queue-pagination">
          <button className="btn-page" onClick={() => handlePageChange(-1)} disabled={page <= 1}>{t('❮ Prev')}</button>
          <span>{totalPages > 1 ? `Page ${page} of ${totalPages} (${total} total)` : `${total} total`}</span>
          <button className="btn-page" onClick={() => handlePageChange(1)} disabled={page >= totalPages}>{t('Next ❯')}</button>
          <select value={perPage} onChange={handlePerPageChange}>
            <option value="25">{t('25 / page')}</option>
            <option value="50">{t('50 / page')}</option>
            <option value="100">{t('100 / page')}</option>
          </select>
        </div>
      )}

      {reviewModalItem && (
        <ReviewModal
          onClose={() => setReviewModalItem(null)}
          historyItem={reviewModalItem}
          onSave={handleReviewSave}
        />
      )}
    </main>
  )
}
