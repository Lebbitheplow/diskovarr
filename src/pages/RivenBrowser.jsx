import React, { useState, useEffect, useRef, useCallback } from 'react'
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

export default function RivenBrowser() {
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selected, setSelected] = useState(null)
  const [seasons, setSeasons] = useState([])
  const [curSeason, setCurSeason] = useState(1)
  const [dmmUrl, setDmmUrl] = useState('')
  const [pasteValue, setPasteValue] = useState('')
  const [pasteStatus, setPasteStatus] = useState({ text: '', type: '' })
  const [toast, setToast] = useState({ text: '', type: '', visible: false })
  const [loadingItem, setLoadingItem] = useState(false)

  const searchWrapRef = useRef(null)
  const suggestTimeoutRef = useRef(null)
  const pasteInputRef = useRef(null)
  const pasteStatusTimeoutRef = useRef(null)
  const toastTimeoutRef = useRef(null)

  const showToast = useCallback((text, type = '') => {
    setToast({ text, type, visible: true })
    clearTimeout(toastTimeoutRef.current)
    toastTimeoutRef.current = setTimeout(() => setToast(prev => ({ ...prev, visible: false })), 3800)
  }, [])

  // Close suggestions on outside click
  useEffect(() => {
    function handleClick(e) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  // Global paste handler (Ctrl+V outside inputs — forwards to magnet handler)
  useEffect(() => {
    function handleGlobalPaste(e) {
      const active = document.activeElement
      if (active && active === pasteInputRef.current) return
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      if (!selected?.imdbId) return
      const text = (e.clipboardData || window.clipboardData).getData('text').trim()
      if (text.startsWith('magnet:')) {
        e.preventDefault()
        setPasteValue(text)
        doAddMagnet(text, selected)
      }
    }
    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchSuggestions = useCallback(async (q) => {
    try {
      const res = await fetch('/admin/riven/tmdb/search?q=' + encodeURIComponent(q))
      const data = await res.json()
      setSuggestions(data.results || [])
      setShowSuggestions(true)
    } catch {
      setShowSuggestions(false)
    }
  }, [])

  const handleSearchChange = useCallback((e) => {
    const q = e.target.value
    setQuery(q)
    clearTimeout(suggestTimeoutRef.current)
    if (q.length < 2) { setShowSuggestions(false); return }
    suggestTimeoutRef.current = setTimeout(() => fetchSuggestions(q), 280)
  }, [fetchSuggestions])

  const handleSearchKeyDown = useCallback((e) => {
    if (e.key === 'Escape') setShowSuggestions(false)
  }, [])

  const handleSelectItem = useCallback(async (item) => {
    setShowSuggestions(false)
    setQuery('')
    setLoadingItem(true)

    let imdbId = null
    try {
      const res = await fetch(`/admin/riven/tmdb/imdb-id?tmdbId=${item.tmdbId}&mediaType=${item.mediaType}`)
      const data = await res.json()
      imdbId = data.imdbId || null
    } catch { /* ignore */ }

    if (!imdbId) {
      showToast('No IMDB ID found for this title', 'error')
      setLoadingItem(false)
      return
    }

    const sel = { ...item, imdbId }

    let newSeasons = []
    let newCurSeason = 1
    if (item.mediaType === 'tv') {
      try {
        const res = await fetch(`/admin/riven/tmdb/seasons?tmdbId=${item.tmdbId}`)
        const data = await res.json()
        newSeasons = data.seasons || []
      } catch { /* ignore */ }
    }

    setSelected(sel)
    setSeasons(newSeasons)
    setCurSeason(newCurSeason)
    setDmmUrl(`https://debridmediamanager.com/x/${imdbId}/`)
    setLoadingItem(false)

    setTimeout(() => pasteInputRef.current?.focus(), 300)
  }, [showToast])

  const clearSelection = useCallback(() => {
    setSelected(null)
    setSeasons([])
    setCurSeason(1)
    setDmmUrl('')
    setQuery('')
    setPasteValue('')
    setPasteStatus({ text: '', type: '' })
  }, [])

  const handleReloadDMM = useCallback(() => {
    if (!selected?.imdbId) return
    setDmmUrl('')
    setTimeout(() => setDmmUrl(`https://debridmediamanager.com/x/${selected.imdbId}/`), 50)
  }, [selected])

  const doAddMagnet = useCallback(async (magnet, sel) => {
    if (!sel?.imdbId) { showToast('Select a title first', 'error'); return }
    setPasteStatus({ text: 'Adding to Riven…', type: '' })

    try {
      const body = { imdbId: sel.imdbId, mediaType: sel.mediaType, magnet }
      if (sel.mediaType === 'tv') body.season = curSeason
      const res = await fetch('/admin/riven/torrents/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      setPasteStatus({ text: '✓ Added to Riven', type: 'ok' })
      showToast('Added to Riven — symlink and Plex notify will follow', 'ok')
      clearTimeout(pasteStatusTimeoutRef.current)
      pasteStatusTimeoutRef.current = setTimeout(() => {
        setPasteValue('')
        setPasteStatus({ text: '', type: '' })
      }, 4000)
    } catch (err) {
      setPasteStatus({ text: 'Failed: ' + err.message, type: 'error' })
      showToast('Failed: ' + err.message, 'error')
    }
  }, [curSeason, showToast])

  const handlePasteInput = useCallback((e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text').trim()
    if (text.startsWith('magnet:')) {
      e.preventDefault()
      setPasteValue(text)
      doAddMagnet(text, selected)
    }
  }, [selected, doAddMagnet])

  const handleLogout = useCallback(async () => {
    try {
      await fetch('/admin/logout', { method: 'POST', credentials: 'include' })
    } catch { /* ignore */ }
    window.location.href = '/admin/login'
  }, [])

  const dmmTabUrl = selected?.imdbId ? `https://debridmediamanager.com/x/${selected.imdbId}/` : '#'

  return (
    <div className="rv-root">
      {/* Nav */}
      <nav className="nav" style={{ flexShrink: 0 }}>
        <div className="nav-inner">
          <a href="/" className="nav-logo">
            <span className="logo-icon">{LOGO_SVG}</span>
            <span className="logo-text">Diskovarr</span>
            <span className="admin-badge">admin</span>
          </a>
          <div className="nav-user">
            <a href="/admin#connections" className="nav-logout">← Admin</a>
            <button
              type="button"
              className="nav-logout"
              style={{ background: 'none', border: 'none', cursor: 'pointer', marginLeft: 4 }}
              onClick={handleLogout}
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <div className="rv-body">
        {/* Top bar */}
        <div className="rv-topbar">
          <div className="rv-search-wrap" ref={searchWrapRef}>
            <input
              type="text"
              className="rv-search-input"
              placeholder="Search for a movie or TV show…"
              autoComplete="off"
              value={query}
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
            />
            {showSuggestions && (
              <div className="rv-suggest-box">
                {suggestions.length === 0 ? (
                  <div className="rv-suggest-hint">No results found</div>
                ) : (
                  suggestions.slice(0, 8).map((r, i) => (
                    <div key={i} className="rv-suggest-item" onClick={() => handleSelectItem(r)}>
                      {r.posterUrl
                        ? <img className="rv-suggest-poster" src={r.posterUrl} alt="" loading="lazy" />
                        : <div className="rv-suggest-poster-empty" />
                      }
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="rv-suggest-name">{r.title}</div>
                        <div className="rv-suggest-meta">
                          {r.year && <span className="rv-suggest-year">{r.year}</span>}
                          <span className="rv-type-badge">{r.mediaType === 'tv' ? 'TV' : 'Movie'}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {selected && (
            <>
              <button
                className="rv-action-btn"
                onClick={handleReloadDMM}
                title="Reload DMM to the selected title"
              >
                ↻ Reload
              </button>
              <a
                href={dmmTabUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rv-action-btn"
                title="Open in new tab if RD auth needed"
              >
                Open in new tab ↗
              </a>
              <div className="rv-item-chip">
                {selected.posterUrl
                  ? <img className="rv-item-chip-poster" src={selected.posterUrl} alt="" />
                  : <div className="rv-item-chip-poster-empty" />
                }
                <div>
                  <div className="rv-item-chip-title">{selected.title}</div>
                  <div className="rv-item-chip-meta">
                    {selected.year || ''}{selected.year && selected.mediaType ? ' · ' : ''}{selected.mediaType === 'tv' ? 'TV' : 'Movie'}
                  </div>
                </div>
                <span className="rv-item-chip-clear" onClick={clearSelection} title="Clear">✕</span>
              </div>
            </>
          )}

          {loadingItem && <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Loading…</span>}
        </div>

        {/* Season tabs (TV only) */}
        {selected && seasons.length > 0 && (
          <div className="rv-season-strip">
            {seasons.map(s => (
              <button
                key={s.number}
                className={`rv-season-tab${s.number === curSeason ? ' active' : ''}`}
                onClick={() => setCurSeason(s.number)}
              >
                S{String(s.number).padStart(2, '0')}
              </button>
            ))}
          </div>
        )}

        {/* Frame area */}
        <div className="rv-frame-area">
          {!selected && (
            <div className="rv-frame-placeholder">
              <div className="rv-frame-placeholder-icon">🔍</div>
              <div className="rv-frame-placeholder-text">Search for a title above to open Debrid Media Manager</div>
            </div>
          )}
          {dmmUrl && (
            <iframe
              key={dmmUrl}
              src={dmmUrl}
              title="Debrid Media Manager"
              className="rv-dmm-frame"
              allowFullScreen
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
            />
          )}
        </div>

        {/* Paste bar */}
        {selected && (
          <div className="rv-paste-bar">
            <span className="rv-paste-hint">
              Copy a magnet link in DMM — then <strong>paste it here</strong> to add to Riven instantly:
            </span>
            <input
              ref={pasteInputRef}
              type="text"
              className="rv-paste-input"
              placeholder="Paste magnet link…"
              autoComplete="off"
              value={pasteValue}
              onChange={e => setPasteValue(e.target.value)}
              onPaste={handlePasteInput}
            />
            {pasteStatus.text && (
              <span className={`rv-paste-status${pasteStatus.type ? ' ' + pasteStatus.type : ''}`}>
                {pasteStatus.text}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast.visible && (
        <div className={`rv-toast${toast.type ? ' ' + toast.type : ''} show`}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
