import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../services/adminApi'

// Admin → YouTube: review and correct episode↔video matches for series that
// download through the Tuberr companion service.

function confidenceBadge(match) {
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

function EpisodeRow({ mapping, match, onChanged, onToast }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const badge = confidenceBadge(match)
  const candidates = (() => { try { return JSON.parse(match.candidates_json || '[]') } catch { return [] } })()

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

  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', minWidth: 72 }}>
          S{String(match.season).padStart(2, '0')}E{String(match.episode).padStart(2, '0')}
        </span>
        <span style={{ flex: '1 1 200px', fontSize: '0.88rem' }}>
          {match.episode_title || t('(untitled)')}
          {match.air_date && <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: '0.78rem' }}>{match.air_date}</span>}
        </span>
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 10, padding: '1px 8px' }}>
          {badge.label}
        </span>
        {match.video_id ? (
          <a href={`https://www.youtube.com/watch?v=${match.video_id}`} target="_blank" rel="noreferrer"
            style={{ flex: '1 1 220px', fontSize: '0.82rem', color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {match.video_title || match.video_id}
          </a>
        ) : (
          <span style={{ flex: '1 1 220px', fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('no video')}</span>
        )}
        <button className="btn-admin" style={{ fontSize: '0.75rem' }} onClick={() => setExpanded(e => !e)}>
          {expanded ? t('Close') : t('Edit')}
        </button>
      </div>
      {expanded && (
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
        </div>
      )}
    </div>
  )
}

function MappingDetail({ mappingId, onBack, onToast }) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await adminTuberr.getMapping(mappingId)
      setDetail(data)
    } catch (e) {
      onToast?.(e.message || 'Failed to load mapping', 'error')
    }
  }, [mappingId, onToast])

  useEffect(() => { load() }, [load])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await adminTuberr.refreshMapping(mappingId)
      onToast?.(t('Refresh & re-match started'))
      // matching runs async in Tuberr; reload after a beat
      setTimeout(load, 4000)
    } catch (e) {
      onToast?.(e.message || 'Refresh failed', 'error')
    } finally { setRefreshing(false) }
  }

  if (!detail) return <p style={{ color: 'var(--text-muted)' }}>{t('Loading…')}</p>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn-admin" onClick={onBack}>← {t('Back')}</button>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>{detail.title}</h3>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          tvdb:{detail.tvdb_id}{detail.channel_title ? ` · ${detail.channel_title}` : ''}
        </span>
        <button className="btn-admin" style={{ marginLeft: 'auto' }} disabled={refreshing} onClick={handleRefresh}>
          {refreshing ? t('Refreshing…') : t('Re-run auto-match')}
        </button>
      </div>
      {(detail.matches || []).map(m => (
        <EpisodeRow key={`${m.season}-${m.episode}`} mapping={detail} match={m} onChanged={load} onToast={onToast} />
      ))}
      {(detail.matches || []).length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{t('No episodes synced yet — is the series in Sonarr?')}</p>
      )}
    </div>
  )
}

export default function YoutubeMappings({ onToast }) {
  const { t } = useTranslation()
  const [mappings, setMappings] = useState(null)
  const [health, setHealth] = useState(null)
  const [selectedId, setSelectedId] = useState(null)

  const load = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([adminTuberr.getMappings(), adminTuberr.health().catch(() => null)])
      setMappings(m.data || [])
      setHealth(h?.data || null)
    } catch (e) {
      setMappings([])
      onToast?.(e.message || 'Tuberr unreachable — check Connections', 'error')
    }
  }, [onToast])

  useEffect(() => { load() }, [load])

  if (selectedId) {
    return (
      <section className="admin-section">
        <MappingDetail mappingId={selectedId} onBack={() => { setSelectedId(null); load() }} onToast={onToast} />
      </section>
    )
  }

  return (
    <section className="admin-section">
      <p className="section-desc">
        {t('YouTube series downloading through Sonarr via Tuberr. Each series maps to a channel; episodes are auto-matched to videos and can be corrected here.')}
        {health && (
          <span style={{ display: 'block', marginTop: 4, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Tuberr v{health.version} · yt-dlp {health.ytDlp} · {health.youtubeKey ? 'YouTube API ✓' : 'YouTube API key missing'} · {health.sonarr ? 'Sonarr ✓' : 'Sonarr not configured'}
          </span>
        )}
      </p>
      {mappings === null && <p style={{ color: 'var(--text-muted)' }}>{t('Loading…')}</p>}
      {mappings && mappings.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>
          {t('No YouTube series yet. Request a TV show and pick “YouTube” as the downloader to create one.')}
        </p>
      )}
      {mappings && mappings.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <div style={{ fontWeight: 600, fontSize: '0.92rem' }}>{m.title}</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {m.channel_title || t('no channel set')} · tvdb:{m.tvdb_id}
            </div>
          </div>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            {m.matched_episodes}/{m.total_episodes} {t('matched')}
          </span>
          <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '1px 8px', borderRadius: 10,
            border: '1px solid var(--border)',
            color: m.match_status === 'matched' ? '#4ade80' : m.match_status === 'partial' ? '#f59e0b' : 'var(--text-muted)' }}>
            {m.match_status}
          </span>
          <button className="btn-admin" onClick={() => setSelectedId(m.id)}>{t('Review')}</button>
        </div>
      ))}
    </section>
  )
}
