import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../services/adminApi'
import SeriesTable from './youtube/SeriesTable'
import MappingDetail from './youtube/MappingDetail'

// YouTube series manager — a modal opened from Admin → Connections → YouTube
// (Tuberr). Thin wrapper over the shared series table + mapping detail used
// by the YouTube admin tab (src/components/admin/YoutubeDashboard.jsx).

function YoutubeMappingsBody({ onToast }) {
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
      <MappingDetail mappingId={selectedId} onBack={() => { setSelectedId(null); load() }} onToast={onToast} />
    )
  }

  return (
    <div>
      <p className="section-desc">
        {t('YouTube series downloading through Sonarr via Tuberr. Each series maps to a channel; episodes are auto-matched to videos and can be corrected here.')}
        {health && (
          <span style={{ display: 'block', marginTop: 4, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Tuberr v{health.version} · yt-dlp {health.ytDlp} · {health.youtubeKey ? 'YouTube API ✓' : 'YouTube API key missing'} · {health.sonarr ? 'Sonarr ✓' : 'Sonarr not configured'}
          </span>
        )}
        <a href="/admin#youtube" style={{ display: 'block', marginTop: 4, fontSize: '0.8rem' }}>
          {t('Open the YouTube tab for queue, failures, logs and download options →')}
        </a>
      </p>
      <SeriesTable mappings={mappings} onReview={setSelectedId} onChanged={load} onToast={onToast} compact />
    </div>
  )
}

// Modal wrapper (same overlay pattern as BulkSettingsModal) — opened from the
// "Manage Series" button in the Connections page's YouTube (Tuberr) section.
export default function YoutubeMappingsModal({ onClose, onToast }) {
  const { t } = useTranslation()
  const handleOverlayClick = useCallback((e) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.75)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={handleOverlayClick}
    >
      <div
        style={{
          background: 'var(--bg-secondary)', borderRadius: '14px', padding: '28px',
          width: 'min(820px, 94vw)', border: '1px solid var(--border)',
          position: 'relative', maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <button
          onClick={onClose}
          aria-label={t('Close')}
          style={{
            position: 'absolute', top: '14px', right: '16px',
            background: 'none', border: 'none', color: 'var(--text-secondary)',
            fontSize: '1.3rem', cursor: 'pointer',
          }}
        >
          ✕
        </button>
        <h3 style={{ margin: '0 0 14px', fontSize: '1.05rem', fontWeight: 600 }}>{t('YouTube Series')}</h3>
        <YoutubeMappingsBody onToast={onToast} />
      </div>
    </div>
  )
}
