import React, { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  queueApi,
  searchApi,
  adminApi,
} from '../services/api'
import Modal from '../components/Modal'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'

function posterUrl(path) {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return '/api/poster?path=' + encodeURIComponent(path)
}

const STATUS_LABELS = {
  pending: 'Pending Approval',
  requested: 'Requested',
  available: 'Available',
  denied: 'Denied',
}

function fmtDate(ts) {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 3600) {
    const m = Math.max(1, Math.floor(diff / 60))
    return m + ' min' + (m === 1 ? '' : 's') + ' ago'
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    return h + ' hour' + (h === 1 ? '' : 's') + ' ago'
  }
  const d = Math.floor(diff / 86400)
  return d + ' day' + (d === 1 ? '' : 's') + ' ago'
}

export default function Queue() {
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const { error: toastError, success: toastSuccess } = useToast()

  const initialFilter = searchParams.get('filter') || 'all'
  const [currentFilter, setCurrentFilter] = useState(initialFilter)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(() => parseInt(localStorage.getItem('diskovarr_queue_per_page') || '25'))
  const [sortCol, setSortCol] = useState('requested_at')
  const [sortDir, setSortDir] = useState('DESC')

  const isAdmin = !!(user?.isAdmin || user?.isElevated)

  const [editRequest, setEditRequest] = useState(null)
  const [editService, setEditService] = useState('')
  const [editSeasons, setEditSeasons] = useState([])
  const [editAllSeasons, setEditAllSeasons] = useState(false)
  const [deleteRequestId, setDeleteRequestId] = useState(null)

  const loadQueue = useCallback(async (filter, pageNum) => {
    setLoading(true)
    try {
      const { data } = await queueApi.getQueue({
        status: filter,
        page: pageNum,
        limit: perPage,
        sort: sortCol,
        sortDir,
      })
      setRequests(data.requests || [])
      setTotalPages(data.totalPages || 1)
      setTotal(data.total || 0)
      setPage(pageNum || 1)
    } catch (e) {
      toastError('Failed to load queue')
    } finally {
      setLoading(false)
    }
  }, [perPage, sortCol, sortDir, toastError])

  useEffect(() => {
    loadQueue(currentFilter, 1)
  }, [currentFilter, loadQueue])

  const handleFilterChange = useCallback((filter) => {
    setCurrentFilter(filter)
  }, [])

  const handleApprove = useCallback(async (id) => {
    try {
      await queueApi.approveRequest(id)
      toastSuccess('Request approved and submitted')
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'requested', displayStatus: 'requested' } : r))
    } catch (e) {
      toastError(e.message || 'Approve failed')
    }
  }, [toastSuccess, toastError])

  const handleDeny = useCallback(async (id) => {
    const note = prompt('Denial reason (optional):')
    if (note === null) return
    try {
      await queueApi.denyRequestWithNote(id, { note })
      toastSuccess('Request denied')
      setRequests(prev => prev.map(r => r.id === id ? { ...r, status: 'denied', displayStatus: 'denied' } : r))
    } catch (e) {
      toastError(e.message || 'Deny failed')
    }
  }, [toastSuccess, toastError])

  const handleDelete = useCallback(async (id) => {
    try {
      await queueApi.deleteRequest(id)
      toastSuccess('Request deleted')
      setRequests(prev => prev.filter(r => r.id !== id))
    } catch (e) {
      toastError(e.message || 'Delete failed')
    }
  }, [toastSuccess, toastError])

  const handleEdit = useCallback(async (request) => {
    setEditRequest(request)
    setEditService(request.service || '')
    try {
      const { data } = await searchApi.getSeasons(request.tmdb_id)
      setEditSeasons(data.seasons || [])
      const storedSeasons = request.seasons_json ? JSON.parse(request.seasons_json) : null
      if (storedSeasons && Array.isArray(storedSeasons) && storedSeasons.length > 0) {
        setEditAllSeasons(false)
      } else {
        setEditAllSeasons(true)
      }
    } catch {
      setEditSeasons([])
      setEditAllSeasons(true)
    }
  }, [])

  const handleEditSave = useCallback(async () => {
    if (!editRequest) return
    const seasons = editAllSeasons ? null : editSeasons.filter(s => s.selected).map(s => s.number) || null
    try {
      await queueApi.updateRequest(editRequest.id, { service: editService, seasons })
      toastSuccess('Request updated')
      setEditRequest(null)
      loadQueue(currentFilter, page)
    } catch (e) {
      toastError(e.message || 'Save failed')
    }
  }, [editRequest, editService, editAllSeasons, editSeasons, currentFilter, page, loadQueue, toastSuccess, toastError])

  const handleSort = useCallback((col) => {
    if (sortCol === col) {
      setSortDir(prev => prev === 'ASC' ? 'DESC' : 'ASC')
    } else {
      setSortCol(col)
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

  const COL_TO_SORT = { title: 'title', user: 'username', type: 'media_type', age: 'requested_at', status: 'status' }

  return (
    <main className="main-content queue-page">
      <div className="queue-hero">
        <h1>{isAdmin ? 'Request Queue' : 'My Requests'}</h1>
        <p>{isAdmin ? 'Review and manage media requests from all users.' : 'Your media requests and their status.'}</p>
      </div>

      <div className="queue-filter-row">
        {['all', 'pending', 'requested', 'available', 'approved', 'denied'].map(status => (
          <button
            key={status}
            className={'queue-filter-btn' + (currentFilter === status ? ' active' : '')}
            data-status={status}
            onClick={() => handleFilterChange(status)}
          >
            {status === 'all' ? 'All' : STATUS_LABELS[status] || status}
            {status === 'pending' && <span id="pending-count-label"></span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="queue-loading">Loading requests...</div>
      ) : requests.length === 0 ? (
        <div className="queue-empty">No requests found.</div>
      ) : (
        <div className="table-scroll-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <th className={'sortable' + (sortCol === 'title' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="title" onClick={() => handleSort('title')}>Title</th>
                {isAdmin && <th className={'sortable' + (sortCol === 'user' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="user" onClick={() => handleSort('user')}>User</th>}
                <th className={'sortable' + (sortCol === 'type' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="type" onClick={() => handleSort('type')}>Type</th>
                <th className={'sortable' + (sortCol === 'age' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="age" onClick={() => handleSort('age')}>Age</th>
                <th className={'sortable' + (sortCol === 'status' ? ' ' + (sortDir === 'ASC' ? 'sort-asc' : 'sort-desc') : '')} data-col="status" onClick={() => handleSort('status')}>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => {
                const isPending = r.status === 'pending'
                const ds = r.displayStatus || r.status
                const mediaType = r.media_type === 'movie' ? 'movie' : 'tv'
                return (
                  <tr key={r.id} className={(isPending ? 'pending-row' : '')} id={`req-row-${r.id}`} data-sort_title={(r.title || '').toLowerCase()} data-sort_user={(r.username || '').toLowerCase()} data-sort_type={mediaType} data-sort_age={r.requested_at || 0} data-sort_status={(r.displayStatus || r.status || '').toLowerCase()}>
                    <td>
                      <div className="queue-title-cell">
                        {r.posterUrl ? (
                          <img className="queue-poster" src={posterUrl(r.posterUrl)} alt="" loading="lazy" />
                        ) : (
                          <div className="queue-poster-placeholder">?</div>
                        )}
                        <div className="queue-title-info">
                          <div className="queue-title">{r.title || 'Untitled'}</div>
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
                                  return <span className="season-bubble season-bubble-all">All Seasons</span>
                                } catch {
                                  return <span className="season-bubble season-bubble-all">All Seasons</span>
                                }
                              })()}
                            </div>
                          )}
                          {r.denial_note && <div className="deny-note">{r.denial_note}</div>}
                        </div>
                      </div>
                    </td>
                    {isAdmin && <td className="queue-user">{r.username || r.user_id}</td>}
                    <td><span className={'type-badge type-' + mediaType}>{mediaType === 'movie' ? 'Movie' : 'TV'}</span></td>
                    <td>{fmtDate(r.requested_at)}</td>
                    <td><span className={'status-badge-' + ds}>{STATUS_LABELS[ds] || ds}</span></td>
                    <td><div className="queue-actions">
                      {isAdmin && isPending && (
                        <>
                          <button className="btn-queue-approve" onClick={() => handleApprove(r.id)}>Approve</button>
                          <button className="btn-queue-deny" onClick={() => handleDeny(r.id)}>Deny</button>
                          <button className="btn-queue-edit" onClick={() => handleEdit(r)}>Edit</button>
                        </>
                      )}
                      {!isAdmin && isPending && (
                        <>
                          <button className="btn-queue-edit" onClick={() => handleEdit(r)}>Edit</button>
                        </>
                      )}
                      <button className="btn-queue-delete" onClick={() => setDeleteRequestId(r.id)}>Delete</button>
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
          <button className="btn-page" onClick={() => handlePageChange(-1)} disabled={page <= 1}>❮ Prev</button>
          <span id="page-info">{totalPages > 1 ? `Page ${page} of ${totalPages} (${total} total)` : `${total} total`}</span>
          <button className="btn-page" onClick={() => handlePageChange(1)} disabled={page >= totalPages}>Next ❯</button>
          <select id="queue-per-page" value={perPage} onChange={handlePerPageChange}>
            <option value="25">25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>
        </div>
      )}

      <Modal isOpen={!!editRequest} onClose={() => setEditRequest(null)}>
        {editRequest && (
          <div>
            <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: '600' }}>Edit Request</h3>
            <div style={{ marginBottom: '14px' }}>
              <label className="edit-field-label">Service</label>
              <select className="edit-select" value={editService} onChange={e => setEditService(e.target.value)}>
                <option value="">Default</option>
                <option value="overseerr">Overseerr</option>
                <option value="radarr">Radarr</option>
                <option value="sonarr">Sonarr</option>
              </select>
            </div>
            {editRequest.media_type === 'tv' && editSeasons.length > 0 && (
              <div id="edit-season-section" style={{ marginBottom: '14px' }}>
                <label className="edit-field-label">Seasons</label>
                <div>
                  <label style={{ fontSize: '0.82rem', marginBottom: '6px', display: 'block' }}>
                    <input
                      type="checkbox"
                      checked={editAllSeasons}
                      onChange={e => { setEditAllSeasons(e.target.checked); setEditSeasons(editSeasons.map(s => ({ ...s, selected: e.target.checked }))) }}
                    />{' '}
                    <strong>Select all</strong>
                  </label>
                </div>
                <div className="edit-season-list">
                  {editSeasons.map(s => (
                    <label key={s} style={{ fontSize: '0.82rem' }}>
                      <input
                        type="checkbox"
                        checked={editAllSeasons || (s.selected && !editAllSeasons)}
                        onChange={e => {
                          if (e.target.checked) {
                            setEditSeasons(prev => prev.map(se => se.number === s ? { ...se, selected: true } : se))
                          } else {
                            setEditSeasons(prev => prev.map(se => se.number === s ? { ...se, selected: false } : se))
                          }
                        }}
                      />{' '}Season {s}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="edit-modal-actions">
              <button className="edit-modal-cancel" onClick={() => setEditRequest(null)}>Cancel</button>
              <button className="edit-modal-save" onClick={handleEditSave}>Save</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={!!deleteRequestId} onClose={() => setDeleteRequestId(null)}>
        <div style={{ maxWidth: '380px' }}>
          <h3>Delete Request</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '8px 0 16px' }}>Are you sure you want to permanently delete this request?</p>
          <div className="edit-modal-actions">
            <button className="edit-modal-cancel" onClick={() => setDeleteRequestId(null)}>Cancel</button>
            <button className="edit-modal-save" style={{ background: 'var(--accent-red, #e53e3e)' }} onClick={() => { if (deleteRequestId) handleDelete(deleteRequestId) }}>Delete</button>
          </div>
        </div>
      </Modal>
    </main>
  )
}
