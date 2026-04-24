import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react'

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

export default function Login() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [posters, setPosters] = useState([])

  useEffect(() => {
    let cancelled = false
    fetch('/api/login/posters', { signal: AbortSignal.timeout(15000) })
      .then(res => res.json())
      .then(data => { if (!cancelled) setPosters(data.posters || []) })
      .catch(err => { if (err.name !== 'AbortError') console.warn('Failed to load login posters:', err.message) })
    return () => { cancelled = true }
  }, [])

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
          <p className="login-tagline">Your Plex. Personalized.</p>
          <p className="login-description">
            Sign in with your Plex account to get personalized recommendations based on your watch history.
          </p>
          {error === 'plex_unreachable' && (
            <div className="error-banner">Could not reach Plex. Please try again.</div>
          )}
          {error === 'no_access' && (
            <div className="error-banner">Your account doesn't have access to this Plex server.</div>
          )}
          <button className="btn-plex" onClick={handlePlexLogin} disabled={loading}>
            {PLEX_ICON}
            <span>{loading ? 'Connecting...' : 'Sign in with Plex'}</span>
          </button>
          <p className="login-footer">
            Recommendations are built from your personal watch history.<br />
            No data is shared or stored externally.
          </p>
        </div>
      </div>
    </div>
  )
}
