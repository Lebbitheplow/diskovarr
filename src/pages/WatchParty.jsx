import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { watchPartyApi, libraryApi, movieNightApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'
import { posterUrl } from '../utils/media'

// Watch Together party page: a lobby where each member picks the TV they are
// watching on, then a live view of how in-sync everyone is. The syncing itself
// runs on the server — this page can be closed once playback starts.

function formatTime(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s % 60).padStart(2, '0')
}

function Avatar({ src, name }) {
  if (src) return <img className="mn-avatar" src={posterUrl(src)} alt="" />
  return <span className="mn-avatar">{(name || '?')[0].toUpperCase()}</span>
}

function MemberStatus({ member, started }) {
  const { t } = useTranslation()
  const p = member.playback
  if (started) {
    if (!p || !p.active) return <span className="wp-status muted">{member.status === 'declined' ? t('Declined') : t('Not watching')}</span>
    if (p.unsynced) return <span className="wp-status warn">{t('Not responding to sync')}</span>
    if (p.state === 'syncing') return <span className="wp-status warn">{t('Catching up…')}</span>
    if (p.state === 'waiting' || p.time == null) return <span className="wp-status muted">{t('Connecting…')}</span>
    const off = Math.round((p.offsetMs || 0) / 1000)
    return (
      <span className={'wp-status ' + (Math.abs(off) <= 2 ? 'good' : 'warn')}>
        {p.state === 'buffering' ? t('Buffering') : p.state === 'paused' ? t('Paused') : t('Playing')} · {formatTime(p.time)}
        {Math.abs(off) > 2 && ` · ${off > 0 ? '+' : ''}${off}s`}
      </span>
    )
  }
  if (member.status === 'ready') return <span className="wp-status good">{t('Ready')} · {member.deviceName}</span>
  if (member.status === 'declined') return <span className="wp-status muted">{t('Declined')}</span>
  return <span className="wp-status muted">{t('Invited')}</span>
}

