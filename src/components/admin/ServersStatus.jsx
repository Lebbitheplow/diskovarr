import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { adminStatus } from '../../services/adminApi'
import { fmtAgo, fmtBytes } from './youtube/format'

const OK = '#4ade80'
const WARN = '#f59e0b'
const BAD = '#ef4444'
const MUTED = '#94a3b8'
const POLL_MS = 30000

function Dot({ color }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' }} />
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.82rem', padding: '3px 0' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  )
}

function ServerCard({ name, configured, items, live, liveLabel, lastSyncAt }) {
  const { t } = useTranslation()
  return (
    <div className="stat-card">
      <div className="stat-label">{name}</div>
      <div className="stat-value" style={{ fontSize: '1.05rem', display: 'flex', alignItems: 'center' }}>
        <Dot color={configured ? OK : MUTED} />{configured ? t('Configured') : t('Not configured')}
      </div>
      {configured && (
        <div style={{ marginTop: 6 }}>
          {items != null && <Row label={t('Library items')} value={Number(items).toLocaleString()} />}
          {live != null && <Row label={liveLabel} value={<><Dot color={live ? OK : WARN} />{live ? t('connected') : t('disconnected')}</>} />}
          {lastSyncAt != null && <Row label={t('Last sync')} value={fmtAgo(lastSyncAt)} />}
        </div>
      )}
    </div>
  )
}

function TuberrCard({ tuberr }) {
  const { t } = useTranslation()
  const s = tuberr.status || {}
  const alerts = Array.isArray(tuberr.alerts) ? tuberr.alerts : []
  const healthy = tuberr.reachable !== false && tuberr.running !== false && alerts.length === 0
  return (
    <div className="stat-card">
      <div className="stat-label">{t('YouTube (Tuberr)')}</div>
      <div className="stat-value" style={{ fontSize: '1.05rem', display: 'flex', alignItems: 'center' }}>
        <Dot color={healthy ? OK : (tuberr.reachable === false || tuberr.running === false) ? BAD : WARN} />
        {tuberr.running === false ? t('Stopped') : tuberr.reachable === false ? t('Unreachable') : alerts.length ? t('Needs attention') : t('Healthy')}
      </div>
      <div style={{ marginTop: 6 }}>
        {tuberr.pid != null && <Row label={t('Process')} value={`pid ${tuberr.pid}`} />}
        {s.lastRefreshAt !== undefined && <Row label={t('Last refresh')} value={fmtAgo(s.lastRefreshAt)} />}
        {s.lastGrabAt !== undefined && <Row label={t('Last grab')} value={fmtAgo(s.lastGrabAt)} />}
        {Array.isArray(s.queue) && <Row label={t('Queue')} value={s.queue.length} />}
        {Array.isArray(s.recentFailures) && s.recentFailures.length > 0 && <Row label={t('Failures')} value={<span style={{ color: BAD }}>{s.recentFailures.length}</span>} />}
        {s.needsReview != null && <Row label={t('Needs review')} value={s.needsReview} />}
        {s.staging?.bytes != null && <Row label={t('Staging')} value={fmtBytes(s.staging.bytes)} />}
        {tuberr.sonarrWiring && tuberr.sonarrWiring.ok === false && (
          <div style={{ fontSize: '0.76rem', color: WARN, marginTop: 4 }}>{tuberr.sonarrWiring.message || t('Sonarr wiring drift')}</div>
        )}
        {alerts.slice(0, 3).map((a, i) => (
          <div key={i} style={{ fontSize: '0.76rem', color: WARN, marginTop: 4 }}>{String(a)}</div>
        ))}
      </div>
      <button className="btn-admin" style={{ marginTop: 10, fontSize: '0.75rem' }} onClick={() => { window.location.hash = 'youtube' }}>
        {t('Open YouTube tab')}
      </button>
    </div>
  )
}

// "Servers" + "YouTube (Tuberr)" cards on the General tab, fed by
// /admin/status `sources` and `tuberr` (A2.10 / T2). Both blocks are optional
// on older backends — the section renders nothing until at least one exists.
export default function ServersStatus() {
  const { t } = useTranslation()
  const [sources, setSources] = useState(null)
  const [tuberr, setTuberr] = useState(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { data } = await adminStatus.get()
        if (cancelled) return
        setSources(data?.sources || null)
        setTuberr(data?.tuberr || null)
      } catch { /* status polling is best-effort */ }
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const showTuberr = !!(tuberr && tuberr.enabled)
  if (!sources && !showTuberr) return null

  const plex = sources?.plex || {}
  const jf = sources?.jellyfin || {}

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Servers')}</h2>
          <p className="section-desc" style={{ margin: 0 }}>{t('Connected media servers and companion services.')}</p>
        </div>
      </div>
      <div className="admin-grid" style={{ marginBottom: 0 }}>
        {sources && (
          <>
            <ServerCard name="Plex" configured={!!plex.configured} items={plex.libraryItems}
              live={plex.configured ? plex.sseConnected : null} liveLabel={t('Realtime (SSE)')} />
            <ServerCard name="Jellyfin" configured={!!jf.enabled} items={jf.libraryItems}
              live={jf.enabled ? jf.wsConnected : null} liveLabel={t('Realtime (websocket)')} lastSyncAt={jf.enabled ? jf.lastSyncAt : null} />
          </>
        )}
        {showTuberr && <TuberrCard tuberr={tuberr} />}
      </div>
    </div>
  )
}
