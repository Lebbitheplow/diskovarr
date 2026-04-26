import React, { useState, useCallback, useEffect } from 'react'
import {
  issuesApi,
} from '../services/api'
import Modal from '../components/Modal'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'

const STATUS_LABELS = { open: 'Open', resolved: 'Resolved', closed: 'Closed' }

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

function scopeLabel(issue) {
  if (issue.media_type === 'movie') return 'Movie'
  if (issue.scope === 'episode') return 'S' + (issue.scope_season || '?') + 'E' + (issue.scope_episode || '?')
  if (issue.scope === 'season') return 'Season ' + (issue.scope_season || '?')
  return 'Entire Series'
}

export default function Issues() {
  const { user } = useAuth()
  const { error: toastError, success: toastSuccess } = useToast()

  const isAdmin = !!(user?.isAdmin || user?.isPlexAdminUser || user?.isElevated || user?.isPrivileged)
  const [currentFilter, setCurrentFilter] = useState('all')
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(() => parseInt(localStorage.getItem('diskovarr_issues_per_page') || '25'))
  const [issuesMap, setIssuesMap] = useState({})

  const [selectedIssue, setSelectedIssue] = useState(null)
  const [actionModal, setActionModal] = useState({ open: false, type: null, issueId: null })
  const [actionNote, setActionNote] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [comments, setComments] = useState([])
  const [commentsLoading, setCommentsLoading] = useState(false)

  const [newIssueData, setNewIssueData] = useState({ title: '', description: '', ratingKey: '', mediaType: 'movie', scope: 'series', scopeSeason: '', scopeEpisode: '' })
  const [showNewIssue, setShowNewIssue] = useState(false)
  const [openCount, setOpenCount] = useState(0)
  const [actionModalLoading, setActionModalLoading] = useState(false)
  const [commentSubmitting, setCommentSubmitting] = useState(false)

  const loadIssues = useCallback(async (filter, pageNum) => {
    setLoading(true)
    try {
      const { data } = await issuesApi.getIssues({ status: filter, page: pageNum, limit: perPage })
      setIssues(data.issues || [])
      setTotalPages(data.totalPages || 1)
      setTotal(data.total || 0)
      const map = {}
      ;(data.issues || []).forEach(issue => { map[issue.id] = issue })
      setIssuesMap(map)
      setPage(pageNum || 1)
    } catch (e) {
      toastError('Failed to load issues')
    } finally {
      setLoading(false)
    }
  }, [perPage, toastError])

  useEffect(() => {
    loadIssues(currentFilter, 1)
  }, [currentFilter, loadIssues])

  const loadOpenCount = useCallback(async () => {
    try {
      const { data } = await issuesApi.getIssues({ status: 'open', page: 1, limit: 1 })
      setOpenCount(data.total || 0)
    } catch {}
  }, [])

  useEffect(() => {
    loadOpenCount()
  }, [loadOpenCount])

  useEffect(() => {
    const interval = setInterval(loadOpenCount, 30000)
    return () => clearInterval(interval)
  }, [loadOpenCount])

  const handleFilterChange = useCallback((filter) => {
    setCurrentFilter(filter)
  }, [])

  const handleResolve = useCallback((id) => {
    setActionModal({ open: true, type: 'resolve', issueId: id })
    setActionNote('')
  }, [])

  const handleClose = useCallback((id) => {
    setActionModal({ open: true, type: 'close', issueId: id })
    setActionNote('')
  }, [])

  const handleActionConfirm = useCallback(async () => {
    const { type, issueId } = actionModal
    if (!issueId || !type) return
    setActionModalLoading(true)
    try {
      if (type === 'delete') {
        await issuesApi.deleteIssue(issueId)
        toastSuccess('Issue deleted')
        setIssues(prev => prev.filter(i => i.id !== issueId))
        setIssuesMap(prev => { const next = { ...prev }; delete next[issueId]; return next })
        if (selectedIssue === issueId) setSelectedIssue(null)
      } else if (type === 'resolve') {
        await issuesApi.resolveIssueWithNote(issueId, { note: actionNote.trim() || null })
        toastSuccess('Issue resolved')
        const newStatus = 'resolved'
        setIssues(prev => prev.map(i => i.id === issueId ? { ...i, status: newStatus } : i))
        setIssuesMap(prev => prev[issueId] ? { ...prev, [issueId]: { ...prev[issueId], status: newStatus } } : prev)
      } else {
        await issuesApi.closeIssueWithNote(issueId, { note: actionNote.trim() || null })
        toastSuccess('Issue closed')
        const newStatus = 'closed'
        setIssues(prev => prev.map(i => i.id === issueId ? { ...i, status: newStatus } : i))
        setIssuesMap(prev => prev[issueId] ? { ...prev, [issueId]: { ...prev[issueId], status: newStatus } } : prev)
      }
    } catch (e) {
      toastError(e.message || 'Action failed')
    }
    setActionModalLoading(false)
    setActionModal({ open: false, type: null, issueId: null })
  }, [actionModal, actionNote, selectedIssue, toastSuccess, toastError])

  const handleDeleteIssue = useCallback((id) => {
    setActionModal({ open: true, type: 'delete', issueId: id })
    setActionNote('')
  }, [])

  const handleViewDetails = useCallback(async (id) => {
    setSelectedIssue(id)
    setCommentsLoading(true)
    try {
      const { data } = await issuesApi.getIssueComments(id)
      setComments(data.comments || [])
    } catch {
      setComments([])
    } finally {
      setCommentsLoading(false)
    }
  }, [])

  const handleCommentSubmit = useCallback(async () => {
    if (!selectedIssue || !commentInput.trim()) return
    if (commentInput.length > 1000) {
      toastError('Comment too long (max 1000 chars)')
      return
    }
    setCommentSubmitting(true)
    try {
      await issuesApi.addComment(selectedIssue, commentInput.trim())
      setCommentInput('')
      const { data } = await issuesApi.getIssueComments(selectedIssue)
      setComments(data.comments || [])
    } catch (e) {
      toastError(e.message || 'Comment failed')
    }
    setCommentSubmitting(false)
  }, [selectedIssue, commentInput, toastError])

  const handleDeleteComment = useCallback(async (commentId) => {
    try {
      await issuesApi.deleteComment(selectedIssue, commentId)
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch (e) {
      toastError(e.message || 'Delete comment failed')
    }
  }, [selectedIssue, toastError])

  const handleCreateIssue = useCallback(async () => {
    if (!newIssueData.title.trim()) {
      toastError('Title is required')
      return
    }
    try {
      await issuesApi.createIssue(newIssueData)
      toastSuccess('Issue created')
      setShowNewIssue(false)
      setNewIssueData({ title: '', description: '', ratingKey: '', mediaType: 'movie', scope: 'series', scopeSeason: '', scopeEpisode: '' })
      loadIssues(currentFilter, page)
    } catch (e) {
      toastError(e.message || 'Create issue failed')
    }
  }, [newIssueData, currentFilter, page, loadIssues, toastSuccess, toastError])

  const handlePageChange = useCallback((delta) => {
    const newPage = page + delta
    if (newPage < 1 || newPage > totalPages) return
    loadIssues(currentFilter, newPage)
  }, [page, totalPages, currentFilter, loadIssues])

  const handlePerPageChange = useCallback((e) => {
    const val = parseInt(e.target.value)
    setPerPage(val)
    localStorage.setItem('diskovarr_issues_per_page', val)
    loadIssues(currentFilter, 1)
  }, [currentFilter, loadIssues])

  return (
    <main className="main-content queue-page">
      <div className="queue-hero">
        <h1>{isAdmin ? 'Issue Reports' : 'My Issues'}</h1>
        <p>{isAdmin ? 'Review and manage reported issues from all users.' : 'Issues you have reported about library items.'}</p>
      </div>

      <div className="queue-filter-row">
        {['all', 'open', 'resolved', 'closed'].map(status => (
          <button
            key={status}
            className={'queue-filter-btn' + (currentFilter === status ? ' active' : '')}
            data-status={status}
            onClick={() => handleFilterChange(status)}
          >
            {status === 'all' ? 'All' : STATUS_LABELS[status]}
            {status === 'open' && openCount > 0 && <span id="open-count-label">({openCount})</span>}
          </button>
        ))}
      </div>

      <button className="chip-sm" onClick={() => setShowNewIssue(!showNewIssue)} style={{ marginBottom: '16px', padding: '6px 16px' }}>
        {showNewIssue ? 'Hide New Issue Form' : '+ New Issue'}
      </button>

      {showNewIssue && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px', marginBottom: '20px' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: '600' }}>New Issue Report</h3>
          <div style={{ marginBottom: '14px' }}>
            <label className="edit-field-label">Title</label>
            <input className="filter-select" value={newIssueData.title} onChange={e => setNewIssueData(prev => ({ ...prev, title: e.target.value }))} style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem', boxSizing: 'border-box' }} placeholder="Issue title" />
          </div>
          <div style={{ marginBottom: '14px' }}>
            <label className="edit-field-label">Plex Rating Key <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>(optional)</span></label>
            <input className="filter-select" value={newIssueData.ratingKey} onChange={e => setNewIssueData(prev => ({ ...prev, ratingKey: e.target.value }))} style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem', boxSizing: 'border-box' }} placeholder="Plex ratingKey (leave blank if unknown)" />
          </div>
          <div style={{ marginBottom: '14px' }}>
            <label className="edit-field-label">Media Type</label>
            <select className="edit-select" value={newIssueData.mediaType} onChange={e => setNewIssueData(prev => ({ ...prev, mediaType: e.target.value, scope: e.target.value === 'movie' ? 'movie' : 'series' }))}>
              <option value="movie">Movie</option>
              <option value="tv">TV / Series</option>
            </select>
          </div>
          {newIssueData.mediaType !== 'movie' && (
            <div style={{ marginBottom: '14px' }}>
              <label className="edit-field-label">Scope</label>
              <select className="edit-select" value={newIssueData.scope} onChange={e => setNewIssueData(prev => ({ ...prev, scope: e.target.value }))}>
                <option value="series">Entire Series</option>
                <option value="season">Specific Season</option>
                <option value="episode">Specific Episode</option>
              </select>
            </div>
          )}
          {newIssueData.mediaType !== 'movie' && (newIssueData.scope === 'season' || newIssueData.scope === 'episode') && (
            <div style={{ marginBottom: '14px' }}>
              <label className="edit-field-label">Season Number</label>
              <input type="number" min="1" className="filter-select" value={newIssueData.scopeSeason} onChange={e => setNewIssueData(prev => ({ ...prev, scopeSeason: e.target.value }))} style={{ width: '100px', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem' }} placeholder="e.g. 2" />
            </div>
          )}
          {newIssueData.mediaType !== 'movie' && newIssueData.scope === 'episode' && (
            <div style={{ marginBottom: '14px' }}>
              <label className="edit-field-label">Episode Number</label>
              <input type="number" min="1" className="filter-select" value={newIssueData.scopeEpisode} onChange={e => setNewIssueData(prev => ({ ...prev, scopeEpisode: e.target.value }))} style={{ width: '100px', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem' }} placeholder="e.g. 5" />
            </div>
          )}
          <div style={{ marginBottom: '14px' }}>
            <label className="edit-field-label">Description</label>
            <textarea className="filter-select" value={newIssueData.description} onChange={e => setNewIssueData(prev => ({ ...prev, description: e.target.value }))} style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem', minHeight: '80px', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} placeholder="Describe the issue..." />
          </div>
          <div className="edit-modal-actions">
            <button className="edit-modal-cancel" onClick={() => setShowNewIssue(false)}>Cancel</button>
            <button className="edit-modal-save" onClick={handleCreateIssue}>Submit</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="queue-loading">Loading issues...</div>
      ) : issues.length === 0 ? (
        <div className="queue-empty">No issues found.</div>
      ) : (
        <div className="table-scroll-wrap">
          <table className="queue-table">
            <thead>
              <tr>
                <th>Title</th>
                {isAdmin && <th>Reporter</th>}
                <th>Scope</th>
                <th>Date</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {issues.map(issue => (
                <tr key={issue.id} id={`issue-row-${issue.id}`}>
                  <td>
                    <div className="queue-title-cell">
                      {issue.poster_path ? (
                        <img className="queue-poster" src={`/api/poster?path=${encodeURIComponent(issue.poster_path)}`} alt="" loading="lazy" />
                      ) : (
                        <div className="queue-poster-placeholder">?</div>
                      )}
                      <div className="queue-title-info">
                        <div className="queue-title">{issue.title}</div>
                        {issue.description && <div className="issue-description" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '2px', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.description}</div>}
                        {issue.admin_note && <div className="admin-note">Note: {issue.admin_note}</div>}
                      </div>
                    </div>
                  </td>
                  {isAdmin && <td className="queue-user">{issue.username || issue.user_id}</td>}
                  <td><span className="scope-badge">{scopeLabel(issue)}</span></td>
                  <td>{fmtDate(issue.created_at)}</td>
                  <td><span className={'status-badge-' + issue.status}>{STATUS_LABELS[issue.status] || issue.status}</span></td>
                  <td><div className="queue-actions">
                    <button className="btn-page" onClick={() => handleViewDetails(issue.id)} style={{ fontSize: '0.82rem', padding: '4px 10px' }}>
                      Details{issue._commentCount > 0 && <span className="comment-count-badge">{issue._commentCount}</span>}
                    </button>
                    {isAdmin && issue.status === 'open' && (
                      <>
                        <button className="btn-queue-approve" onClick={() => handleResolve(issue.id)}>Resolve</button>
                        <button className="btn-queue-deny" onClick={() => handleClose(issue.id)}>Close</button>
                      </>
                    )}
                    {isAdmin && <button className="btn-queue-delete" onClick={() => handleDeleteIssue(issue.id)}>Delete</button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="queue-pagination" id="issues-pagination">
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

      <Modal isOpen={actionModal.open} onClose={() => setActionModal({ open: false, type: null, issueId: null })}>
        <div>
          <h3>
            {actionModal.type === 'resolve' ? 'Resolve Issue' : actionModal.type === 'close' ? 'Close Issue' : 'Delete Issue'}
          </h3>
          <div style={{ marginBottom: '14px' }}>
            <label className="edit-field-label">{actionModal.type === 'delete' ? 'Optional note (not saved)' : 'Optional note for the reporter'}</label>
            <textarea
              id="action-modal-note"
              className="note-textarea"
              placeholder={actionModal.type === 'delete' ? 'Optional note (not saved)' : 'Explain what was done or found...'}
              value={actionNote}
              onChange={e => setActionNote(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem', resize: 'vertical', minHeight: '80px', fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </div>
          <div className="edit-modal-actions">
            <button className="edit-modal-cancel" onClick={() => setActionModal({ open: false, type: null, issueId: null })}>Cancel</button>
            <button
              className={actionModal.type === 'resolve' ? 'btn-queue-approve' : actionModal.type === 'close' ? 'btn-queue-deny' : 'btn-queue-delete'}
              onClick={handleActionConfirm}
              disabled={actionModalLoading}
            >Confirm</button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!selectedIssue} onClose={() => setSelectedIssue(null)}>
        {selectedIssue && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ margin: '0', fontSize: '1rem', fontWeight: '600', flex: 1, paddingRight: '12px' }}>
                {issuesMap[selectedIssue]?.title || 'Issue Details'}
              </h3>
              <button className="btn-queue-delete" onClick={() => setSelectedIssue(null)}>✕</button>
            </div>
            {(() => {
              const issue = issuesMap[selectedIssue]
              if (!issue) return null
              return (
                <>
                  {isAdmin && (
                    <div className="details-row">
                      <div className="details-label">Reporter</div>
                      <div className="details-value">{issue.username || issue.user_id}</div>
                    </div>
                  )}
                  <div className="details-row">
                    <div className="details-label">Scope</div>
                    <div className="details-value">
                      <span className="scope-badge">{scopeLabel(issue)}</span>
                      {issue.media_type !== 'movie' && issue.scope_season && (
                        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                          {issue.scope === 'season' ? ` Season ${issue.scope_season}` : ` Season ${issue.scope_season || '?'}, Episode ${issue.scope_episode || '?'}`}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="details-row">
                    <div className="details-label">Status</div>
                    <div className="details-value"><span className={'status-badge-' + issue.status}>{STATUS_LABELS[issue.status] || issue.status}</span></div>
                  </div>
                  <div className="details-row">
                    <div className="details-label">Reported</div>
                    <div className="details-value">{fmtDate(issue.created_at)}</div>
                  </div>
                  <div className="details-row">
                    <div className="details-label">Description</div>
                    <div className="details-description">{issue.description || <span style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No description provided.</span>}</div>
                  </div>
                  {issue.admin_note && (
                    <div className="details-row" style={{ marginTop: '4px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                      <div className="details-label">Admin Note</div>
                      <div className="details-description">{issue.admin_note}</div>
                    </div>
                  )}
                  <div className="comments-section" style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--border)' }}>
                    <div className="details-label" style={{ marginBottom: '10px' }}>Comments</div>
                    {commentsLoading ? (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>Loading...</div>
                    ) : comments.length === 0 ? (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', fontStyle: 'italic' }}>No comments yet.</div>
                    ) : (
                      <div className="comments-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '12px' }}>
                        {comments.map(c => (
                          <div key={c.id} className="comment-item" style={{ background: 'var(--bg-elevated)', borderRadius: '7px', padding: '10px 12px', fontSize: '0.85rem', border: '1px solid var(--border)' }}>
                            <div className="comment-header" style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '5px', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                              <span className="comment-author" style={{ fontWeight: '600', color: 'var(--text-primary)' }}>{c.display_name || c.user_id}</span>
                              {c.is_admin && <span className="admin-badge" style={{ display: 'inline-block', padding: '1px 5px', borderRadius: '4px', fontSize: '0.68rem', fontWeight: '700', background: 'rgba(229,160,13,0.15)', color: '#e5a00d', letterSpacing: '0.04em' }}>Admin</span>}
                              <span>{fmtDate(c.created_at)}</span>
                              {isAdmin && <button className="comment-delete" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: '0.8rem', cursor: 'pointer', padding: '1px 5px', borderRadius: '4px' }} onClick={() => handleDeleteComment(c.id)} title="Delete">×</button>}
                            </div>
                            <div className="comment-text" style={{ whiteSpace: 'pre-wrap', lineHeight: '1.5', color: 'var(--text)' }}>{c.comment}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="comment-input-row" style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                      <textarea
                        className="comment-textarea"
                        placeholder="Add a comment..."
                        rows="2"
                        value={commentInput}
                        onChange={e => setCommentInput(e.target.value)}
                        disabled={commentSubmitting}
                        style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.85rem', resize: 'vertical', minHeight: '60px', fontFamily: 'inherit', boxSizing: 'border-box' }}
                      />
                      <button className="comment-submit-btn" style={{ alignSelf: 'flex-end', padding: '5px 14px', borderRadius: '6px', border: 'none', background: 'rgba(0,180,216,0.18)', color: '#00b4d8', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer', opacity: commentSubmitting ? 0.6 : 1 }} onClick={handleCommentSubmit} disabled={commentSubmitting}>
                        Add Comment
                      </button>
                    </div>
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </Modal>
    </main>
  )
}
