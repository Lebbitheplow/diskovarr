import React from 'react'
import { useTranslation } from 'react-i18next'
import { fmtAgo, fmtBytes, fmtDateTime, fmtDuration } from './format'

const OK = '#4ade80'
const WARN = '#f59e0b'
const BAD = '#ef4444'
const MUTED = '#94a3b8'

function Dot({ color }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' }} />
}

function Chip({ color, label, title }) {
  return (
    <span title={title || ''} style={{ display: 'inline-flex', alignItems: 'center', fontSize: '0.78rem', padding: '3px 10px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-elevated)', whiteSpace: 'nowrap' }}>
      <Dot color={color} />{label}
    </span>
  )
}

function Stat({ label, value, sub, action }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: '1.15rem' }}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
      {action}
    </div>
  )
}

// Process / reachability / yt-dlp / cookies / Sonarr wiring / quota warnings
// (T2, T12) plus the headline timestamps and counts from /manage/status.
// `tuberr` is /admin/status.tuberr (may be null on older backends);
// `status` is /admin/tuberr/status (may be null when Tuberr is unreachable).
export default function HealthStrip({ tuberr, status, health, process, onRunJanitor, janitorBusy, onRefreshAll, refreshBusy, onRecheck, checkBusy }) {
  const { t } = useTranslation()
  const h = tuberr?.health || health || {}
  const proc = process || {}
  const running = tuberr?.running ?? proc.running
  const managed = tuberr?.managed ?? proc.managed
  const pid = tuberr?.pid ?? proc.pid
  const restarts = tuberr?.restarts ?? proc.restarts
  const lastExit = tuberr?.lastExit ?? proc.lastExit
  const restartPending = tuberr?.restartPending ?? proc.restartPending
  const reachable = tuberr?.reachable ?? (status ? !!status.ok || !!status.version : undefined)
  const ytDlp = status?.ytDlp || h.ytDlp
  const ytDlpStatus = status?.ytDlpStatus
  const cookies = status?.cookies || (h.cookies != null ? { present: !!h.cookies } : null)
  const botCheckAt = cookies?.botCheckAt
  const quota = status?.quota
  const wiring = tuberr?.sonarrWiring
  const alerts = Array.isArray(tuberr?.alerts) ? tuberr.alerts : []
  const staging = status?.staging
  const janitor = status?.janitor

  const chips = []
  if (managed !== undefined || running !== undefined) {
    chips.push({ color: running ? (restartPending ? WARN : OK) : BAD, label: running ? `${t('Process running')}${pid ? ` · pid ${pid}` : ''}${restarts ? ` · ${t('{{n}} restarts', { n: restarts })}` : ''}${restartPending ? ` · ${t('restart pending')}` : ''}` : (managed ? t('Process stopped') : t('External process')), title: lastExit ? `${t('Last exit')}: ${typeof lastExit === 'object' ? JSON.stringify(lastExit) : lastExit}` : '' })
  }
  if (reachable !== undefined) {
    chips.push({ color: reachable ? OK : BAD, label: reachable ? t('Reachable') : t('Unreachable'), title: tuberr?.lastOkAt ? `${t('Last OK')}: ${fmtDateTime(tuberr.lastOkAt)}` : '' })
  }
  if (ytDlp || ytDlpStatus) {
    const bad = ytDlpStatus && /missing|error|fail/i.test(String(ytDlpStatus))
    chips.push({ color: bad ? BAD : OK, label: `yt-dlp ${ytDlp || ytDlpStatus}`, title: ytDlpStatus ? String(ytDlpStatus) : '' })
  }
  if (cookies) {
    chips.push({ color: botCheckAt ? BAD : cookies.present ? OK : MUTED, label: botCheckAt ? t('Cookies rejected (bot check)') : cookies.present ? t('Cookies present') : t('No cookies'), title: botCheckAt ? `${t('Bot check at')} ${fmtDateTime(botCheckAt)}` : '' })
  }
  if (h.youtubeKey !== undefined) {
    chips.push({ color: h.youtubeKey ? OK : WARN, label: h.youtubeKey ? t('YouTube API key') : t('YouTube API key missing') })
  }
  if (wiring) {
    chips.push({ color: wiring.ok ? OK : WARN, label: wiring.ok ? t('Sonarr wired') : t('Sonarr wiring drift'), title: wiring.message || '' })
  } else if (h.sonarr !== undefined) {
    chips.push({ color: h.sonarr ? OK : WARN, label: h.sonarr ? t('Sonarr configured') : t('Sonarr not configured') })
  }
  if (tuberr?.lastError) {
    chips.push({ color: WARN, label: t('Last error'), title: String(tuberr.lastError) })
  }
  if (quota?.exceededAt) {
    chips.push({ color: BAD, label: t('YouTube quota exceeded'), title: `${fmtDateTime(quota.exceededAt)} ${quota.lastError || ''}` })
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 className="section-title">{t('YouTube (Tuberr)')}</h2>
          <p className="section-desc" style={{ margin: 0 }}>
            {t('Downloads YouTube channels as Sonarr episodes.')}{status?.version ? ` · Tuberr v${status.version}` : (h.version ? ` · Tuberr v${h.version}` : '')}
            {tuberr?.lastCheckAt ? ` · ${t('checked')} ${fmtAgo(tuberr.lastCheckAt)}` : ''}{tuberr?.lastWiringCheckAt ? ` · ${t('wiring checked')} ${fmtAgo(tuberr.lastWiringCheckAt)}` : ''}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn-admin" onClick={onRecheck} disabled={checkBusy} title={t('Probe the Tuberr process and Sonarr wiring now')}>
            {checkBusy ? t('Checking…') : t('Re-check now')}
          </button>
          <button className="btn-admin" onClick={onRefreshAll} disabled={refreshBusy} title={t('Refresh every channel and re-run auto-match')}>
            {refreshBusy ? t('Refreshing…') : t('Refresh all')}
          </button>
        </div>
      </div>

      {chips.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {chips.map((c, i) => <Chip key={i} {...c} />)}
        </div>
      )}

      {alerts.length > 0 && (
        <div style={{ marginBottom: 14, padding: '10px 14px', borderRadius: 8, border: `1px solid ${WARN}`, background: 'rgba(245,158,11,0.08)' }}>
          {alerts.map((a, i) => (
            <div key={i} style={{ fontSize: '0.82rem', padding: '2px 0' }}><Dot color={WARN} />{String(a)}</div>
          ))}
        </div>
      )}
      {status?.lastRefreshError && (
        <div style={{ marginBottom: 14, fontSize: '0.8rem', color: BAD }}>
          {t('Last refresh error')}: {String(status.lastRefreshError)}
        </div>
      )}

      <div className="admin-grid" style={{ marginBottom: 0 }}>
        <Stat label={t('Last refresh')} value={fmtAgo(status?.lastRefreshAt)}
          sub={status?.lastRefreshDurationMs ? `${t('took')} ${fmtDuration(status.lastRefreshDurationMs)}` : (status?.lastFastTickAt ? `${t('fast tick')} ${fmtAgo(status.lastFastTickAt)}` : null)} />
        <Stat label={t('Last grab')} value={fmtAgo(status?.lastGrabAt)} sub={status?.lastCompletedAt ? `${t('last completed')} ${fmtAgo(status.lastCompletedAt)}` : null} />
        <Stat label={t('Needs review')} value={status?.needsReview ?? '—'} sub={status?.mappings ? `${status.mappings.matched ?? 0} ${t('matched')} · ${status.mappings.partial ?? 0} ${t('partial')} · ${status.mappings.pending ?? 0} ${t('pending')}` : null} />
        <Stat label={t('Staging')} value={staging ? fmtBytes(staging.bytes) : '—'}
          sub={staging ? `${staging.dirs ?? 0} ${t('dirs')} · ${staging.completedRows ?? 0} ${t('completed rows')}${janitor?.lastRunAt ? ` · ${t('cleanup')} ${fmtAgo(janitor.lastRunAt)}` : ''}${janitor?.lastError ? ` · ${janitor.lastError}` : ''}` : null}
          action={(
            <button className="btn-admin" style={{ marginTop: 8, fontSize: '0.75rem' }} onClick={onRunJanitor} disabled={janitorBusy}
              title={t('Delete imported downloads from the staging folder')}>
              {janitorBusy ? t('Cleaning…') : t('Run cleanup')}
            </button>
          )} />
      </div>
    </div>
  )
}
