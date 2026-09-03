import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { adminStatus, adminTuberr } from '../../services/adminApi'
import HealthStrip from './youtube/HealthStrip'
import QueuePanel from './youtube/QueuePanel'
import SeriesTable from './youtube/SeriesTable'
import MappingDetail from './youtube/MappingDetail'
import DownloadOptions from './youtube/DownloadOptions'
import LogViewer from './youtube/LogViewer'

const POLL_MS = 15000

// Admin → YouTube tab (T14 / B2). Composes:
//   /admin/status.tuberr         — supervisor view (process, reachability, alerts)
//   /admin/tuberr/status         — Tuberr's own /manage/status (queue, failures, staging…)
//   /admin/tuberr/mappings       — series table
// Every field is optional: the backend contracts are landing alongside this UI.
export default function YoutubeDashboard({ onToast }) {
  const { t } = useTranslation()
  const [tuberr, setTuberr] = useState(undefined) // undefined = not loaded, null = backend has no block
  const [status, setStatus] = useState(null)
  const [health, setHealth] = useState(null)
  const [process, setProcess] = useState(null)
  const [mappings, setMappings] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [janitorBusy, setJanitorBusy] = useState(false)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [checkBusy, setCheckBusy] = useState(false)
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    const [st, ts, ms, hs] = await Promise.allSettled([
      adminStatus.get(),
      adminTuberr.getStatus(),
      adminTuberr.getMappings(),
      adminTuberr.health(),
    ])
    const block = st.status === 'fulfilled' ? (st.value.data?.tuberr ?? null) : null
    setTuberr(block)
    if (ts.status === 'fulfilled' && ts.value.data && typeof ts.value.data === 'object') {
      setStatus(ts.value.data)
    } else if (block?.status) {
      setStatus(block.status)
    } else {
      setStatus(null)
    }
    if (hs.status === 'fulfilled') setHealth(hs.value.data || null)
    if (ms.status === 'fulfilled') {
      setMappings(Array.isArray(ms.value.data) ? ms.value.data : [])
      setLoadError(null)
    } else {
      setMappings(prev => prev ?? [])
      setLoadError(ms.reason?.message || 'Tuberr unreachable — check Connections')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount + poll
    load()
    pollRef.current = setInterval(load, POLL_MS)
    return () => clearInterval(pollRef.current)
  }, [load])

  const handleRunJanitor = async () => {
    setJanitorBusy(true)
    try {
      const { data } = await adminTuberr.runJanitor()
      const removed = data?.removed ?? data?.result?.removed
      onToast?.(removed != null ? t('Cleanup finished — {{n}} removed', { n: removed }) : t('Cleanup started'))
      load()
    } catch (e) {
      onToast?.(e.message || 'Cleanup failed', 'error')
    } finally { setJanitorBusy(false) }
  }

  // POST /admin/tuberr/health-check returns the same object as status.tuberr.
  const handleRecheck = async () => {
    setCheckBusy(true)
    try {
      const { data } = await adminTuberr.healthCheck()
      if (data && typeof data === 'object') {
        setTuberr(data)
        if (data.status) setStatus(data.status)
      }
      onToast?.(t('Health check complete'))
      load()
    } catch (e) {
      onToast?.(e.message || 'Health check failed', 'error')
    } finally { setCheckBusy(false) }
  }

  const handleRefreshAll = async () => {
    setRefreshBusy(true)
    try {
      await adminTuberr.refreshAll()
      onToast?.(t('Refresh started for all series'))
      setTimeout(load, 5000)
    } catch (e) {
      onToast?.(e.message || 'Refresh failed', 'error')
    } finally { setRefreshBusy(false) }
  }

  if (tuberr === undefined && mappings === null) {
    return <div className="admin-section"><p style={{ color: 'var(--text-muted)' }}>{t('Loading…')}</p></div>
  }

  // Backend reports the feature off (or nothing is configured at all).
  if (tuberr && tuberr.enabled === false) {
    return (
      <div className="admin-section">
        <h2 className="section-title">{t('YouTube (Tuberr)')}</h2>
        <p className="section-desc">
          {t('YouTube downloads are disabled. Enable them in the Connections tab under “YouTube (Tuberr)”.')}
        </p>
        <button className="btn-admin" onClick={() => { window.location.hash = 'connections' }}>{t('Open Connections')}</button>
      </div>
    )
  }

  if (selectedId) {
    return (
      <div className="admin-section">
        <MappingDetail mappingId={selectedId} onBack={() => { setSelectedId(null); load() }} onToast={onToast} />
      </div>
    )
  }

  return (
    <>
      <HealthStrip
        tuberr={tuberr}
        status={status}
        health={health}
        process={process}
        onRunJanitor={handleRunJanitor}
        janitorBusy={janitorBusy}
        onRefreshAll={handleRefreshAll}
        refreshBusy={refreshBusy}
        onRecheck={handleRecheck}
        checkBusy={checkBusy}
      />

      <QueuePanel queue={status?.queue} failures={status?.recentFailures} />

      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Series')}</h2>
            <p className="section-desc" style={{ margin: 0 }}>
              {t('Each series maps to a channel; episodes are auto-matched to videos. Pause or mark unavailable to stop refreshing dead mappings.')}
            </p>
          </div>
        </div>
        {loadError && <p style={{ color: '#ef4444', fontSize: '0.85rem' }}>{loadError}</p>}
        <SeriesTable mappings={mappings} onReview={setSelectedId} onChanged={load} onToast={onToast} />
      </div>

      <DownloadOptions onToast={onToast} />

      <LogViewer onProcess={setProcess} />
    </>
  )
}
