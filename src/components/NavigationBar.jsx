import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { notificationsApi, searchApi } from '../services/api'

const LOGO_SVG = 'M7.5 17.5h13M3 8.5h2.5v9M7 11h3v6.5M11 10h2.5v7.5M15 9a5 5 0 1 0 0 0 5 5 0 1 0 0 0M18.5 12.5l3.5 3.5'

function LogoIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">
      <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="currentColor" />
      <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="currentColor" />
      <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="currentColor" />
      <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="currentColor" />
      <circle cx="15" cy="9" r="5" stroke="currentColor" strokeWidth="2" />
      <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export default function NavigationBar() {
  const { user, logout, discoverAvailable } = useAuth()
  const { showToast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [fabOpen, setFabOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)
  const [bellCount, setBellCount] = useState(0)
  const [notifications, setNotifications] = useState([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchActiveIdx, setSearchActiveIdx] = useState(-1)
  const searchInputRef = useRef(null)
  const searchWrapRef = useRef(null)
  const searchDropdownRef = useRef(null)
  const suggestTimerRef = useRef(null)
  const bellDropdownRef = useRef(null)
  const bellBtnRef = useRef(null)

  const currentPath = location.pathname

  const navTabs = [
    { path: '/', label: 'Diskovarr' },
    ...(discoverAvailable ? [{ path: '/explore', label: 'Diskovarr Requests' }] : []),
    { path: '/discover', label: 'Filter', icon: true },
  ]

  useEffect(() => {
    setFabOpen(false)
    setInfoOpen(false)
    setBellOpen(false)
    setSearchOpen(false)
  }, [location.pathname])

  // Notification bell
  useEffect(() => {
    const fetchCount = async () => {
      try {
        const { data } = await notificationsApi.getNotifications({ countOnly: 1 })
        setBellCount(data?.unreadCount || 0)
      } catch { /* ignore */ }
    }
    fetchCount()
    const interval = setInterval(fetchCount, 60000)
    return () => clearInterval(interval)
  }, [])

  const loadNotifications = useCallback(async () => {
    try {
      const { data } = await notificationsApi.getNotifications()
      const unread = data?.notifications || []
      const read = data?.recentRead || []
      setNotifications([...unread, ...read])
      if (unread.length > 0) setBellCount(unread.length)
    } catch { /* ignore */ }
  }, [])

  const handleBellClick = async () => {
    if (!bellOpen) {
      await loadNotifications()
    }
    setBellOpen(!bellOpen)
  }

  const markRead = async (id) => {
    try {
      await notificationsApi.markAsRead({ ids: [id] })
      setBellCount((c) => Math.max(0, c - 1))
      setNotifications((ns) => ns.map((n) => n.id === id ? { ...n, read: true } : n))
    } catch { /* ignore */ }
  }

  const markAllRead = async () => {
    try {
      await notificationsApi.markAllAsRead()
      setBellCount(0)
      setNotifications((ns) => ns.map((n) => ({ ...n, read: true })))
    } catch { /* ignore */ }
  }

  const handleBellItemClick = async (notification, el) => {
    await markRead(notification.id)

    if (notification.type === 'broadcast') {
      setInfoOpen(false)
      // Could show a broadcast modal here
    } else if (notification.type.startsWith('request_')) {
      navigate('/queue')
    } else if (notification.type === 'request_available') {
      const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data
      if (data?.tmdbId && data?.mediaType) {
        navigate(`/?openModal=${encodeURIComponent(data.tmdbId)}&mediaType=${encodeURIComponent(data.mediaType)}`)
      } else {
        navigate('/queue?filter=available')
      }
    } else if (notification.type.startsWith('issue_')) {
      navigate('/issues')
    }
  }

  // Search
  const fetchSuggestions = useCallback(async (q) => {
    try {
      const { data } = await searchApi.getSuggestions(q)
      setSearchResults(data?.results || [])
      setSearchActiveIdx(-1)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (searchQuery.length < 2) {
      setSearchResults([])
      return
    }
    clearTimeout(suggestTimerRef.current)
    suggestTimerRef.current = setTimeout(() => fetchSuggestions(searchQuery), 280)
    return () => clearTimeout(suggestTimerRef.current)
  }, [searchQuery, fetchSuggestions])

  const navigateToSearch = useCallback((q) => {
    setSearchResults([])
    setSearchQuery('')
    setSearchOpen(false)
    navigate(`/search?q=${encodeURIComponent(q)}`)
  }, [navigate])

  // Close search when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Close bell when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (bellDropdownRef.current && !bellDropdownRef.current.contains(e.target) &&
          bellBtnRef.current && !bellBtnRef.current.contains(e.target)) {
        setBellOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSignOut = async () => {
    await logout()
    navigate('/login')
  }

  const agoString = (created_at) => {
    const ago = Math.floor((Date.now() / 1000 - created_at) / 60)
    return ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`
  }

  return (
    <>
      <nav className="nav">
        <div className="nav-inner">
          <a href="/" className="nav-logo">
            <span className="logo-icon"><LogoIcon /></span>
            <span className="logo-text">Diskovarr</span>
          </a>

          <div className="nav-tabs">
            {navTabs.map((tab) => (
              <a
                key={tab.path}
                href={tab.path}
                className={`nav-tab ${currentPath === tab.path ? 'active' : ''}`}
              >
                {tab.icon && (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="13" height="13" fill="none" aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: '4px' }}>
                    <line x1="2" y1="4" x2="14" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <line x1="6" y1="12" x2="10" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
                {tab.label}
              </a>
            ))}
          </div>

          <div className="nav-user">
            <div className={`nav-search-wrap${searchOpen ? ' expanded' : ''}`} ref={searchWrapRef}>
              <button
                className="nav-search-toggle"
                onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0) }}
                aria-label="Search"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                  <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
              <div className="nav-search-input-wrap">
                <svg className="nav-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8" />
                  <line x1="12.5" y1="12.5" x2="17" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  ref={searchInputRef}
                  type="search"
                  className="nav-search-input"
                  placeholder="Search movies & shows..."
                  autoComplete="off"
                  spellCheck="false"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const q = searchQuery.trim()
                      if (q) {
                        if (searchActiveIdx >= 0 && searchActiveIdx < searchResults.length) {
                          navigateToSearch(searchResults[searchActiveIdx].title)
                        } else {
                          navigateToSearch(q)
                        }
                      }
                    } else if (e.key === 'Escape') {
                      setSearchOpen(false)
                      searchInputRef.current?.blur()
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setSearchActiveIdx((i) => Math.min(i + 1, searchResults.length - 1))
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSearchActiveIdx((i) => Math.max(i - 1, -1))
                    }
                  }}
                />
                {searchQuery && (
                  <button type="button" className="nav-search-clear" onClick={() => { setSearchQuery(''); searchInputRef.current?.focus() }} aria-label="Clear">✕</button>
                )}
              </div>
              <div className={`nav-search-dropdown${searchResults.length > 0 ? ' open' : ''}`} ref={searchDropdownRef}>
                {searchResults.slice(0, 6).map((item, idx) => (
                  <div
                    key={item.id || item.tmdbId}
                    className={`hero-suggest-row ${idx === searchActiveIdx ? 'active' : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); navigateToSearch(item.title) }}
                  >
                    <div className="hero-suggest-poster">
                      {item.posterUrl ? (
                        <img src={item.posterUrl} alt="" loading="lazy" />
                      ) : (
                        item.title?.charAt(0) || '?'
                      )}
                    </div>
                    <div className="hero-suggest-text">
                      <span className="hero-suggest-title">{item.title}</span>
                      <span className="hero-suggest-meta">
                        {[item.year, item.mediaType === 'movie' ? 'Movie' : 'TV Show'].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                  </div>
                ))}
                {searchResults.length > 0 && (
                  <div
                    className="hero-suggest-row hero-suggest-all"
                    onMouseDown={(e) => { e.preventDefault(); navigateToSearch(searchQuery.trim()) }}
                  >
                    See all results for "{searchQuery.trim()}"
                  </div>
                )}
              </div>
            </div>

            <div className="nav-bell-wrap" style={{ position: 'relative' }}>
              <button
                ref={bellBtnRef}
                className="nav-bell-btn"
                onClick={handleBellClick}
                aria-label="Notifications"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '6px', color: 'var(--text-secondary)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '4px', transition: 'color 0.15s' }}
                onMouseOver={(e) => { e.currentTarget.style.color = 'var(--accent)' }}
                onMouseOut={(e) => { e.currentTarget.style.color = 'var(--text-secondary)' }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {bellCount > 0 && (
                  <span style={{ display: 'inline-block', background: '#ff5252', color: '#fff', fontSize: '0.65rem', fontWeight: '700', padding: '1px 5px', borderRadius: '10px', minWidth: '16px', textAlign: 'center' }}>
                    {bellCount > 99 ? '99+' : bellCount}
                  </span>
                )}
              </button>
              {bellOpen && (
                <div ref={bellDropdownRef} className="nav-bell-dropdown">
                  <div className="nav-bell-header">
                    <span>Notifications</span>
                    <button onClick={markAllRead}>Mark all read</button>
                  </div>
                  {notifications.length === 0 ? (
                    <div className="nav-bell-empty">No notifications</div>
                  ) : (
                    <div className="nav-bell-list">
                      {notifications.map((n) => (
                        <div
                          key={n.id}
                          className={`nav-bell-item ${n.read ? 'read' : 'unread'}`}
                          onClick={() => handleBellItemClick(n)}
                        >
                          <div className="nav-bell-title">{n.title}</div>
                          {n.body && <div className="nav-bell-body">{n.body}</div>}
                          <div className="nav-bell-time">{agoString(n.created_at)}{n.read ? ' · read' : ''}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button
              className="nav-user-btn"
              onClick={() => setFabOpen(!fabOpen)}
              aria-label="Open menu"
              aria-expanded={fabOpen}
            >
              {user?.thumb ? (
                <img src={`/api/poster?path=${encodeURIComponent(user.thumb)}`} alt={user.username}
                  onError={(e) => { e.currentTarget.outerHTML = `<span class="nav-fab-initial">${user.username.charAt(0).toUpperCase()}</span>` }} />
              ) : (
                <span className="nav-fab-initial">{user?.username?.charAt(0).toUpperCase() || '?'}</span>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* FAB for mobile */}
      <button className="nav-fab" onClick={() => setFabOpen(!fabOpen)} aria-label="Open menu" aria-expanded={fabOpen}>
        {user?.thumb ? (
          <img src={`/api/poster?path=${encodeURIComponent(user.thumb)}`} alt={user.username}
            onError={(e) => { e.currentTarget.outerHTML = `<span class="nav-fab-initial">${user.username.charAt(0).toUpperCase()}</span>` }} />
        ) : (
          <span className="nav-fab-initial">{user?.username?.charAt(0).toUpperCase() || '?'}</span>
        )}
      </button>

      {/* FAB menu */}
      {fabOpen && (
        <>
          <div className="nav-fab-menu open">
            <div className="nav-fab-menu-user">
              {user?.thumb ? (
                <img className="nav-fab-menu-avatar" src={`/api/poster?path=${encodeURIComponent(user.thumb)}`} alt={user.username}
                  onError={(e) => { e.currentTarget.style.display = 'none' }} />
              ) : (
                <div className="nav-fab-menu-avatar-placeholder">{user?.username?.charAt(0).toUpperCase() || '?'}</div>
              )}
              <span className="nav-fab-menu-username">{user?.username || 'User'}</span>
            </div>
            <a href="/settings" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>⚙ Settings</a>
            <a href="/watchlist" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>◈ Watchlist</a>
            <a href="/queue" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>☑ Queue</a>
            <a href="/issues" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>⚠ Issues</a>
            <a href="/admin" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>⚙ Admin</a>
            <button className="nav-fab-menu-link nav-fab-menu-info" onClick={() => { setInfoOpen(true); setFabOpen(false) }}>ℹ About</button>
            <button className="nav-fab-menu-link nav-fab-menu-signout" onClick={handleSignOut}>Sign out</button>
          </div>
          <div className="nav-overlay open" onClick={() => setFabOpen(false)} />
        </>
      )}

      {/* Info modal */}
      {infoOpen && (
        <div className="info-modal-backdrop open">
          <div className="info-modal-card" role="dialog" aria-modal="true">
            <button className="info-modal-close" onClick={() => setInfoOpen(false)} aria-label="Close">✕</button>
            <div className="info-modal-logo">
              <span className="logo-icon"><LogoIcon /></span>
              <span className="logo-text">Diskovarr</span>
              <button className="info-modal-version" onClick={() => { setInfoOpen(false); setChangelogOpen(true) }}>v{import.meta.env.VITE_APP_VERSION || '1.17.12'}</button>
            </div>
            <p className="info-modal-tagline">Personalized Plex recommendations based on your watch history.</p>
            <div className="info-modal-sections">
              <div className="info-modal-section">
                <div className="info-modal-section-title">Diskovarr</div>
                <p>Your personalized recommendation feed. Diskovarr analyzes your Plex watch history — directors, actors, studios, and genres you enjoy — to surface content you haven't seen yet. Dismiss anything you're not interested in and it won't appear again.</p>
              </div>
              {discoverAvailable && (
                <div className="info-modal-section">
                  <div className="info-modal-section-title">Diskovarr Requests</div>
                  <p>Recommendations for content <strong>not yet in the library</strong>, picked based on your watch history. Use the search bar to find any specific title and request it directly. Click <em>Request</em> on any title to send it to Overseerr (or Radarr/Sonarr) for download. Requested items are tracked so you won't be prompted to request them again.</p>
                </div>
              )}
              <div className="info-modal-section">
                <div className="info-modal-section-title">Filter</div>
                <p>Browse the full library with filters for type (movies, TV, anime), genre, decade, and minimum rating. Sort by recommendation score, rating, year, or recently added.</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">Watchlist</div>
                <p>Save anything you want to watch later. Items sync to your <strong>Plex Watchlist</strong> and appear in the Plex app under Discover → Watchlist. Remove items here and they'll be removed from Plex too.</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">Queue</div>
                <p>Track and manage your media requests. View the status of everything you've requested — pending, approved, or denied. Admins can review all users' requests, approve or deny them with an optional note, and edit the target service or seasons for TV shows.</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">Issues</div>
                <p>Report problems with content in the library — wrong file, bad audio/subtitles, missing episodes, or anything else. Each issue can be commented on by both the reporter and admins. Admins can resolve or close issues and leave a note. You'll be notified when an admin responds to your issue.</p>
              </div>
            </div>
            <div className="info-modal-footer">
              Created by{' '}
              <a href="https://github.com/Lebbitheplow" target="_blank" rel="noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Lebbitheplow</a>
              {' '}&amp;{' '}
              <a href="https://github.com/gage117" target="_blank" rel="noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>gage117</a>
            </div>
          </div>
        </div>
      )}

      {/* Changelog modal */}
      {changelogOpen && (
        <div className="info-modal-backdrop open">
          <div className="info-modal-card" role="dialog" aria-modal="true" style={{ maxWidth: '520px' }}>
            <button className="info-modal-close" onClick={() => setChangelogOpen(false)} aria-label="Close">✕</button>
            <div className="info-modal-logo">
              <span className="logo-text">Changelog</span>
            </div>
            <div className="info-modal-sections" id="changelog-entries">
              <div className="info-modal-section">
                <div className="info-modal-section-title">
                  v{import.meta.env.VITE_APP_VERSION || '1.17.12'}{' '}
                  <span style={{ fontWeight: '400', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>2025-01-01</span>
                </div>
                <ul style={{ margin: '6px 0 0', paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <li style={{ fontSize: '0.84rem' }}>Initial React migration</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
