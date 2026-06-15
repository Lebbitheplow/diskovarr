import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  queueApi,
  searchApi,
  exploreApi,
} from '../services/api'
import DetailModal from '../components/DetailModal'
import Modal from '../components/Modal'
import SearchableDropdown from '../components/SearchableDropdown'
import DateRangeFilter from '../components/DateRangeFilter'
import useListFilters from '../hooks/useListFilters'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { posterUrl } from '../utils/media'
import { timeAgo as fmtDate } from '../utils/format'
import { useTranslation } from 'react-i18next'

const STATUS_LABELS = {
  pending: 'Pending Approval',
  requested: 'Requested',
  available: 'Available',
  approved: 'Approved',
  denied: 'Denied',
}

const COL_TO_SORT = { title: 'title', user: 'username', type: 'media_type', age: 'requested_at', status: 'status' }


export default function Queue() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const { error: toastError, success: toastSuccess } = useToast()

  const isAdmin = !!(user?.isAdmin || user?.isPlexAdminUser || user?.isElevated || user?.isPrivileged)

  const {
    searchQuery, setSearchQuery, debouncedSearchQuery,
    selectedUser, setSelectedUser,
    currentFilter, setCurrentFilter,
    dateFrom, dateTo, setDateRange,
    users, setUsers,
    hasActiveFilters, clearAllFilters,
  } = useListFilters({ initialFilter: 'all' })

  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(() => parseInt(localStorage.getItem('diskovarr_queue_per_page') || '25'))
  const [sortCol, setSortCol] = useState('requested_at')
  const [sortDir, setSortDir] = useState('DESC')

  const [editRequest, setEditRequest] = useState(null)
  const [editService, setEditService] = useState('')
  const [editSeasons, setEditSeasons] = useState([])
  const [editAllSeasons, setEditAllSeasons] = useState(false)
  const [deleteRequestId, setDeleteRequestId] = useState(null)
  const [noConfirmDelete, setNoConfirmDelete] = useState(() => localStorage.getItem('diskovarr_no_confirm_delete') === 'true')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false)
  const [selectedItem, setSelectedItem] = useState(null)
  const [services, setServices] = useState({})

  useEffect(() => {
    exploreApi.getServices()
      .then(({ data }) => setServices(data || {}))
      .catch(() => {})
  }, [])

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const idParam = searchParams.get('id')
  const deepLinkDone = useRef(false)

  const loadQueue = useCallback(async (filter, pageNum) => {
    setLoading(true)
    try {
      const params = {
        status: filter,
        page: pageNum,
        limit: perPage,
        sort: sortCol,
        sortDir,
      }
      if (debouncedSearchQuery) params.search = debouncedSearchQuery
      if (selectedUser) params.userId = selectedUser
      if (dateFrom) params.from = dateFrom
      if (dateTo) params.to = dateTo
      const { data } = await queueApi.getQueue(params)
      setRequests(data.requests || [])
      setTotalPages(data.totalPages || 1)
      setTotal(data.total || 0)
      setPage(pageNum || 1)
    } catch (e) {
      toastError(t('Failed to load queue'))
    } finally {
      setLoading(false)
    }
  }, [perPage, sortCol, sortDir, debouncedSearchQuery, selectedUser, dateFrom, dateTo, toastError, t])

  useEffect(() => {
    ;(async () => {
      setSelectedIds(new Set())
      await loadQueue(currentFilter, 1)
    })()
  }, [currentFilter, debouncedSearchQuery, selectedUser, dateFrom, dateTo, loadQueue])

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const allIds = requests.map(r => r.id)
      const allSelected = allIds.length > 0 && allIds.every(id => prev.has(id))
      if (allSelected) {
        const next = new Set(prev)
        allIds.forEach(id => next.delete(id))
        return next
      }
      const next = new Set(prev)
      allIds.forEach(id => next.add(id))
      return next
    })
  }, [requests])

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return
    setBulkDeleteLoading(true)
    try {
      const ids = Array.from(selectedIds)
      const { data } = await queueApi.bulkDelete(ids)
      toastSuccess(t('Deleted {{n}} request(s)', { n: data.deletedCount ?? ids.length }))
      setSelectedIds(new Set())
      setBulkDeleteConfirm(false)
      loadQueue(currentFilter, page)
    } catch (e) {
      toastError(e.message || t('Bulk delete failed'))
    } finally {
      setBulkDeleteLoading(false)
    }
  }, [selectedIds, currentFilter, page, loadQueue, toastSuccess, toastError, t])

  useEffect(() => {
    if (!isAdmin) return
    queueApi.getUsers()
      .then(({ data }) => setUsers(data.users || []))
      .catch(() => {})
  }, [isAdmin, setUsers])

  const loadPendingCount = useCallback(async () => {
    try {
      const { data } = await queueApi.getQueue({ status: 'pending', page: 1 })
      const el = document.getElementById('pending-count-label')
      if (el) el.textContent = data.total > 0 ? `(${data.total})` : ''
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    loadPendingCount()
    const interval = setInterval(loadPendingCount, 30000)
    return () => clearInterval(interval)
  }, [loadPendingCount])

  const handleFilterChange = useCallback((filter) => {
    setCurrentFilter(filter)
  }, [setCurrentFilter])

  const handleApprove = useCallback(async (id) => {
    try {
      await queueApi.approveRequest(id)
      toastSuccess(t('Request approved and submitted'))
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'approved', displayStatus: 'approved' } : r))
    } catch (e) {
      toastError(e.message || t('Approve failed'))
    }
  }, [toastSuccess, toastError, t])

  const handleDeny = useCallback(async (id) => {
    const note = prompt(t('Denial reason (optional):'))
    if (note === null) return
    try {
      await queueApi.denyRequestWithNote(id, { note })
      toastSuccess(t('Request denied'))
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'denied', displayStatus: 'denied' } : r))
    } catch (e) {
      toastError(e.message || t('Deny failed'))
    }
  }, [toastSuccess, toastError, t])

  const handleDelete = useCallback(async (id) => {
    try {
      await queueApi.deleteRequest(id)
      toastSuccess(t('Request deleted'))
      setRequests(prev => prev.filter(r => r.id !== id))
      setDeleteRequestId(null)
    } catch (e) {
      toastError(e.message || t('Delete failed'))
    }
  }, [toastSuccess, toastError, t])

  const handleEdit = useCallback(async (request) => {
    setEditRequest(request)
    setEditService(request.service || '')
    try {
      const { data } = await searchApi.getSeasons(request.tmdb_id)
      const rawNumbers = data.seasons || []
      let storedSeasons = null
      try { storedSeasons = request.seasons_json ? JSON.parse(request.seasons_json) : null } catch { /* ignore */ }
      const hasSelection = Array.isArray(storedSeasons) && storedSeasons.length > 0
      const selectedSet = hasSelection ? new Set(storedSeasons.map(Number)) : null
      const shaped = rawNumbers.map(n => ({ number: n, selected: selectedSet ? selectedSet.has(n) : false }))
      setEditSeasons(shaped)
      setEditAllSeasons(!hasSelection)
    } catch {
      setEditSeasons([])
      setEditAllSeasons(true)
    }
  }, [])

  useEffect(() => {
    if (!idParam || deepLinkDone.current) return
    queueApi.getRequest(parseInt(idParam))
      .then(({ data }) => {
        if (data) {
          handleEdit(data)
          deepLinkDone.current = true
        }
      })
      .catch(() => {})
  }, [idParam, handleEdit])

  const handleEditSave = useCallback(async () => {
    if (!editRequest) return
    const seasons = editAllSeasons ? null : editSeasons.filter(s => s.selected).map(s => s.number) || null
    try {
      await queueApi.updateRequest(editRequest.id, { service: editService, seasons })
      toastSuccess(t('Request updated'))
      setEditRequest(null)
      loadQueue(currentFilter, page)
    } catch (e) {
      toastError(e.message || t('Save failed'))
    }
  }, [editRequest, editService, editAllSeasons, editSeasons, currentFilter, page, loadQueue, toastSuccess, toastError, t])

  const handleOpenDetail = useCallback(async (request) => {
    try {
      const { data } = await searchApi.getDetails(request.tmdb_id, request.media_type)
      setSelectedItem({
        ...data,
        type: request.media_type === 'tv' ? 'show' : 'movie',
        thumb: data.posterUrl || request.posterUrl,
        art: data.backdropUrl,
        mediaType: request.media_type,
        isRequested: true,
      })
    } catch {
      toastError(t('Failed to load details'))
    }
  }, [toastError, t])

  const handleSort = useCallback((col) => {
    const dbCol = COL_TO_SORT[col] || col
    if (sortCol === dbCol) {
      setSortDir(prev => prev === 'ASC' ? 'DESC' : 'ASC')
    } else {
      setSortCol(dbCol)
      setSortDir('ASC')
    }
  }, [sortCol])

  const handlePageChange = useCallback((delta) => {
    const newPage = page + delta
    if (newPage < 1 || newPage > totalPages) return
    loadQueue(currentFilter, newPage)
  }, [page, totalPages, currentFilter, loadQueue])

  const handlePerPageChange = useCallback((e) => {
    const val = parseInt(e.target.value)
    setPerPage(val)
    localStorage.setItem('diskovarr_queue_per_page', val)
    loadQueue(currentFilter, 1)
  }, [currentFilter, loadQueue])

  const handleUsernameClick = useCallback((userId) => {
    setSelectedUser(prev => prev === userId ? '' : userId)
  }, [setSelectedUser])

  return (
    <main className="main-content queue-page">
      <div className="queue-hero">
        <h1>{isAdmin ? t('Request Queue') : t('My Requests')}</h1>
        <p>{isAdmin ? t('Review and manage media requests from all users.') : t('Your media requests and their status.')}</p>
      </div>

      <div className="list-filter-toolbar">
        <div className="list-search-bar">
          <input
            className="list-search-input"
            type="search"
            placeholder={t('Search by title or user...')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          />
          {searchQuery && (
            <button className="list-search-clear" onClick={() => setSearchQuery('')} type="button">&times;</button>
          )}
        </div>

        {isAdmin && (
          <SearchableDropdown
            options={users}
            value={selectedUser}
            onChange={setSelectedUser}
            placeholder={t('All Users')}
            label={t('User')}
            clearLabel={t('All Users')}
            noResultsLabel={t('No users found')}
          />
        )}

        <DateRangeFilter
          value={{ from: dateFrom, to: dateTo }}
          onChange={setDateRange}
          label={t('Date')}
          placeholder={t('Any date')}
        />

        <div className="queue-filter-row">
          {['all', 'pending', 'requested', 'available', 'approved', 'denied'].map(status => (
            <button
              key={status}
              className={'queue-filter-btn' + (currentFilter === status ? ' active' : '')}
              data-status={status}
              onClick={() => handleFilterChange(status)}
            >
              {status === 'all' ? t('All') : t(STATUS_LABELS[status] || status)}
              {status === 'pending' && <span id="pending-count-label"></span>}
            </button>
          ))}
        </div>

        {hasActiveFilters && (
          <button className="chip-sm chip-sm-clear" onClick={clearAllFilters}>
            {t('Clear Filters')}
          </button>
        )}
      </div>

      {isAdmin && selectedIds.size > 0 && (
        <div className="bulk-action-bar">
          <span className="bulk-action-bar-count">{t('{{n}} selected', { n: selectedIds.size })}</span>
          <span className="bulk-action-bar-spacer" />
          <button type="button" className="btn-bulk-clear" onClick={clearSelection}>{t('Clear')}</button>
          <button type="button" className="btn-bulk-delete" onClick={() => setBulkDeleteConfirm(true)}>{t('Delete selected')}</button>
        </div>
      )}

      {loading ? (
        <div className="queue-loading">{t('Loading requests...')}</div>
      ) : requests.length === 0 ? (
        <div className="queue-empty">
          {hasActiveFilters ? t('No matching requests found. Try adjusting your filters.') : t('No requests found.')}
        </div>
      ) : (
        <div className="table-scroll-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                {isAdmin && (
                  <th className="bulk-col">
                    <input
                      type="checkbox"
                      className="bulk-checkbox"
                      checked={requests.length > 0 && requests.every(r => selectedIds.has(r.id))}
                      ref={el => {
                        if (!el) return
                        const some = requests.some(r => selectedIds.has(r.id))
                        const all = requests.length > 0 && requests.every(r => selectedIds.has(r.id))
                        el.indeterminate = some && !all
                      }}
                      onChange={toggleSelectAll}
                      aria-label={t('Select all on page')}
                    />
                  </th>
                )}
                <th className={'sortable' + (sortCol === 'title' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="title" onClick={() => handleSort('title')}>{t('Title')}</th>
                {isAdmin && <th className={'sortable' + (sortCol === 'username' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="user" onClick={() => handleSort('user')}>{t('User')}</th>}
                <th className={'sortable' + (sortCol === 'media_type' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="type" onClick={() => handleSort('type')}>{t('Type')}</th>
                <th className={'sortable' + (sortCol === 'requested_at' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="age" onClick={() => handleSort('age')}>{t('Age')}</th>
                <th className={'sortable' + (sortCol === 'status' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="status" onClick={() => handleSort('status')}>{t('Status')}</th>
                <th>{t('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => {
                const isPending = r.status === 'pending'
                const ds = r.displayStatus || r.status
                const mediaType = r.media_type === 'movie' ? 'movie' : 'tv'
                const isSelected = selectedUser === r.user_id
                const isChecked = selectedIds.has(r.id)
                return (
                  <tr key={r.id} className={(isPending ? 'pending-row' : '')} id={`req-row-${r.id}`}>
                    {isAdmin && (
                      <td className="bulk-col">
                        <input
                          type="checkbox"
                          className="bulk-checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelect(r.id)}
                          aria-label={`Select request ${r.id}`}
                        />
                      </td>
                    )}
                    <td>
                      <div className="queue-title-cell">
                        {r.posterUrl ? (
                          <img className="queue-poster" src={posterUrl(r.posterUrl)} alt="" loading="lazy" onClick={() => handleOpenDetail(r)} style={{ cursor: 'pointer' }} />
                        ) : (
                          <div className="queue-poster-placeholder" onClick={() => handleOpenDetail(r)} style={{ cursor: 'pointer' }}>?</div>
                        )}
                        <div className="queue-title-info" onClick={() => handleOpenDetail(r)} style={{ cursor: 'pointer' }}>
                          <div className="queue-title">{r.title || t('Untitled')}</div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            {r.year && <span className="queue-year">{r.year}</span>}
                            {r.contentRating && <span className="content-rating-badge">{r.contentRating}</span>}
                          </div>
                          {r.media_type === 'tv' && r.seasons_json && (
                            <div className="season-bubbles">
                              {(() => {
                                try {
                                  const seaNums = JSON.parse(r.seasons_json)
                                  if (Array.isArray(seaNums) && seaNums.length > 0) {
                                    const sorted = [...seaNums].sort((a, b) => a - b)
                                    if (sorted.length > 9) {
                                      return <><span className="season-bubble season-bubble-ellipsis">...</span>{sorted.slice(-8).map(s => <span key={s} className="season-bubble">S{s}</span>)}</>
                                    }
                                    return sorted.map(s => <span key={s} className="season-bubble">S{s}</span>)
                                  }
                                  return <span className="season-bubble season-bubble-all">{t('All Seasons')}</span>
                                } catch {
                                  return <span className="season-bubble season-bubble-all">{t('All Seasons')}</span>
                                }
                              })()}
                            </div>
                          )}
                          {r.denial_note && <div className="deny-note">{r.denial_note}</div>}
                        </div>
                      </div>
                    </td>
                    {isAdmin && <td className="queue-user">
                      {r.user_id && r.user_id.startsWith('__svc_') ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          <span style={{ fontSize: '0.7rem', background: 'var(--accent)', color: '#000', padding: '1px 5px', borderRadius: '4px', fontWeight: '700', letterSpacing: '0.02em' }}>bot</span>
                          <span className={'queue-user-link' + (isSelected ? ' active' : '')} onClick={() => handleUsernameClick(r.user_id)}>{r.username || r.user_id}</span>
                        </span>
                      ) : (
                        <span className={'queue-user-link' + (isSelected ? ' active' : '')} onClick={() => handleUsernameClick(r.user_id)}>{r.username || r.user_id}</span>
                      )}
                    </td>}
                    <td><span className={'type-badge type-' + mediaType}>{mediaType === 'movie' ? t('Movie') : t('TV')}</span></td>
                    <td>{fmtDate(r.requested_at)}</td>
                    <td><span className={'status-badge-' + ds}>{t(STATUS_LABELS[ds] || ds)}</span></td>
                    <td><div className="queue-actions">
                      {isAdmin && isPending && (
                        <>
                          <button className="btn-queue-approve" onClick={() => handleApprove(r.id)}>{t('Approve')}</button>
                          <button className="btn-queue-deny" onClick={() => handleDeny(r.id)}>{t('Deny')}</button>
                        </>
                      )}
                      {isAdmin && (isPending || ds === 'requested') && (
                        <button className="btn-queue-edit" onClick={() => handleEdit(r)}>{t('Edit')}</button>
                      )}
                      {!isAdmin && (isPending || ds === 'requested') && String(user?.id) === String(r.user_id) && (
                        <button className="btn-queue-edit" onClick={() => handleEdit(r)}>{t('Edit')}</button>
                      )}
                      {(isAdmin || (isPending && String(user?.id) === String(r.user_id))) && (
                        <button className="btn-queue-delete" onClick={() => {
                          if (localStorage.getItem('diskovarr_no_confirm_delete') === 'true') {
                            handleDelete(r.id)
                          } else {
                            setDeleteRequestId(r.id)
                          }
                        }}>{t('Delete')}</button>
                      )}
                    </div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="queue-pagination" id="queue-pagination">
          <button className="btn-page" onClick={() => handlePageChange(-1)} disabled={page <= 1}>❮ {t('Prev')}</button>
          <span id="page-info">{totalPages > 1 ? t('Page {{page}} of {{totalPages}} ({{total}} total)', { page, totalPages, total }) : t('{{total}} total', { total })}</span>
          <button className="btn-page" onClick={() => handlePageChange(1)} disabled={page >= totalPages}>{t('Next')} ❯</button>
          <select id="queue-per-page" value={perPage} onChange={handlePerPageChange}>
            <option value="25">{t('{{n}} / page', { n: 25 })}</option>
            <option value="50">{t('{{n}} / page', { n: 50 })}</option>
            <option value="100">{t('{{n}} / page', { n: 100 })}</option>
          </select>
        </div>
      )}

      {selectedItem && (
        <DetailModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}

      <Modal isOpen={!!editRequest} onClose={() => setEditRequest(null)}>
        {editRequest && (
          <div>
            <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: '600' }}>{t('Edit Request')}</h3>
            <div style={{ marginBottom: '14px' }}>
              <label className="edit-field-label">{t('Service')}</label>
              <select className="edit-select" value={editService} onChange={e => setEditService(e.target.value)}>
                <option value="">{t('Default')}</option>
                {services.overseerr && <option value="overseerr">Overseerr</option>}
                {services.riven && <option value="riven">DUMB</option>}
                {/* Radarr only handles movies, Sonarr only handles shows */}
                {editRequest.media_type === 'movie' && services.radarr && <option value="radarr">Radarr</option>}
                {editRequest.media_type === 'tv' && services.sonarr && <option value="sonarr">Sonarr</option>}
              </select>
            </div>
            {editRequest.media_type === 'tv' && editSeasons.length > 0 && (
              <div id="edit-season-section" style={{ marginBottom: '14px' }}>
                <label className="edit-field-label">{t('Seasons')}</label>
                <div>
                  <label style={{ fontSize: '0.82rem', marginBottom: '6px', display: 'block' }}>
                   <input
                       type="checkbox"
                       className="bulk-checkbox"
                       checked={editAllSeasons}
                       onChange={e => {
                        setEditAllSeasons(e.target.checked)
                        setEditSeasons(editSeasons.map(s => ({ ...s, selected: e.target.checked })))
                      }}
                    />{' '}
                    <strong>{t('Select all')}</strong>
                  </label>
                </div>
                <div className="edit-season-list">
                  {editSeasons.map(s => (
                    <label key={s.number} style={{ fontSize: '0.82rem' }}>
                     <input
                         type="checkbox"
                         className="bulk-checkbox"
                         checked={editAllSeasons || (s.selected && !editAllSeasons)}
                        onChange={e => {
                          if (e.target.checked) {
                            setEditSeasons(prev => prev.map(se => se.number === s.number ? { ...se, selected: true } : se))
                          } else {
                            setEditAllSeasons(false)
                            setEditSeasons(prev => prev.map(se => se.number === s.number ? { ...se, selected: false } : se))
                          }
                        }}
                      />{' '}{t('Season')} {s.number}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="edit-modal-actions">
              <button className="edit-modal-cancel" onClick={() => setEditRequest(null)}>{t('Cancel')}</button>
              <button className="edit-modal-save" onClick={handleEditSave}>{t('Save')}</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={bulkDeleteConfirm} onClose={() => setBulkDeleteConfirm(false)}>
        <div style={{ maxWidth: '380px' }}>
          <h3>{t('Delete {{n}} request(s)?', { n: selectedIds.size })}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '8px 0 16px' }}>{t('This cannot be undone.')}</p>
          <div className="edit-modal-actions">
            <button className="edit-modal-cancel" onClick={() => setBulkDeleteConfirm(false)}>{t('Cancel')}</button>
            <button className="edit-modal-save" style={{ background: 'var(--accent-red, #e53e3e)' }} onClick={handleBulkDelete} disabled={bulkDeleteLoading}>
              {bulkDeleteLoading ? t('Deleting...') : t('Delete')}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!deleteRequestId} onClose={() => setDeleteRequestId(null)}>
        <div style={{ maxWidth: '380px' }}>
          <h3>{t('Delete Request')}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '8px 0 16px' }}>{t('Are you sure you want to permanently delete this request?')}</p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
           <input
               type="checkbox"
               className="bulk-checkbox"
               checked={noConfirmDelete}
              onChange={e => {
                setNoConfirmDelete(e.target.checked)
                localStorage.setItem('diskovarr_no_confirm_delete', e.target.checked)
              }}
            />
            {t("Don't ask again")}
          </label>
          <div className="edit-modal-actions">
            <button className="edit-modal-cancel" onClick={() => setDeleteRequestId(null)}>{t('Cancel')}</button>
            <button className="edit-modal-save" style={{ background: 'var(--accent-red, #e53e3e)' }} onClick={() => { if (deleteRequestId) handleDelete(deleteRequestId) }}>{t('Delete')}</button>
          </div>
        </div>
      </Modal>
    </main>
  )
}
