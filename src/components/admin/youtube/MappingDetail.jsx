import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'
import ChannelPicker from './ChannelPicker'
import PlaylistsEditor from './PlaylistsEditor'
import EpisodeRow from './EpisodeRow'
import StatePill from './StatePill'
import { fmtAgo } from './format'

// Series mapping detail: channel, playlists, state, and the per-episode match
// list. Shared by the YouTube admin tab and the Connections "Manage Series"
// modal so there is a single review surface.
export default function MappingDetail({ mappingId, onBack, onToast }) {
  const { t } = useTranslation()
  const [detail, setDetail] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('all')

  const load = useCallback(async () => {
    try {
      const { data } = await adminTuberr.getMapping(mappingId)
      setDetail(data)
    } catch (e) {
      onToast?.(e.message || 'Failed to load mapping', 'error')
    }
  }, [mappingId, onToast])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
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

  const matches = detail.matches || []
  const isSkipped = (m) => !!(m.skipped || m.is_skipped || m.state === 'skipped')
  const counts = {
    all: matches.length,
    unmatched: matches.filter(m => !m.video_id && !isSkipped(m)).length,
    broken: matches.filter(m => m.broken && !isSkipped(m)).length,
    skipped: matches.filter(isSkipped).length,
  }
  const visible = matches.filter(m => {
    if (filter === 'unmatched') return !m.video_id && !isSkipped(m)
    if (filter === 'broken') return m.broken && !isSkipped(m)
    if (filter === 'skipped') return isSkipped(m)
    return true
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        {onBack && <button className="btn-admin" onClick={onBack}>← {t('Back')}</button>}
        <h3 style={{ margin: 0, fontSize: '1rem' }}>{detail.title}</h3>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          tvdb:{detail.tvdb_id}{detail.channel_title ? ` · ${detail.channel_title}` : ` · ${t('no channel set')}`}
        </span>
        <StatePill mapping={detail} onChanged={load} onToast={onToast} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <ChannelPicker detail={detail} onSet={() => setTimeout(load, 4000)} onToast={onToast} />
          <PlaylistsEditor mapping={detail} onSaved={load} onToast={onToast} />
          {detail.channel_id && (
            <button className="btn-admin" disabled={refreshing} onClick={handleRefresh}>
              {refreshing ? t('Refreshing…') : t('Re-run auto-match')}
            </button>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: 10 }}>
        <span>{t('Matched')}: {detail.matched_episodes ?? matches.filter(m => m.video_id).length}/{detail.total_episodes ?? matches.length}</span>
        <span>{t('Last new video')}: {fmtAgo(detail.last_new_video_at)}</span>
        <span>{t('Last grab')}: {fmtAgo(detail.last_grab_at)}</span>
        {detail.last_refreshed_at != null && <span>{t('Last refresh')}: {fmtAgo(detail.last_refreshed_at)}</span>}
      </div>
      {matches.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {['all', 'unmatched', 'broken', 'skipped'].map(f => (
            <button key={f} className={`btn-admin ${filter === f ? 'btn-primary' : ''}`} style={{ fontSize: '0.72rem', padding: '2px 8px' }}
              onClick={() => setFilter(f)}>
              {t(f)} ({counts[f]})
            </button>
          ))}
        </div>
      )}
      {visible.map(m => (
        <EpisodeRow key={`${m.season}-${m.episode}`} mapping={detail} match={m} onChanged={load} onToast={onToast} />
      ))}
      {matches.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{t('No episodes synced yet — is the series in Sonarr?')}</p>
      )}
      {matches.length > 0 && visible.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('Nothing in this filter.')}</p>
      )}
    </div>
  )
}
