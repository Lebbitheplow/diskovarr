import React, { useState, useEffect, useCallback, useRef } from 'react'
import { tmdbApi, userApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'

// Plex ↔ Jellyfin account linking. Rendered only when the server has Jellyfin
// configured; signing in with either linked account then signs into both.
function MediaServerAccounts() {
  const { t } = useTranslation()
  const { success: toastSuccess, error: toastError } = useToast()
  const { user, isPlexLinked, checkAuth } = useAuth()
  const [links, setLinks] = useState(null)
  const [jfUsername, setJfUsername] = useState('')
  const [jfPassword, setJfPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await userApi.getAccountLinks()
      setLinks(data)
    } catch { setLinks(null) }
  }, [])

  useEffect(() => { load() }, [load])

  const handleLinkJellyfin = useCallback(async (e) => {
    e.preventDefault()
    if (!jfUsername || busy) return
    setBusy(true)
    try {
      const { data } = await userApi.linkJellyfin(jfUsername, jfPassword)
      toastSuccess(t('Linked Jellyfin account {{name}}', { name: data.jellyfinUsername || jfUsername }))
      setShowForm(false)
      setJfUsername('')
      setJfPassword('')
      await load()
    } catch (err) {
      toastError(err.message || t('Failed to link Jellyfin account'))
    } finally {
      setBusy(false)
    }
  }, [jfUsername, jfPassword, busy, load, toastSuccess, toastError, t])

  const handleUnlinkJellyfin = useCallback(async () => {
    setBusy(true)
    try {
      await userApi.unlinkJellyfin()
      toastSuccess(t('Jellyfin account unlinked'))
      await load()
    } catch (err) {
      toastError(err.message || t('Failed to unlink'))
    } finally {
      setBusy(false)
    }
  }, [load, toastSuccess, toastError, t])

  // Only a Jellyfin-signed-in session can drop its Plex link (the reverse is
  // handled by unlinkJellyfin). Re-check auth so isPlexLinked flips app-wide.
  const canUnlinkPlex = user?.provider === 'jellyfin' && isPlexLinked
  const handleUnlinkPlex = useCallback(async () => {
    if (!window.confirm(t('Unlink your Plex account? Signing in with Plex will no longer open this profile.'))) return
    setBusy(true)
    try {
      await userApi.unlinkPlex()
      toastSuccess(t('Plex account unlinked'))
      await Promise.all([load(), checkAuth()])
    } catch (err) {
      toastError(err.response?.data?.error || err.message || t('Failed to unlink'))
    } finally {
      setBusy(false)
    }
  }, [load, checkAuth, toastSuccess, toastError, t])

  // Jellyfin-identity users link Plex through the regular PIN flow with link=1
  const handleLinkPlex = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/auth/create-pin', { method: 'POST', signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error('PIN creation failed')
      const pin = await res.json()
      const appOrigin = window.location.origin
      window.location.href = 'https://app.plex.tv/auth#?clientID=diskovarr-app&code=' + pin.code
        + '&forwardUrl=' + encodeURIComponent(appOrigin + '/callback?link=1&pinId=' + pin.id + '&pinCode=' + encodeURIComponent(pin.code))
        + '&context%5Bdevice%5D%5Bproduct%5D=Diskovarr'
    } catch {
      toastError(t('Could not reach Plex. Please try again.'))
      setBusy(false)
    }
  }, [toastError, t])

  if (!links || !links.jellyfinEnabled) return null

  const cardStyle = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    padding: '24px',
    maxWidth: '520px',
    marginBottom: '20px',
  }

  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: '600', fontSize: '1rem', marginBottom: '4px' }}>{t('Media Server Accounts')}</div>
      <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
        {t('Link your Plex and Jellyfin accounts so signing in with either one signs you into both, with one combined watch profile.')}
      </p>

      {/* Plex row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', width: '80px' }}>Plex</div>
        {links.plex ? (
          <>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{links.plex.username}</span>
            {canUnlinkPlex && (
              <button className="btn-queue-delete" onClick={handleUnlinkPlex} disabled={busy}
                style={{ marginLeft: 'auto', fontSize: '0.8rem', padding: '6px 16px' }}>
                {t('Unlink')}
              </button>
            )}
          </>
        ) : (
          <>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('Not linked')}</span>
            {links.plexConfigured && (
              <button className="edit-modal-save" onClick={handleLinkPlex} disabled={busy}
                style={{ marginLeft: 'auto', fontSize: '0.8rem', padding: '6px 16px' }}>
                {busy ? t('Connecting...') : t('Sign in with Plex to link')}
              </button>
            )}
          </>
        )}
      </div>

      {/* Jellyfin row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', width: '80px' }}>Jellyfin</div>
        {links.jellyfin ? (
          <>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{links.jellyfin.username}</span>
            {links.jellyfin.linked && (
              <button className="btn-queue-delete" onClick={handleUnlinkJellyfin} disabled={busy}
                style={{ marginLeft: 'auto', fontSize: '0.8rem', padding: '6px 16px' }}>
                {t('Unlink')}
              </button>
            )}
          </>
        ) : !showForm ? (
          <>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('Not linked')}</span>
            <button className="edit-modal-save" onClick={() => setShowForm(true)}
              style={{ marginLeft: 'auto', fontSize: '0.8rem', padding: '6px 16px' }}>
              {t('Link account')}
            </button>
          </>
        ) : (
          <form onSubmit={handleLinkJellyfin} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', width: '100%', marginTop: '6px' }}>
            <input type="text" className="form-input" placeholder={t('Jellyfin username')} value={jfUsername}
              onChange={e => setJfUsername(e.target.value)} autoComplete="username" style={{ flex: '1 1 140px' }} />
            <input type="password" className="form-input" placeholder={t('Password')} value={jfPassword}
              onChange={e => setJfPassword(e.target.value)} autoComplete="current-password" style={{ flex: '1 1 140px' }} />
            <button type="submit" className="edit-modal-save" disabled={busy || !jfUsername}
              style={{ fontSize: '0.8rem', padding: '6px 16px' }}>
              {busy ? t('Linking...') : t('Link')}
            </button>
            <button type="button" className="edit-modal-cancel" onClick={() => setShowForm(false)}
              style={{ fontSize: '0.8rem', padding: '6px 16px' }}>
              {t('Cancel')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

function fmtDate(isoStr) {
  if (!isoStr) return 'Never'
  const d = new Date(isoStr)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtDateWithTime(isoStr) {
  if (!isoStr) return 'Never'
  const d = new Date(isoStr)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function ConnectedAccounts() {
  const { t } = useTranslation()
  const { success: toastSuccess, error: toastError } = useToast()
  const [connection, setConnection] = useState(null)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [disconnectConfirm, setDisconnectConfirm] = useState(false)
  const pollTimerRef = useRef(null)

  const loadConnection = useCallback(async () => {
    try {
      const { data } = await tmdbApi.getConnection()
      setConnection(data)
    } catch {
      setConnection({ connected: false })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    ;(async () => { await loadConnection() })()
  }, [loadConnection])

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const handleConnect = useCallback(async () => {
    setConnecting(true)
    stopPolling()
    try {
      const { data } = await tmdbApi.initiateConnect()
      const popup = window.open(data.authUrl, '_blank', 'width=600,height=700,scrollbars=yes')
      if (!popup || popup.closed) {
        toastError(t('Popup was blocked. Please allow popups and try again, or copy this URL: ') + data.authUrl)
        setConnecting(false)
        return
      }

      pollTimerRef.current = setInterval(async () => {
        if (popup?.closed) {
          stopPolling()
          try {
            const { data: conn } = await tmdbApi.getConnection()
            if (conn?.connected) {
              setConnection(conn)
              toastSuccess(t('Connected to TMDB!'))
            } else {
              toastError(t('Connection was cancelled or timed out'))
            }
            setConnecting(false)
          } catch {
            setConnecting(false)
          }
          return
        }
      }, 2000)

      setTimeout(() => {
        stopPolling()
        if (connecting) {
          popup?.close()
          setConnecting(false)
          toastError(t('Connection timed out. Please try again.'))
        }
      }, 120000)
    } catch (e) {
      toastError(e.message || t('Failed to initiate TMDB connection'))
      setConnecting(false)
    }
  }, [stopPolling, toastError, toastSuccess, connecting, t])

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true)
    try {
      await tmdbApi.disconnect()
      setConnection({ connected: false })
      setDisconnectConfirm(false)
      toastSuccess(t('Disconnected from TMDB'))
    } catch (e) {
      toastError(e.message || t('Failed to disconnect'))
    } finally {
      setDisconnecting(false)
    }
  }, [toastSuccess, toastError, t])

  const handleVerify = useCallback(async () => {
    setVerifying(true)
    try {
      await tmdbApi.verifySession()
      await loadConnection()
      toastSuccess(t('TMDB session verified'))
    } catch (e) {
      if (e.status === 401) {
        await loadConnection()
        toastError(t('TMDB session has expired. Please reconnect.'))
      } else {
        toastError(e.message || t('Verification failed'))
      }
    } finally {
      setVerifying(false)
    }
  }, [loadConnection, toastSuccess, toastError, t])

  if (loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        {t('Loading...')}
      </div>
    )
  }

  const { connected, status, accountId, connectedAt, lastVerifiedAt } = connection || {}

  return (
    <div className="settings-section">
      <p className="settings-section-title">{t('Connected Accounts')}</p>
      <p className="settings-desc" style={{ marginBottom: '20px' }}>
        Connect your TMDB account to sync your star ratings. Only your rating is sent &mdash; review text and watch date stay local.
      </p>

      <MediaServerAccounts />

      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '24px',
        maxWidth: '520px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '12px',
            background: 'linear-gradient(135deg, #01B4E4, #032535)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: '700', fontSize: '0.7rem', letterSpacing: '0.05em',
          }}>
            {t('TMDB')}
          </div>
          <div>
            <div style={{ fontWeight: '600', fontSize: '1rem' }}>{t('The Movie Database')}</div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              {connected
                ? status === 'needs_reconnect'
                  ? 'Session expired &mdash; reconnect required'
                  : 'Connected'
                : 'Not connected'}
            </div>
          </div>
          {connected && status !== 'needs_reconnect' && (
            <span style={{
              marginLeft: 'auto', padding: '3px 10px', borderRadius: '20px',
              background: 'rgba(104,211,145,0.12)', color: '#68d791',
              fontSize: '0.72rem', fontWeight: '600',
            }}>
              {t('Active')}
            </span>
          )}
          {connected && status === 'needs_reconnect' && (
            <span style={{
              marginLeft: 'auto', padding: '3px 10px', borderRadius: '20px',
              background: 'rgba(251,191,36,0.12)', color: '#fbbf24',
              fontSize: '0.72rem', fontWeight: '600',
            }}>
              {t('Needs Reconnect')}
            </span>
          )}
        </div>

        {connected && (status !== 'needs_reconnect') && (
          <div style={{
            borderTop: '1px solid var(--border)', paddingTop: '16px', marginBottom: '16px',
            fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'grid',
            gridTemplateColumns: '1fr 1fr', gap: '8px 24px',
          }}>
            <div><span style={{ color: 'var(--text-muted)' }}>{t('Account ID:')}</span> {accountId}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>{t('Connected:')}</span> {fmtDate(connectedAt)}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>{t('Last verified:')}</span> {fmtDateWithTime(lastVerifiedAt)}</div>
          </div>
        )}

        {connected && status === 'needs_reconnect' && (
          <div style={{
            background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
            borderRadius: '8px', padding: '12px 16px', marginBottom: '16px',
            fontSize: '0.82rem', color: '#fbbf24',
          }}>
            {t('Your TMDB session has expired or been revoked. Reconnect to continue syncing ratings.')}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {!connected ? (
            <button
              className="edit-modal-save"
              onClick={handleConnect}
              disabled={connecting}
              style={{ fontSize: '0.85rem', padding: '8px 20px' }}
            >
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          ) : status === 'needs_reconnect' ? (
            <button
              className="edit-modal-save"
              onClick={handleConnect}
              disabled={connecting}
              style={{ fontSize: '0.85rem', padding: '8px 20px' }}
            >
              {connecting ? 'Reconnecting...' : 'Reconnect'}
            </button>
          ) : (
            <>
              <button
                className="edit-modal-cancel"
                onClick={handleVerify}
                disabled={verifying}
                style={{ fontSize: '0.85rem', padding: '8px 20px' }}
              >
                {verifying ? 'Verifying...' : 'Verify'}
              </button>
              {!disconnectConfirm ? (
                <button
                  className="btn-queue-delete"
                  onClick={() => setDisconnectConfirm(true)}
                  style={{ fontSize: '0.85rem', padding: '8px 20px' }}
                >
                  {t('Disconnect')}
                </button>
              ) : (
                <>
                  <button
                    className="edit-modal-cancel"
                    onClick={() => setDisconnectConfirm(false)}
                    style={{ fontSize: '0.85rem', padding: '8px 20px' }}
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    className="btn-queue-delete"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    style={{ fontSize: '0.85rem', padding: '8px 20px' }}
                  >
                    {disconnecting ? 'Disconnecting...' : 'Confirm'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
