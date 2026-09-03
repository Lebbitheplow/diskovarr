import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'
import { fmtAgo, fmtDateTime } from './format'

const LEVEL_COLORS = { error: '#ef4444', warn: '#f59e0b', warning: '#f59e0b', info: 'var(--text-primary)', debug: 'var(--text-muted)' }
const REFRESH_MS = 10000

// Collapsible Tuberr log panel (T14). Polls GET /admin/tuberr/logs every 10s
// while open; the ring buffer lives on the server so nothing is kept here.
export default function LogViewer({ onProcess }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState([])
  const [process, setProcess] = useState(null)
  const [error, setError] = useState(null)
  const [follow, setFollow] = useState(true)
  const preRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const { data } = await adminTuberr.getLogs()
      setLines(Array.isArray(data?.lines) ? data.lines : [])
      setProcess(data?.process || null)
      setError(null)
      onProcess?.(data?.process || null)
    } catch (e) {
      setError(e.message || 'Could not load logs')
    }
  }, [onProcess])

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-open + poll
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [open, load])

  useEffect(() => {
    if (open && follow && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [lines, open, follow])

  return (
    <div className="admin-section">
      <div className="admin-section-header" style={{ marginBottom: open ? 12 : 0 }}>
        <div>
          <h2 className="section-title">{t('Logs')}</h2>
          <p className="section-desc" style={{ margin: 0 }}>
            {process
              ? `${process.running ? t('running') : t('stopped')}${process.pid ? ` · pid ${process.pid}` : ''}${process.startedAt ? ` · ${t('started')} ${fmtAgo(process.startedAt)}` : ''}${process.restarts ? ` · ${t('{{n}} restarts', { n: process.restarts })}` : ''}`
              : t('Tuberr process output, captured by Diskovarr.')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {open && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              {t('Follow')}
            </label>
          )}
          {open && <button className="btn-admin" onClick={load}>{t('Refresh')}</button>}
          <button className="btn-admin" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? t('Hide logs') : t('Show logs')}
          </button>
        </div>
      </div>
      {open && (
        <>
          {error && <p style={{ color: '#ef4444', fontSize: '0.82rem' }}>{error}</p>}
          {process?.lastExit && (
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 8px' }}>
              {t('Last exit')}: {typeof process.lastExit === 'object' ? JSON.stringify(process.lastExit) : String(process.lastExit)}
            </p>
          )}
          <pre ref={preRef} style={{ margin: 0, maxHeight: 360, overflow: 'auto', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontSize: '0.74rem', lineHeight: 1.5 }}>
            {lines.length === 0 && <span style={{ color: 'var(--text-muted)' }}>{t('No log lines yet.')}</span>}
            {lines.map((l, i) => (
              <div key={i} style={{ color: LEVEL_COLORS[String(l.level || 'info').toLowerCase()] || 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                <span style={{ color: 'var(--text-muted)' }}>{fmtDateTime(l.ts)}</span>
                {' '}
                <span style={{ textTransform: 'uppercase', fontWeight: 600 }}>{String(l.level || 'info').slice(0, 5).padEnd(5)}</span>
                {' '}{l.msg}
              </div>
            ))}
          </pre>
        </>
      )}
    </div>
  )
}