function DevicePicker({ partyId, source, appName, current, onChanged }) {
  const { t } = useTranslation()
  const { error: toastError } = useToast()
  const [clients, setClients] = useState(null)
  const [savingId, setSavingId] = useState(null)

  const load = useCallback(async () => {
    setClients(null)
    try {
      const { data } = await libraryApi.getClients()
      setClients((data.clients || []).filter(c => (c.source || 'plex') === source))
    } catch {
      setClients([])
    }
  }, [source])
  useEffect(() => { (async () => { await load() })() }, [load])

  const choose = async (client) => {
    setSavingId(client.machineIdentifier)
    try {
      const { data } = await watchPartyApi.setDevice(partyId, client.machineIdentifier)
      onChanged(data.party)
    } catch (e) {
      toastError(e.response?.data?.error || e.message)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="wp-devices">
      {clients == null && <span className="mn-field-hint">{t('Looking for your devices…')}</span>}
      {clients?.length === 0 && (
        <span className="mn-field-hint">{t('No devices found. Open the {{app}} app on your TV, then refresh.', { app: appName })}</span>
      )}
      {(clients || []).map(c => (
        <button key={c.machineIdentifier} className={'cast-client-btn' + (current === c.name ? ' wp-device-current' : '')}
          onClick={() => choose(c)} disabled={!!savingId}>
          {savingId === c.machineIdentifier ? t('Checking…') : (current === c.name ? '✓ ' : '') + c.name + (c.product ? ' · ' + c.product : '')}
        </button>
      ))}
      <button className="mn-link-btn" onClick={load} disabled={clients == null}>↻ {t('Refresh')}</button>
    </div>
  )
}

function InviteMore({ party, onChanged }) {
  const { t } = useTranslation()
  const { error: toastError } = useToast()
  const [users, setUsers] = useState(null)

  const open = async () => {
    try {
      const { data } = await movieNightApi.getMemberCandidates()
      const taken = new Set(party.members.map(m => m.userId))
      setUsers((data.users || []).filter(u => !taken.has(String(u.user_id))))
    } catch {
      setUsers([])
    }
  }
  const invite = async (userId) => {
    try {
      const { data } = await watchPartyApi.invite(party.id, [userId])
      onChanged(data.party)
      setUsers(prev => prev.filter(u => u.user_id !== userId))
    } catch (e) {
      toastError(e.response?.data?.error || e.message)
    }
  }

  if (users == null) return <button className="mn-link-btn" onClick={open}>+ {t('Invite someone')}</button>
  if (!users.length) return <span className="mn-field-hint">{t('Everyone is already invited.')}</span>
  return (
    <div className="mn-chips-row">
      {users.map(u => (
        <button key={u.user_id} className="mn-chip wp-invite-chip" onClick={() => invite(u.user_id)}>
          <Avatar src={u.thumb} name={u.username} /> {u.username || u.user_id} +
        </button>
      ))}
    </div>
  )
}

export default function WatchParty() {
  const { id } = useParams()
  const { t } = useTranslation()
  const { user } = useAuth()
  const { error: toastError } = useToast()
  const [party, setParty] = useState(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(null)
  const statusRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const { data } = await watchPartyApi.get(id)
      statusRef.current = data.party.status
      setParty(data.party)
    } catch (e) {
      if (e.response?.status === 404 || e.response?.status === 403) setMissing(true)
    }
  }, [id])

  // Poll faster while playing; an ended party never changes again.
  useEffect(() => {
    let timer
    let cancelled = false
    const loop = async () => {
      await refresh()
      if (cancelled || statusRef.current === 'ended') return
      timer = setTimeout(loop, statusRef.current === 'lobby' ? 4000 : 2000)
    }
    loop()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [refresh])

  const run = async (name, fn) => {
    setBusy(name)
    try {
      const { data } = await fn()
      if (data?.party) { statusRef.current = data.party.status; setParty(data.party) }
    } catch (e) {
      toastError(e.response?.data?.error || e.message)
    } finally {
      setBusy(null)
    }
  }

  if (missing) return <div className="mn-page"><div className="mn-empty">{t('This watch party does not exist, or you were not invited.')}</div></div>
  if (!party) return <div className="mn-page"><div className="mn-empty">{t('Loading...')}</div></div>

  const me = party.members.find(m => m.userId === String(user?.id))
  const host = party.members.find(m => m.role === 'host')
  const lobby = party.status === 'lobby'
  const started = party.status === 'playing'
  const starting = party.status === 'starting' || busy === 'start'
  const readyCount = party.members.filter(m => m.status === 'ready').length
  const paused = party.playback?.state === 'paused'
  const watching = !!me?.playback?.active
  const appName = party.source === 'jellyfin' ? 'Jellyfin' : 'Plex'

  return (
    <div className="mn-page wp-page">
      <div style={{ marginBottom: 8 }}><Link to="/movie-night" style={{ color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '0.85rem' }}>← {t('Movie Night')}</Link></div>

      <div className="mn-detail-hero">
        {party.thumb && <img className="wp-poster" src={posterUrl(party.thumb)} alt="" />}
        <div className="mn-detail-hero-main">
          <h1>{party.title}</h1>
          <div className="mn-detail-hero-meta">
            {party.subtitle && <span>{party.subtitle}</span>}
            <span className="mn-badge mn-host">
              {party.status === 'ended' ? t('Ended') : starting ? t('Starting…') : started ? (paused ? t('Paused') : t('Playing')) : t('Waiting to start')}
            </span>
          </div>
          {started && (
            <div className="wp-progress-wrap">
              <div className="wp-clock">{formatTime(party.playback.position)}{party.durationMs ? ` / ${formatTime(party.durationMs)}` : ''}</div>
              {party.durationMs > 0 && (
                <div className="wp-progress"><div style={{ width: `${Math.min(100, (party.playback.position / party.durationMs) * 100)}%` }} /></div>
              )}
            </div>
          )}
          <div className="wp-actions">
            {lobby && party.isHost && (
              <button className="mn-btn-primary" onClick={() => run('start', () => watchPartyApi.start(party.id))} disabled={!!busy || me?.status !== 'ready'}>
                {starting ? t('Starting…') : readyCount > 1 ? t('Start for {{count}} TVs', { count: readyCount }) : t('Start')}
              </button>
            )}
            {started && (
              <button className="mn-btn-primary" onClick={() => run('control', () => watchPartyApi.control(party.id, paused ? 'play' : 'pause'))} disabled={!!busy}>
                {paused ? t('Resume everyone') : t('Pause everyone')}
              </button>
            )}
            {started && !watching && me?.status === 'ready' && (
              <button className="btn-page" onClick={() => run('join', () => watchPartyApi.join(party.id))} disabled={!!busy}>
                {busy === 'join' ? t('Joining…') : t('Join on my TV')}
              </button>
            )}
            {party.isHost && party.status !== 'ended' && (
              <button className="btn-page" onClick={() => run('end', () => watchPartyApi.end(party.id))} disabled={!!busy}>{t('End party')}</button>
            )}
          </div>
          {lobby && party.isHost && me?.status !== 'ready' && <p className="mn-field-hint">{t('Pick your TV below to enable Start.')}</p>}
          {lobby && !party.isHost && <p className="mn-field-hint">{t('{{name}} will start the party once everyone is ready.', { name: host?.username })}</p>}
          {starting && <p className="mn-field-hint">{t('Loading the title on every TV — this can take up to half a minute.')}</p>}
          {started && <p className="mn-field-hint">{t('You can close this page. Pausing or skipping with any TV remote carries over to everyone.')}</p>}
          {party.status === 'ended' && <p className="mn-field-hint">{t('Syncing has stopped. Anything still playing keeps playing.')}</p>}
        </div>
      </div>

      <div className="mn-sections">
        {party.status !== 'ended' && !(started && watching) && (
          <section className="mn-section">
            <h2>📺 {t('Your TV')}</h2>
            <p className="mn-field-hint" style={{ marginBottom: 8 }}>{t('Open the {{app}} app on the TV you are watching on, then choose it here.', { app: appName })}</p>
            <DevicePicker partyId={party.id} source={party.source} appName={appName} current={me?.status === 'ready' ? me.deviceName : null} onChanged={setParty} />
          </section>
        )}

        <section className="mn-section">
          <h2>👥 {t("Who's watching")} <span className="mn-count">({party.members.length})</span></h2>
          <div className="wp-members">
            {party.members.map(m => (
              <div key={m.userId} className="wp-member">
                <Avatar src={m.avatar} name={m.username} />
                <span className="wp-member-name">{m.username}</span>
                {m.role === 'host' && <span className="mn-badge mn-host">{t('Host')}</span>}
                <MemberStatus member={m} started={started} />
              </div>
            ))}
          </div>
          {party.isHost && party.status !== 'ended' && <div style={{ marginTop: 10 }}><InviteMore party={party} onChanged={setParty} /></div>}
          {lobby && !party.isHost && me?.status !== 'declined' && (
            <button className="mn-link-btn danger" style={{ marginTop: 10 }} onClick={() => run('decline', async () => { await watchPartyApi.decline(party.id); return watchPartyApi.get(party.id) })}>
              {t("I can't make it")}
            </button>
          )}
        </section>

        {party.log.length > 0 && (
          <section className="mn-section">
            <h2>🕑 {t('Activity')}</h2>
            <ul className="wp-log">
              {party.log.map((entry, i) => (
                <li key={`${entry.at}-${i}`}>
                  <time>{new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time> {entry.text}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
