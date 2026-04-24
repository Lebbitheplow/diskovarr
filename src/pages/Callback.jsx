import React, { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { authApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'

export default function Callback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { error: toastError } = useToast()
  const { checkAuth } = useAuth()
  const [status, setStatus] = useState('connecting')

  const handleAuth = useCallback(async () => {
    const pinId = searchParams.get('pinId')
    const pinCode = searchParams.get('pinCode')

    if (!pinId || !pinCode) {
      toastError('Missing authentication parameters')
      navigate('/login', { replace: true })
      return
    }

    setStatus('waiting')

    // Store the pin in the session via XHR so the session cookie used here matches the one check-pin will use
    try {
      await authApi.callback({ pinId, pinCode })
    } catch { /* session may already be set server-side, continue */ }

    // Poll /auth/check-pin every 2 seconds
    const pollInterval = setInterval(async () => {
      try {
        const { data } = await authApi.checkPin()
        if (data.status === 'authorized') {
          clearInterval(pollInterval)
          setStatus('redirecting')
          await checkAuth()
          navigate(data.landingUrl || '/', { replace: true })
        } else if (data.status === 'expired' || data.status === 'no_access' || data.status === 'error') {
          clearInterval(pollInterval)
          if (data.status === 'no_access') {
            toastError('Your account does not have access to this Plex server')
          } else {
            toastError('Authentication failed or expired')
          }
          navigate('/login', { replace: true })
        }
      } catch {
        // Keep polling on error
      }
    }, 2000)

    // Timeout after 3 minutes
    setTimeout(() => {
      clearInterval(pollInterval)
      toastError('Authentication timed out')
      navigate('/login', { replace: true })
    }, 180000)
  }, [searchParams, navigate, toastError, checkAuth])

  useEffect(() => {
    handleAuth()
  }, [handleAuth])

  return (
    <div className="login-body">
      <div className="login-container">
        <div className="login-card" style={{ textAlign: 'center', padding: '48px' }}>
          <div className="login-logo" style={{ marginBottom: '16px' }}>
            <span className="logo-icon">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">
                <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="currentColor" />
                <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="currentColor" />
                <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="currentColor" />
                <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="currentColor" />
                <circle cx="15" cy="9" r="5" stroke="currentColor" strokeWidth="2" />
                <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            </span>
            <span className="logo-text">Diskovarr</span>
          </div>
          <p className="login-tagline">
            {status === 'connecting' && 'Connecting to Plex...'}
            {status === 'waiting' && 'Waiting for authorization in the Plex window'}
            {status === 'redirecting' && 'Authenticating...'}
          </p>
          <div className="spinner" style={{ margin: '24px auto', width: '32px', height: '32px' }} />
        </div>
      </div>
    </div>
  )
}
