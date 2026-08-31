import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'

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

const PLEX_ICON = (
  <svg className="plex-icon" viewBox="0 0 24 24" fill="currentColor">
    <path d="M11.97 0C5.356 0 0 5.357 0 11.97c0 6.615 5.357 11.97 11.97 11.97 6.614 0 11.97-5.356 11.97-11.97C23.94 5.356 18.583 0 11.97 0zm.581 17.725H9.847V6.275h2.704l4.597 7.096V6.275h2.704v11.45h-2.704l-4.597-7.097v7.097z" />
  </svg>
)

const NUM_COLS = 7

// px/s for each column — alternating direction via negative speed
const COL_SPEEDS = [38, -28, 32, -42, 26, -36, 30]

function seededShuffle(arr, seed) {
  let s = seed
  const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Single scrolling column — JS rAF driven so loop point is exact
const PosterCol = memo(function PosterCol({ posters, speed }) {
  const colRef = useRef(null)
  const yRef = useRef(0)
  const rafRef = useRef(null)
  const lastTsRef = useRef(null)

  // Duplicate posters for seamless wrap
  const items = useMemo(() => [...posters, ...posters], [posters])

  useEffect(() => {
    const col = colRef.current
    if (!col || !items.length) return

    function tick(ts) {
      if (lastTsRef.current === null) lastTsRef.current = ts
      const delta = Math.min(ts - lastTsRef.current, 50) // cap at 50ms to handle tab backgrounding
      lastTsRef.current = ts

      const halfH = col.scrollHeight / 2
      if (halfH <= 0) { rafRef.current = requestAnimationFrame(tick); return }

      yRef.current += (speed / 1000) * delta

      // Seamless wrap using measured half-height
      if (yRef.current > halfH)  yRef.current -= halfH
      if (yRef.current < 0)      yRef.current += halfH

      col.style.transform = `translateY(${-yRef.current}px)`
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.current)
      lastTsRef.current = null
    }
  }, [speed, items])

  return (
    <div ref={colRef} className="poster-col">
      {items.map((poster, i) => (
        <div key={i} className="poster-col-item">
          <img src={poster.url} alt="" draggable={false} />
        </div>
      ))}
    </div>
  )
})

const PosterBackground = memo(function PosterBackground({ posters }) {
  const columns = useMemo(() => {
    if (!posters.length) return []
    const shuffled = seededShuffle(posters, 42)
    const perCol = Math.ceil(shuffled.length / NUM_COLS)
    return Array.from({ length: NUM_COLS }, (_, i) =>
      shuffled.slice(i * perCol, (i + 1) * perCol)
    ).filter(col => col.length > 0)
  }, [posters])

  if (!columns.length) return null

  return (
    <div className="poster-background" aria-hidden="true">
      <div className="poster-columns">
        {columns.map((col, ci) => (
          <PosterCol key={ci} posters={col} speed={COL_SPEEDS[ci] ?? 30} />
        ))}
      </div>
      <div className="poster-overlay" />
    </div>
  )
})

const JELLYFIN_ICON = (
  <svg className="plex-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 3.5c-.9 0-3.4 3.2-7.6 10.1-1.1 1.8-1.6 2.9-1.3 3.4.6 1 2.4-.1 4.6-.1 2.1 0 3.1 1.1 4.3 1.1s2.2-1.1 4.3-1.1c2.2 0 4 .1 4.6.1.3-.5-.2-1.6-1.3-3.4C15.4 6.7 12.9 3.5 12 3.5zm0 5.1c.5 0 1.7 1.6 3.7 4.9.5.9.8 1.4.6 1.7-.3.5-1.2-.1-2.2-.1-1 0-1.5.6-2.1.6s-1.1-.6-2.1-.6c-1 0-1.9.6-2.2.1-.2-.3.1-.8.6-1.7 2-3.3 3.2-4.9 3.7-4.9z" />
  </svg>
)

