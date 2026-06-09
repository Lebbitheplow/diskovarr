import React, { useState, useEffect, useCallback, useRef } from 'react'
import { tmdbApi } from '../services/api'
import { useToast } from '../context/ToastContext'

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
        toastError('Popup was blocked. Please allow popups and try again, or copy this URL: ' + data.authUrl)
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
              toastSuccess('Connected to TMDB!')
            } else {
              toastError('Connection was cancelled or timed out')
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
          toastError('Connection timed out. Please try again.')
        }
      }, 120000)
    } catch (e) {
      toastError(e.message || 'Failed to initiate TMDB connection')
      setConnecting(false)
    }
  }, [stopPolling, toastError, toastSuccess, connecting])

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true)
    try {
      await tmdbApi.disconnect()
      setConnection({ connected: false })
      setDisconnectConfirm(false)
      toastSuccess('Disconnected from TMDB')
    } catch (e) {
      toastError(e.message || 'Failed to disconnect')
    } finally {
      setDisconnecting(false)
    }
  }, [toastSuccess, toastError])

  const handleVerify = useCallback(async () => {
    setVerifying(true)
    try {
      await tmdbApi.verifySession()
      await loadConnection()
      toastSuccess('TMDB session verified')
    } catch (e) {
      if (e.status === 401) {
        await loadConnection()
        toastError('TMDB session has expired. Please reconnect.')
      } else {
        toastError(e.message || 'Verification failed')
      }
    } finally {
      setVerifying(false)
    }
  }, [loadConnection, toastSuccess, toastError])

  if (loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
        Loading...
      </div>
    )
  }

  const { connected, status, accountId, connectedAt, lastVerifiedAt } = connection || {}

  return (
    <div className="settings-section">
      <p className="settings-section-title">Connected Accounts</p>
      <p className="settings-desc" style={{ marginBottom: '20px' }}>
        Connect your TMDB account to sync your star ratings. Only your rating is sent &mdash; review text and watch date stay local.
      </p>

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
            TMDB
          </div>
          <div>
            <div style={{ fontWeight: '600', fontSize: '1rem' }}>The Movie Database</div>
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
              Active
            </span>
          )}
          {connected && status === 'needs_reconnect' && (
            <span style={{
              marginLeft: 'auto', padding: '3px 10px', borderRadius: '20px',
              background: 'rgba(251,191,36,0.12)', color: '#fbbf24',
              fontSize: '0.72rem', fontWeight: '600',
            }}>
              Needs Reconnect
            </span>
          )}
        </div>

        {connected && (status !== 'needs_reconnect') && (
          <div style={{
            borderTop: '1px solid var(--border)', paddingTop: '16px', marginBottom: '16px',
            fontSize: '0.82rem', color: 'var(--text-secondary)', display: 'grid',
            gridTemplateColumns: '1fr 1fr', gap: '8px 24px',
          }}>
            <div><span style={{ color: 'var(--text-muted)' }}>Account ID:</span> {accountId}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>Connected:</span> {fmtDate(connectedAt)}</div>
            <div><span style={{ color: 'var(--text-muted)' }}>Last verified:</span> {fmtDateWithTime(lastVerifiedAt)}</div>
          </div>
        )}

        {connected && status === 'needs_reconnect' && (
          <div style={{
            background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
            borderRadius: '8px', padding: '12px 16px', marginBottom: '16px',
            fontSize: '0.82rem', color: '#fbbf24',
          }}>
            Your TMDB session has expired or been revoked. Reconnect to continue syncing ratings.
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
                  Disconnect
                </button>
              ) : (
                <>
                  <button
                    className="edit-modal-cancel"
                    onClick={() => setDisconnectConfirm(false)}
                    style={{ fontSize: '0.85rem', padding: '8px 20px' }}
                  >
                    Cancel
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
