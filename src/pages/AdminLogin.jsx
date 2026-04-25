import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const LOGO_SVG = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">
    <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="currentColor" />
    <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="currentColor" />
    <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="currentColor" />
    <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="currentColor" />
    <circle cx="15" cy="9" r="5" stroke="currentColor" strokeWidth="2" />
    <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
)

export default function AdminLogin() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      })
      const data = await res.json()
      if (data.ok) {
        navigate('/admin', { replace: true })
      } else {
        setError(data.error || 'Incorrect password')
      }
    } catch {
      setError('Login failed — please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="admin-login-body">
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">
            <span className="logo-icon">{LOGO_SVG}</span>
            <span className="logo-text">Diskovarr</span>
            <span className="admin-badge">admin</span>
          </div>
          <p className="login-tagline">Admin Access</p>

          {error && <div className="error-banner">{error}</div>}

          <form onSubmit={handleSubmit} className="admin-login-form">
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                type="password"
                id="password"
                name="password"
                className="form-input"
                placeholder="Enter admin password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-plex" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <p className="login-footer">
            <a href="/" style={{ color: 'var(--text-muted)' }}>← Back to Diskovarr</a>
          </p>
        </div>
      </div>
    </div>
  )
}
