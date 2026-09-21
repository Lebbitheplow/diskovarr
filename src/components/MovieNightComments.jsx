import React, { useState, useCallback, useEffect } from 'react'
import { movieNightApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { posterUrl } from '../utils/media'
import { useTranslation } from 'react-i18next'

function fmtTime(ts) {
  if (!ts) return ''
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) { const m = Math.floor(diff / 60); return m + 'm ago' }
  if (diff < 86400) { const h = Math.floor(diff / 3600); return h + 'h ago' }
  if (diff < 604800) { const d = Math.floor(diff / 86400); return d + 'd ago' }
  return new Date(ts * 1000).toLocaleDateString()
}

function Commenter({ src, name }) {
  // Persona avatars are emoji strings; user avatars are poster paths.
  const isEmoji = src && !src.startsWith('/') && !src.startsWith('http')
  if (isEmoji) {
    return <span className="mn-avatar mn-avatar-emoji" aria-hidden="true">{src}</span>
  }
  if (src) return <img className="mn-avatar" src={posterUrl(src)} alt="" />
  return <span className="mn-avatar">{(name || '?')[0].toUpperCase()}</span>
}

// Non-threaded comments for a Movie Night entry. Optionally votes/comments are
// cast as an in-house persona via the identity picker.
export default function MovieNightComments({ entryId, personas = [], onCountChange }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [newBody, setNewBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [personaId, setPersonaId] = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      setLoading(true)
      try {
        const { data } = await movieNightApi.getComments(entryId)
        if (active) setComments(data.comments || [])
      } catch (e) {
        if (active) console.error('Failed to load movie night comments', e)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [entryId])

  const handleAdd = useCallback(async () => {
    if (!newBody.trim()) return
    setSubmitting(true)
    try {
      const { data } = await movieNightApi.addComment(entryId, {
        body: newBody.trim(),
        personaId: personaId || undefined,
      })
      setComments(prev => [...prev, data])
      setNewBody('')
      onCountChange?.(1)
    } catch (e) {
      toastError(e?.message || t('Failed to add comment'))
    } finally {
      setSubmitting(false)
    }
  }, [entryId, newBody, personaId, toastError, t, onCountChange])

  const handleDelete = useCallback(async (id) => {
    try {
      await movieNightApi.deleteComment(id)
      setComments(prev => prev.filter(c => c.id !== id))
      onCountChange?.(-1)
    } catch (e) {
      toastError(e?.message || t('Failed to delete comment'))
    }
  }, [toastError, t, onCountChange])

  const activePersona = personas.find(p => p.id === personaId)

  return (
    <div className="mn-comments">
      {loading ? (
        <div className="mn-empty" style={{ padding: '16px' }}>{t('Loading comments...')}</div>
      ) : comments.length === 0 ? (
        <div className="mn-empty" style={{ padding: '12px 0' }}>{t('No comments yet. Be the first!')}</div>
      ) : (
        comments.map(c => (
          <div key={c.id} className="mn-comment" style={{ display: 'flex', gap: 8, padding: '7px 0', alignItems: 'flex-start' }}>
            <Commenter src={c.userAvatar} name={c.username} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{c.username}</span>
                {c.isPersona && <span className="mn-badge">{t('Persona')}</span>}
                <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{fmtTime(c.createdAt)}</span>
                {c.isOwn && (
                  <button className="mn-link-btn danger" style={{ marginLeft: 'auto' }} onClick={() => handleDelete(c.id)}>{t('Delete')}</button>
                )}
              </div>
              <p style={{ margin: '3px 0 0', fontSize: '0.88rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.body}</p>
            </div>
          </div>
        ))
      )}
      {user && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <IdentityPicker personas={personas} personaId={personaId} onChange={setPersonaId} />
          <div style={{ flex: 1 }}>
            <textarea
              value={newBody}
              onChange={e => setNewBody(e.target.value)}
              maxLength={1000}
              rows={2}
              placeholder={activePersona ? t('Comment as {{name}}...', { name: activePersona.display_name }) : t('Add a comment...')}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAdd() }}
              className="mn-input"
              style={{ width: '100%', resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{newBody.length}/1000</span>
              <button className="btn-page" onClick={handleAdd} disabled={submitting || !newBody.trim()}>
                {submitting ? t('Posting...') : t('Comment')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Small popover that lets the actor comment/vote as "yourself" or an in-house
// persona. Shared by the comments box and the vote controls in the detail page.
export function IdentityPicker({ personas = [], personaId, onChange, label }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const active = personas.find(p => p.id === personaId)
  return (
    <div className="mn-persona-menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <button type="button" className="mn-persona-trigger" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        {active ? <span className="mn-avatar mn-avatar-emoji" style={{ width: 20, height: 20 }}>{active.avatar_emoji || '🙂'}</span> : null}
        <span>{label || (active ? active.display_name : t('You'))}</span>
        {personas.length > 0 && <span style={{ opacity: 0.6 }}>▾</span>}
      </button>
      {open && personas.length > 0 && (
        <div className="mn-persona-list" role="menu">
          <button
            type="button"
            role="menuitem"
            className={`mn-persona-option${personaId == null ? ' active' : ''}`}
            onClick={() => { onChange(null); setOpen(false) }}
          >
            <span>{t('Yourself')}</span>
          </button>
          {personas.map(p => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              className={`mn-persona-option${personaId === p.id ? ' active' : ''}`}
              onClick={() => { onChange(p.id); setOpen(false) }}
            >
              <span className="mn-avatar mn-avatar-emoji" style={{ width: 20, height: 20 }}>{p.avatar_emoji || '🙂'}</span>
              <span>{p.display_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
