import React from 'react'
import { useTranslation } from 'react-i18next'
import { fmtAgo, fmtEta, fmtSpeed } from './format'

function stateColor(state) {
  const s = String(state || '').toLowerCase()
  if (/error|fail|broken/.test(s)) return '#ef4444'
  if (/complete|done|imported/.test(s)) return '#4ade80'
  if (/download|active|running/.test(s)) return 'var(--accent)'
  return '#94a3b8'
}

function ProgressBar({ value }) {
  const pct = Math.max(0, Math.min(100, Number(value) <= 1 ? Number(value) * 100 : Number(value)))
  return (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elevated)', border: '1px solid var(--border)', overflow: 'hidden' }}
      role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.4s ease' }} />
    </div>
  )
}

// Active downloads (with progress) and recent yt-dlp failures.
export default function QueuePanel({ queue, failures }) {
  const { t } = useTranslation()
  const q = Array.isArray(queue) ? queue : []
  const f = Array.isArray(failures) ? failures : []

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Downloads')}</h2>
          <p className="section-desc" style={{ margin: 0 }}>{t('What Sonarr has grabbed and Tuberr is fetching right now.')}</p>
        </div>
      </div>

      {q.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('Queue is empty.')}</p>}
      {q.map((item, i) => {
        const pct = Number(item.progress) <= 1 ? Number(item.progress || 0) * 100 : Number(item.progress || 0)
        return (
          <div key={item.infoHash || i} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
              <span style={{ flex: '1 1 260px', fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.releaseTitle || ''}>
                {item.releaseTitle || item.infoHash || t('(untitled)')}
              </span>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: stateColor(item.state), border: `1px solid ${stateColor(item.state)}`, borderRadius: 10, padding: '1px 8px' }}>
                {item.state || '—'}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {Math.round(pct)}%{fmtSpeed(item.dlspeed) ? ` · ${fmtSpeed(item.dlspeed)}` : ''}{fmtEta(item.eta) ? ` · ${t('ETA')} ${fmtEta(item.eta)}` : ''}{item.addedOn ? ` · ${t('added')} ${fmtAgo(item.addedOn)}` : ''}
              </span>
            </div>
            <ProgressBar value={pct} />
            {item.error && <div style={{ marginTop: 4, fontSize: '0.75rem', color: '#ef4444' }}>{String(item.error)}</div>}
          </div>
        )
      })}

      <h3 style={{ fontSize: '0.9rem', margin: '18px 0 6px' }}>{t('Recent failures')}</h3>
      {f.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>{t('No recent failures.')}</p>}
      {f.map((item, i) => (
        <div key={`${item.videoId || ''}-${i}`} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '0.84rem' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 240px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.releaseTitle || item.videoId}</span>
            {item.videoId && (
              <a href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noreferrer" style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>{item.videoId}</a>
            )}
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {fmtAgo(item.at)}{item.attempts ? ` · ${t('{{n}} attempts', { n: item.attempts })}` : ''}
            </span>
          </div>
          <div style={{ marginTop: 3, fontSize: '0.76rem', color: '#ef4444', wordBreak: 'break-word' }}>{String(item.error || '')}</div>
          <div style={{ marginTop: 2, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {/bot|sign in|cookie/i.test(String(item.error || ''))
              ? t('Retry hint: refresh the YouTube cookies in Connections → YouTube, then use “Search in Sonarr” on the episode.')
              : t('Retry hint: open the series, fix or re-set the video, then use “Search in Sonarr” to grab it again.')}
          </div>
        </div>
      ))}
    </div>
  )
}
