import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'
import { parseJsonArray, pillStyle } from './format'

// One episode↔video row inside a mapping. Handles manual match, Sonarr search,
// and the per-episode Skip / Unskip state (T6) with optional Sonarr unmonitor.

function isSkipped(match) {
  return !!(match.skipped || match.is_skipped || match.state === 'skipped')
}

function confidenceBadge(match) {
  if (isSkipped(match)) return { label: 'skipped', color: '#94a3b8' }
  if (match.broken) return { label: 'broken', color: '#ef4444' }
  if (!match.video_id) return { label: 'unmatched', color: '#f59e0b' }
  if (match.source === 'manual') return { label: 'manual', color: '#60a5fa' }
  const pct = Math.round((match.confidence || 0) * 100)
  return { label: `${pct}%`, color: pct >= 85 ? '#4ade80' : pct >= 70 ? '#a3e635' : '#f59e0b' }
}

function extractVideoId(text) {
  const s = String(text || '').trim()
  const m = /(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(s)
  if (m) return m[1]
  return /^[\w-]{11}$/.test(s) ? s : null
}

export default function EpisodeRow({ mapping, match, onChanged, onToast }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const [unmonitor, setUnmonitor] = useState(false)
  const badge = confidenceBadge(match)
  const skipped = isSkipped(match)
  const candidates = parseJsonArray(match.candidates_json)
  const attempts = Number(match.attempts || match.attempt || 0)

  const applyMatch = async (videoId) => {
    setBusy(true)
    try {
      await adminTuberr.setMatch(mapping.id, match.season, match.episode, videoId)
      onToast?.(videoId ? t('Match updated') : t('Match cleared'))
      onChanged?.()
    } catch (e) {
      onToast?.(e.message || 'Failed to update match', 'error')
    } finally { setBusy(false) }
  }

  const handleSearch = async () => {
    setBusy(true)
    try {
      await adminTuberr.searchEpisode(mapping.id, match.season, match.episode)
      onToast?.(t('Sonarr search triggered'))
    } catch (e) {
      onToast?.(e.message || 'Search failed', 'error')
    } finally { setBusy(false) }
  }

  const setSkipped = async (next) => {
    setBusy(true)
    try {
      await adminTuberr.setEpisodeSkip(mapping.id, match.season, match.episode, next
        ? { skipped: true, reason: skipReason.trim() || undefined, unmonitor }
        : { skipped: false })
      onToast?.(next ? t('Episode skipped') : t('Episode unskipped'))
      setSkipReason('')
      onChanged?.()
    } catch (e) {
      onToast?.(e.message || 'Failed to update episode', 'error')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 0', opacity: skipped ? 0.7 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', minWidth: 72 }}>
          S{String(match.season).padStart(2, '0')}E{String(match.episode).padStart(2, '0')}
        </span>
        <span style={{ flex: '1 1 200px', fontSize: '0.88rem' }}>
          {match.episode_title || t('(untitled)')}
          {match.air_date && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: '0.78rem' }}>{match.air_date}</span>}
        </span>
        <span style={pillStyle(badge.color)} title={skipped ? (match.skip_reason || match.reason || '') : ''}>
          {badge.label}
        </span>
        {match.broken && attempts > 0 && (
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }} title={match.error || match.last_error || ''}>
            {t('{{n}} attempts', { n: attempts })}
          </span>
        )}
        {match.video_id ? (
          <a href={`https://www.youtube.com/watch?v=${match.video_id}`} target="_blank" rel="noreferrer"
            style={{ flex: '1 1 220px', fontSize: '0.82rem', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {match.video_title || match.video_id}
          </a>
        ) : (
          <span style={{ flex: '1 1 220px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('no video')}</span>
        )}
        {skipped ? (
          <button className="btn-admin" style={{ fontSize: '0.75rem' }} disabled={busy} onClick={() => setSkipped(false)}>
            {t('Unskip')}
          </button>
        ) : (
          <button className="btn-admin" style={{ fontSize: '0.75rem' }} onClick={() => setExpanded(e => !e)}>
            {expanded ? t('Close') : t('Edit')}
          </button>
        )}
      </div>
      {skipped && (match.skip_reason || match.reason) && (
        <div style={{ marginTop: 4, paddingLeft: 72, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          {t('Reason')}: {match.skip_reason || match.reason}
        </div>
      )}
      {expanded && !skipped && (
        <div style={{ marginTop: 8, paddingLeft: 72 }}>
          {candidates.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('Candidates')}</span>
              {candidates.map(c => (
                <div key={c.videoId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                  <button className="btn-admin" style={{ fontSize: '0.72rem' }} disabled={busy || c.videoId === match.video_id}
                    onClick={() => applyMatch(c.videoId)}>
                    {c.videoId === match.video_id ? t('Current') : t('Use')}
                  </button>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', minWidth: 36 }}>{Math.round(c.score * 100)}%</span>
                  <a href={`https://www.youtube.com/watch?v=${c.videoId}`} target="_blank" rel="noreferrer"
                    style={{ fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title}
                  </a>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="text" className="conn-input" placeholder={t('Paste YouTube URL or video ID…')}
              value={urlInput} onChange={e => setUrlInput(e.target.value)}
              style={{ flex: '1 1 240px', fontSize: '0.8rem' }} />
            <button className="btn-admin" disabled={busy || !extractVideoId(urlInput)}
              onClick={() => { const id = extractVideoId(urlInput); if (id) { applyMatch(id); setUrlInput('') } }}>
              {t('Set video')}
            </button>
            {match.video_id && (
              <button className="btn-admin" disabled={busy} onClick={() => applyMatch(null)}>{t('Unmatch')}</button>
            )}
            <button className="btn-admin btn-primary" disabled={busy || !match.video_id} onClick={handleSearch}
              title={t('Tell Sonarr to search & grab this episode now')}>
              {t('Search in Sonarr')}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
            <input type="text" className="conn-input" placeholder={t('Skip reason (optional) — e.g. not on the channel')}
              value={skipReason} onChange={e => setSkipReason(e.target.value)}
              style={{ flex: '1 1 240px', fontSize: '0.8rem' }} />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={unmonitor} onChange={e => setUnmonitor(e.target.checked)} />
              {t('also unmonitor in Sonarr')}
            </label>
            <button className="btn-admin" disabled={busy} onClick={() => setSkipped(true)}
              title={t('Stop trying to match or download this episode')}>
              {t('Skip')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
