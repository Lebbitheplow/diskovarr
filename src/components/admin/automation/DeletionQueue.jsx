import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'

function formatDate(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : '—'
}

function gb(bytes) {
  return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : null
}

const STATUS_COLORS = {
  deleted: '#81c784', failed: '#e57373', dismissed: 'var(--text-muted)',
  matched: 'var(--text-muted)', pending_review: '#64b5f6',
}

function CandidateRow({ candidate, selected, onSelect, selectable, t }) {
  const details = candidate.details || {}
  return (
    <div className="library-item" style={{ alignItems: 'flex-start' }}>
      {selectable && (
        <input type="checkbox" className="themed-checkbox" checked={selected} onChange={onSelect} style={{ marginTop: 4, marginRight: 10 }} />
      )}
      <div className="library-item-info" style={{ minWidth: 0 }}>
        <span className="library-item-name">
          {candidate.title} {details.year ? `(${details.year})` : ''}
          <span style={{ marginLeft: 8, fontSize: 11, textTransform: 'uppercase', color: STATUS_COLORS[candidate.status] || 'var(--text-muted)' }}>
            {t(candidate.status.replace('_', ' '))}
          </span>
          {candidate.deleteMethod && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>via {candidate.deleteMethod}</span>}
        </span>
        <span className="library-item-count" style={{ display: 'block' }}>
          {(details.reasons || []).join('; ')}
          {gb(details.fileSize) && <> · {gb(details.fileSize)}</>}
          {details.plays > 0 && <> · {details.plays} {t('plays')}</>}
        </span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)' }}>
          {candidate.profileName ? `${candidate.profileName} · ` : ''}
          {candidate.status === 'deleted' ? `${t('Deleted')} ${formatDate(candidate.deletedAt)}` : `${t('First matched')} ${formatDate(candidate.firstMatchedAt)}`}
          {details.error && <span style={{ color: '#e57373' }}> · {details.error}</span>}
        </span>
      </div>
    </div>
  )
}

export default function DeletionQueue({ onToast }) {
  const { t } = useTranslation()
  const [pending, setPending] = useState([])
  const [matched, setMatched] = useState([])
  const [history, setHistory] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [p, m, h] = await Promise.all([
        adminAutomation.getCandidates({ status: 'pending_review' }),
        adminAutomation.getCandidates({ status: 'matched' }),
        adminAutomation.getHistory(),
      ])
      setPending(p.data.candidates || [])
      setMatched(m.data.candidates || [])
      setHistory(h.data.history || [])
      setSelected(new Set())
    } catch (e) {
      onToast(e.message || 'Failed to load activity', 'error')
    }
  }, [onToast])

  useEffect(() => { load() }, [load])

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const handleApprove = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!window.confirm(t('Permanently delete {{n}} item(s) from the library and disk?', { n: ids.length }))) return
    setBusy(true)
    try {
      const { data } = await adminAutomation.approveCandidates(ids)
      onToast(t('Deleted {{n}} item(s){{failed}}', { n: data.deleted, failed: data.failed ? `, ${data.failed} failed` : '' }), data.failed ? 'error' : 'success')
      load()
    } catch (e) {
      onToast(e.message || 'Deletion failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    setBusy(true)
    try {
      await adminAutomation.dismissCandidates(ids)
      onToast(t('Dismissed {{n}} item(s)', { n: ids.length }))
      load()
    } catch (e) {
      onToast(e.message || 'Dismiss failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Pending Review')} {pending.length > 0 && `(${pending.length})`}</h2>
            <p className="section-desc">{t('Items matched by review-mode profiles. Approving deletes the media files.')}</p>
          </div>
          {pending.length > 0 && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-admin btn-sm" onClick={() => setSelected(new Set(pending.map(c => c.id)))}>{t('Select all')}</button>
              <button className="btn-admin btn-sm" onClick={handleDismiss} disabled={busy || selected.size === 0}>{t('Dismiss')}</button>
              <button className="btn-admin btn-sm btn-danger" onClick={handleApprove} disabled={busy || selected.size === 0}>
                {busy ? t('Working…') : t('Delete selected ({{n}})', { n: selected.size })}
              </button>
            </div>
          )}
        </div>
        {pending.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('Nothing awaiting review.')}</p>}
        <div className="library-list">
          {pending.map(c => (
            <CandidateRow key={c.id} candidate={c} selectable selected={selected.has(c.id)} onSelect={() => toggleSelect(c.id)} t={t} />
          ))}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Dry-Run Matches')} {matched.length > 0 && `(${matched.length})`}</h2>
            <p className="section-desc">{t('What dry-run and automatic profiles currently match (automatic deletes after the grace period).')}</p>
          </div>
        </div>
        {matched.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('No current matches.')}</p>}
        <div className="library-list">
          {matched.slice(0, 100).map(c => <CandidateRow key={c.id} candidate={c} t={t} />)}
        </div>
      </div>

      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Deletion History')}</h2>
            <p className="section-desc">{t('Everything deleted, failed, or dismissed.')}</p>
          </div>
          <button className="btn-admin btn-sm" onClick={load}>{t('Refresh')}</button>
        </div>
        {history.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('Nothing yet.')}</p>}
        <div className="library-list">
          {history.map(c => <CandidateRow key={c.id} candidate={c} t={t} />)}
        </div>
      </div>
    </>
  )
}
