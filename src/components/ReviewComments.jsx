import React, { useState, useCallback, useEffect } from 'react'
import { socialReviewsApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { posterUrl } from '../utils/media'

function fmtTime(ts) {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) { const m = Math.floor(diff / 60); return m + 'm ago' }
  if (diff < 86400) { const h = Math.floor(diff / 3600); return h + 'h ago' }
  if (diff < 604800) { const d = Math.floor(diff / 86400); return d + 'd ago' }
  return new Date(ts * 1000).toLocaleDateString()
}

function Avatar({ src, name, size = '28px' }) {
  if (src) {
    return <img src={posterUrl(src)} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--accent-dim2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: '600', color: 'var(--accent)', flexShrink: 0 }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}

function CommentItem({ comment, onDelete, onEdit }) {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(comment.body)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    if (!editBody.trim()) return
    setSaving(true)
    try {
      await socialReviewsApi.updateComment(comment.id, { body: editBody.trim() })
      onEdit(comment.id, editBody.trim())
      setEditing(false)
    } catch (e) {
      console.error('Failed to update comment', e)
    } finally {
      setSaving(false)
    }
  }, [comment.id, editBody, onEdit])

  if (editing) {
    return (
      <div className="review-comment" style={{ padding: '8px 0' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
          <Avatar src={comment.userAvatar} name={comment.username} />
          <div style={{ flex: 1 }}>
            <textarea
              value={editBody}
              onChange={e => setEditBody(e.target.value)}
              maxLength={1000}
              rows={3}
              style={{
                width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: '6px', padding: '8px', color: 'var(--text-primary)', fontSize: '0.88rem',
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
              }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
              <button className="btn-page" onClick={handleSave} disabled={saving} style={{ fontSize: '0.78rem', padding: '3px 10px' }}>
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button className="btn-page" onClick={() => { setEditing(false); setEditBody(comment.body) }} style={{ fontSize: '0.78rem', padding: '3px 10px' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="review-comment" style={{ padding: '8px 0' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        <Avatar src={comment.userAvatar} name={comment.username} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: '600', fontSize: '0.85rem', color: 'var(--text-primary)' }}>{comment.username}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{fmtTime(comment.createdAt)}</span>
            {comment.isOwn && (
              <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
                <button
                  className="btn-page"
                  onClick={() => setEditing(true)}
                  style={{ fontSize: '0.7rem', padding: '2px 6px', opacity: 0.6 }}
                >
                  Edit
                </button>
                <button
                  className="btn-page"
                  onClick={() => onDelete(comment.id)}
                  style={{ fontSize: '0.7rem', padding: '2px 6px', opacity: 0.6, color: '#f87171' }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          <p style={{ margin: '4px 0 0', fontSize: '0.88rem', lineHeight: '1.5', color: 'var(--text-primary)' }}>
            {comment.body}
          </p>
        </div>
      </div>
    </div>
  )
}

export default function ReviewComments({ reviewId, onCommentCountChange }) {
  const { user } = useAuth()
  const { success, error: toastError } = useToast()
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [newBody, setNewBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [replyBody, setReplyBody] = useState('')

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data } = await socialReviewsApi.getComments(reviewId)
        if (active) setComments(data.comments || [])
      } catch (e) {
        console.error('Failed to load comments', e)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [reviewId])

  const handleAddComment = useCallback(async () => {
    if (!newBody.trim()) return
    setSubmitting(true)
    try {
      const { data } = await socialReviewsApi.createComment(reviewId, { body: newBody.trim() })
      setComments(prev => [...prev, data])
      setNewBody('')
      onCommentCountChange(1)
      success('Comment added')
    } catch (e) {
      toastError(e?.message || 'Failed to add comment')
    } finally {
      setSubmitting(false)
    }
  }, [reviewId, newBody, onCommentCountChange, success, toastError])

  const handleReply = useCallback(async (parentId) => {
    if (!replyBody.trim()) return
    setSubmitting(true)
    try {
      const { data } = await socialReviewsApi.createComment(reviewId, { body: replyBody.trim(), parentId })
      setComments(prev => [...prev, data])
      setReplyBody('')
      setReplyTo(null)
      onCommentCountChange(1)
      success('Reply added')
    } catch (e) {
      toastError(e?.message || 'Failed to add reply')
    } finally {
      setSubmitting(false)
    }
  }, [reviewId, replyBody, onCommentCountChange, success, toastError])

  const handleDelete = useCallback(async (commentId) => {
    try {
      await socialReviewsApi.deleteComment(commentId)
      // Deleting a parent also cascade-removes its replies (server + local state),
      // so decrement the count by everything actually removed, not just 1.
      const removed = comments.filter(c => c.id === commentId || c.parentId === commentId).length
      setComments(prev => prev.filter(c => c.id !== commentId && c.parentId !== commentId))
      if (removed > 0) onCommentCountChange(-removed)
      success('Comment deleted')
    } catch (e) {
      toastError(e?.message || 'Failed to delete comment')
    }
  }, [comments, onCommentCountChange, success, toastError])

  const handleEdit = useCallback((commentId, newBody) => {
    setComments(prev => prev.map(c => c.id === commentId ? { ...c, body: newBody } : c))
  }, [])

  const parents = comments.filter(c => !c.parentId)
  const replies = comments.filter(c => c.parentId)

  return (
    <div className="review-comments" style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: '4px' }}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading comments...</div>
      ) : (
        <>
          {parents.length === 0 && (
            <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No comments yet. Be the first!
            </div>
          )}
          {parents.map(parent => (
            <React.Fragment key={parent.id}>
              <CommentItem comment={parent} onDelete={handleDelete} onEdit={handleEdit} />
              {replies.filter(r => r.parentId === parent.id).map(reply => (
                <div key={reply.id} style={{ paddingLeft: '36px' }}>
                  <CommentItem comment={reply} onDelete={handleDelete} onEdit={handleEdit} />
                </div>
              ))}
              {user && (
                <div style={{ paddingLeft: '36px', marginTop: '4px' }}>
                  {replyTo === parent.id ? (
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
                      <textarea
                        value={replyBody}
                        onChange={e => setReplyBody(e.target.value)}
                        maxLength={1000}
                        rows={2}
                        placeholder="Write a reply..."
                        style={{
                          flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                          borderRadius: '6px', padding: '6px 10px', color: 'var(--text-primary)', fontSize: '0.82rem',
                          resize: 'none', outline: 'none', fontFamily: 'inherit',
                        }}
                        autoFocus
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <button className="btn-page" onClick={() => handleReply(parent.id)} disabled={submitting} style={{ fontSize: '0.75rem', padding: '3px 8px' }}>
                          {submitting ? '...' : 'Reply'}
                        </button>
                        <button className="btn-page" onClick={() => { setReplyTo(null); setReplyBody('') }} style={{ fontSize: '0.7rem', padding: '2px 6px', opacity: 0.6 }}>
                          ✕
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn-page"
                      onClick={() => setReplyTo(parent.id)}
                      style={{ fontSize: '0.72rem', padding: '2px 8px', opacity: 0.5, marginTop: '2px' }}
                    >
                      Reply
                    </button>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}
        </>
      )}
      {user && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginTop: '12px', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
          <Avatar src={user?.thumb} name={user?.username} size="28px" />
          <div style={{ flex: 1 }}>
            <textarea
              value={newBody}
              onChange={e => setNewBody(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder="Add a comment..."
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAddComment() }}
              style={{
                width: '100%', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: '6px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '0.85rem',
                resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{newBody.length}/1000</span>
              <button
                className="btn-page"
                onClick={handleAddComment}
                disabled={submitting || !newBody.trim()}
                style={{ fontSize: '0.8rem', padding: '4px 14px' }}
              >
                {submitting ? 'Posting...' : 'Comment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