export default function Login() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [posters, setPosters] = useState([])
  const [providers, setProviders] = useState({ plex: true, jellyfin: false })
  const [showJellyfin, setShowJellyfin] = useState(false)
  const [jfUsername, setJfUsername] = useState('')
  const [jfPassword, setJfPassword] = useState('')
  const [jfLoading, setJfLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/login/posters', { signal: AbortSignal.timeout(15000) })
      .then(res => res.json())
      .then(data => { if (!cancelled) setPosters(data.posters || []) })
      .catch(err => { if (err.name !== 'AbortError') console.warn('Failed to load login posters:', err.message) })
    fetch('/auth/providers', { signal: AbortSignal.timeout(10000) })
      .then(res => res.json())
      .then(data => {
        if (!cancelled && data) {
          setProviders({ plex: data.plex !== false, jellyfin: !!data.jellyfin })
          if (data.plex === false && data.jellyfin) setShowJellyfin(true)
        }
      })
      .catch(() => { /* default to Plex-only */ })
    return () => { cancelled = true }
  }, [])

  const handleJellyfinLogin = useCallback(async (e) => {
    e.preventDefault()
    if (!jfUsername || jfLoading) return
    setJfLoading(true)
    setError(null)
    try {
      const res = await fetch('/auth/jellyfin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: jfUsername, password: jfPassword }),
        signal: AbortSignal.timeout(20000),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.status === 'authorized') {
        // Full reload so AuthProvider re-checks the fresh session
        window.location.assign(data.landingUrl || '/')
        return
      }
      setJfLoading(false)
      setError(res.status === 401 ? 'jellyfin_invalid' : 'jellyfin_unreachable')
    } catch {
      setJfLoading(false)
      setError('jellyfin_unreachable')
    }
  }, [jfUsername, jfPassword, jfLoading])

  const handlePlexLogin = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/auth/create-pin', { method: 'POST', signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`PIN creation failed: ${res.status}`)
      const pin = await res.json()

      const appOrigin = window.location.origin
      const authUrl = 'https://app.plex.tv/auth#?clientID=diskovarr-app&code=' + pin.code
        + '&forwardUrl=' + encodeURIComponent(appOrigin + '/callback?pinId=' + pin.id + '&pinCode=' + encodeURIComponent(pin.code))
        + '&context%5Bdevice%5D%5Bproduct%5D=Diskovarr'

      window.location.href = authUrl
      setTimeout(() => { setLoading(false); setError('plex_unreachable') }, 10000)
    } catch (e) {
      setLoading(false)
      setError('plex_unreachable')
    }
  }, [])

  return (
    <div className="login-body">
      <PosterBackground posters={posters} />
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">
            <span className="logo-icon">{LOGO_SVG}</span>
            <span className="logo-text">Diskovarr</span>
          </div>
          <p className="login-tagline">
            {providers.jellyfin ? t('Your library. Personalized.') : t('Your Plex. Personalized.')}
          </p>
          <p className="login-description">
            {providers.plex && providers.jellyfin
              ? t('Sign in with your Plex or Jellyfin account to get personalized recommendations based on your watch history.')
              : providers.jellyfin
                ? t('Sign in with your Jellyfin account to get personalized recommendations based on your watch history.')
                : t('Sign in with your Plex account to get personalized recommendations based on your watch history.')}
          </p>
          {error === 'plex_unreachable' && (
            <div className="error-banner">{t('Could not reach Plex. Please try again.')}</div>
          )}
          {error === 'no_access' && (
            <div className="error-banner">{t("Your account doesn't have access to this Plex server.")}</div>
          )}
          {error === 'jellyfin_invalid' && (
            <div className="error-banner">{t('Invalid Jellyfin username or password.')}</div>
          )}
          {error === 'jellyfin_unreachable' && (
            <div className="error-banner">{t('Could not reach Jellyfin. Please try again.')}</div>
          )}
          {providers.plex && (
            <button className="btn-plex" onClick={handlePlexLogin} disabled={loading}>
              {PLEX_ICON}
              <span>{loading ? t('Connecting...') : t('Sign in with Plex')}</span>
            </button>
          )}
          {providers.jellyfin && !showJellyfin && (
            <button
              className="btn-plex btn-jellyfin"
              style={{ marginTop: providers.plex ? '0.6rem' : 0 }}
              onClick={() => setShowJellyfin(true)}
            >
              {JELLYFIN_ICON}
              <span>{t('Sign in with Jellyfin')}</span>
            </button>
          )}
          {providers.jellyfin && showJellyfin && (
            <form className="jellyfin-login-form" onSubmit={handleJellyfinLogin} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: providers.plex ? '0.6rem' : 0 }}>
              <input
                type="text"
                className="form-input"
                placeholder={t('Jellyfin username')}
                value={jfUsername}
                onChange={e => setJfUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
              <input
                type="password"
                className="form-input"
                placeholder={t('Password')}
                value={jfPassword}
                onChange={e => setJfPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button type="submit" className="btn-plex btn-jellyfin" disabled={jfLoading || !jfUsername}>
                {JELLYFIN_ICON}
                <span>{jfLoading ? t('Connecting...') : t('Sign in with Jellyfin')}</span>
              </button>
            </form>
          )}
          <p className="login-footer">
            {t('Recommendations are built from your personal watch history.')}<br />
            {t('No data is shared or stored externally.')}
          </p>
        </div>
      </div>
    </div>
  )
}
