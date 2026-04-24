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
  const d = new Date(ts * 1000)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
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

  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  const [currentFilter, setCurrentFilter] = useState('all')
  const [issues, setIssues] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [perPage, setPerPage] = useState(25)
  const [issuesMap, setIssuesMap] = useState({})

  const [selectedIssue, setSelectedIssue] = useState(null)
  const [actionModal, setActionModal] = useState({ open: false, type: null, issueId: null })
  const [actionNote, setActionNote] = useState('')
  const [commentInput, setCommentInput] = useState('')
  const [comments, setComments] = useState([])
  const [commentsLoading, setCommentsLoading] = useState(false)

  const [newIssueData, setNewIssueData] = useState({ title: '', description: '', ratingKey: '', mediaType: 'movie', scope: 'series' })
  const [showNewIssue, setShowNewIssue] = useState(false)

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
    try {
      if (type === 'resolve') {
        await issuesApi.resolveIssueWithNote(issueId, { note: actionNote.trim() || null })
      } else {
        await issuesApi.closeIssueWithNote(issueId, { note: actionNote.trim() || null })
      }
      toastSuccess('Issue ' + type + 'd')
      setActionModal({ open: false, type: null, issueId: null })
      setIssues(prev => prev.filter(i => i.id !== issueId))
    } catch (e) {
      toastError(e.message || 'Action failed')
    }
  }, [actionModal, actionNote, toastSuccess, toastError])

  const handleDeleteIssue = useCallback(async (id) => {
    if (!confirm('Delete this issue?')) return
    try {
      await issuesApi.deleteIssue(id)
      toastSuccess('Issue deleted')
      setIssues(prev => prev.filter(i => i.id !== id))
    } catch (e) {
      toastError(e.message || 'Delete failed')
    }
  }, [toastSuccess, toastError])

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
    try {
      await issuesApi.addComment(selectedIssue, commentInput.trim())
      setCommentInput('')
      const { data } = await issuesApi.getIssueComments(selectedIssue)
      setComments(data.comments || [])
    } catch (e) {
      toastError(e.message || 'Comment failed')
    }
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
      setNewIssueData({ title: '', description: '', ratingKey: '', mediaType: 'movie', scope: 'series' })
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
    setPerPage(parseInt(e.target.value))
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
            {status === 'open' && <span id="open-count-label"></span>}
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
            <input className="filter-select" value={newIssueData.title} onChange={e => setNewIssueData(prev => ({ ...prev, title: e.target.value }))} style={{ width: '100%', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem' }} placeholder="Issue title" />
          </div>
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
                        {issue.description && <div className="issue-description">{issue.description}</div>}
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
          <h3 id="action-modal-title">
            {actionModal.type === 'resolve' ? 'Resolve Issue' : actionModal.type === 'close' ? 'Close Issue' : 'Delete Issue'}
          </h3>
          <div style={{ marginBottom: '14px' }}>
            <label className="edit-field-label">Optional note for the reporter</label>
            <textarea
              id="action-modal-note"
              className="note-textarea"
              placeholder="Explain what was done or found..."
              value={actionNote}
              onChange={e => setActionNote(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.88rem', resize: 'vertical', minHeight: '80px', fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </div>
          <div className="edit-modal-actions">
            <button className="btn-queue-delete" onClick={() => setActionModal({ open: false, type: null, issueId: null })}>Cancel</button>
            <button className="btn-queue-approve" onClick={handleActionConfirm}>Confirm</button>
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
                  <div className="details-row">
                    <div className="details-label">Scope</div>
                    <div className="details-value">
                      <span className="scope-badge">{scopeLabel(issue)}</span>
                      {issue.media_type !== 'movie' && issue.scope_season && (
                        <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                          {issue.scope === 'season' ? `Season ${issue.scope_season}` : `Season ${issue.scope_season || '?'}, Episode ${issue.scope_episode || '?'}`}
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
                        style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: '0.85rem', resize: 'vertical', minHeight: '60px', fontFamily: 'inherit', boxSizing: 'border-box' }}
                      />
                      <button className="comment-submit-btn" style={{ alignSelf: 'flex-end', padding: '5px 14px', borderRadius: '6px', border: 'none', background: 'rgba(0,180,216,0.18)', color: '#00b4d8', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer' }} onClick={handleCommentSubmit}>
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
