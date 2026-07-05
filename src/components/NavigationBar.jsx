import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { notificationsApi, searchApi } from '../services/api'
import Modal from './Modal'
import ChangelogModal from './ChangelogModal'
import { renderTextWithLinks } from '../utils/renderRichText'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  const { user, logout, discoverAvailable } = useAuth()
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
  const [selectedBroadcast, setSelectedBroadcast] = useState(null)
  const searchInputRef = useRef(null)
  const searchWrapRef = useRef(null)
  const searchDropdownRef = useRef(null)
  const suggestTimerRef = useRef(null)
  const bellDropdownRef = useRef(null)
  const bellBtnRef = useRef(null)
  const userBtnRef = useRef(null)
  const [menuRight, setMenuRight] = useState(null)
  const [bellPos, setBellPos] = useState(null)
  const [searchPos, setSearchPos] = useState(null)

  // Align the dropdown menu's right edge with the desktop user button.
  // The menu is rendered outside <nav> (to avoid the nav's z-index stacking context),
  // so it uses position:fixed. We compute the right offset from the button's bounding rect
  // each time the menu opens. On mobile the button is display:none (rect.width === 0) so
  // we fall back to the CSS default (null = no inline style).
  useEffect(() => {
    if (!fabOpen) return
    if (userBtnRef.current) {
      const rect = userBtnRef.current.getBoundingClientRect()
      if (rect.width > 0) {
        setMenuRight(Math.round(window.innerWidth - rect.right))
        return
      }
    }
    setMenuRight(null)
  }, [fabOpen])

  const currentPath = location.pathname

  const navTabs = [
    { path: '/', label: 'Diskovarr' },
    ...(discoverAvailable ? [{ path: '/explore', label: t('Diskovarr Requests') }] : []),
    { path: '/discover', label: t('Filter'), icon: true },
    { path: '/reviews', label: t('Reviews') },
  ]

  // Close all menus when the route changes. Render-phase adjustment (React's
  // recommended alternative to a state-resetting effect).
  const [prevPath, setPrevPath] = useState(location.pathname)
  if (location.pathname !== prevPath) {
    setPrevPath(location.pathname)
    setFabOpen(false)
    setInfoOpen(false)
    setBellOpen(false)
    setSearchOpen(false)
  }

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
      // Position the dropdown under the button before it renders (it lives
      // outside <nav> with position:fixed — see the bell dropdown JSX)
      if (bellBtnRef.current) {
        const rect = bellBtnRef.current.getBoundingClientRect()
        setBellPos({
          top: Math.round(rect.bottom + 8),
          right: Math.round(window.innerWidth - rect.right),
        })
      }
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

  const handleBellItemClick = async (notification) => {
    await markRead(notification.id)

    if (notification.type === 'broadcast') {
      setBellOpen(false)
      setSelectedBroadcast(notification)
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
    } else if (notification.type === 'monitor_match') {
      const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data
      if (data?.tmdbId && data?.mediaType) {
        navigate(`/search?q=${encodeURIComponent(data.title || '')}&selectedTmdbId=${encodeURIComponent(data.tmdbId)}&selectedType=${encodeURIComponent(data.mediaType)}`)
      } else {
        navigate('/search')
      }
    }
  }

  // Search
  const fetchSuggestions = useCallback(async (q) => {
    if (q.length < 2) {
      setSearchResults([])
      return
    }
    try {
      const { data } = await searchApi.getSuggestions(q)
      setSearchResults(data?.results || [])
      setSearchActiveIdx(-1)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    clearTimeout(suggestTimerRef.current)
    // fetchSuggestions clears results for queries < 2 chars; routing both paths
    // through the debounce keeps any setState out of the synchronous effect body.
    suggestTimerRef.current = setTimeout(() => fetchSuggestions(searchQuery), 280)
    return () => clearTimeout(suggestTimerRef.current)
  }, [searchQuery, fetchSuggestions])

  const navigateToSearch = useCallback((itemOrQuery) => {
    setSearchResults([])
    setSearchQuery('')
    setSearchOpen(false)
    if (itemOrQuery && typeof itemOrQuery === 'object' && itemOrQuery.tmdbId) {
      const params = new URLSearchParams()
      params.set('q', itemOrQuery.title)
      params.set('selectedTmdbId', itemOrQuery.tmdbId)
      params.set('selectedType', itemOrQuery.mediaType)
      navigate('/search?' + params.toString())
    } else {
      navigate(`/search?q=${encodeURIComponent(typeof itemOrQuery === 'string' ? itemOrQuery : '')}`)
    }
  }, [navigate])

  // Close search when clicking outside (the dropdown lives outside <nav>, so
  // it must be checked separately from the input wrap)
  useEffect(() => {
    const handler = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target) &&
          (!searchDropdownRef.current || !searchDropdownRef.current.contains(e.target))) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Position the search dropdown under the input. Like the bell dropdown, it
  // renders outside <nav> with position:fixed — nesting it under the nav's
  // backdrop-filter would silently disable its own glass blur in Chromium.
  const searchDropdownOpen = searchResults.length > 0
  useEffect(() => {
    if (!searchDropdownOpen) return
    const compute = () => {
      if (!searchWrapRef.current) return
      const rect = searchWrapRef.current.getBoundingClientRect()
      // The dropdown has min-width 280px; keep it inside the viewport
      const effectiveWidth = Math.max(rect.width, 280)
      const left = Math.min(rect.left, Math.max(8, window.innerWidth - effectiveWidth - 8))
      setSearchPos({
        top: Math.round(rect.bottom + 6),
        left: Math.round(left),
        width: Math.round(rect.width),
      })
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [searchDropdownOpen, searchOpen])

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
    // eslint-disable-next-line react-hooks/purity
    const ago = Math.floor((Date.now() / 1000 - created_at) / 60)
    return ago < 60 ? t('{{n}}m ago', { n: ago }) : t('{{n}}h ago', { n: Math.floor(ago / 60) })
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
                aria-label={t('Search')}
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
                  placeholder={t('Search movies & shows...')}
                  autoComplete="off"
                  spellCheck="false"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                 onKeyDown={(e) => {
                     if (e.key === 'Enter') {
                       const q = searchQuery.trim()
                       if (q) {
                         if (searchActiveIdx >= 0 && searchActiveIdx < searchResults.length) {
                           navigateToSearch(searchResults[searchActiveIdx])
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
                  <button type="button" className="nav-search-clear" onClick={() => { setSearchQuery(''); searchInputRef.current?.focus() }} aria-label={t('Clear')}>✕</button>
                )}
              </div>
              {/* moved: search dropdown renders outside <nav> (see below) */}
            </div>

            <div className="nav-bell-wrap" style={{ position: 'relative' }}>
              <button
                ref={bellBtnRef}
                className="nav-bell-btn"
                onClick={handleBellClick}
                aria-label={t('Notifications')}
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
            </div>

            <button
              ref={userBtnRef}
              className="nav-user-btn"
              onClick={() => setFabOpen(!fabOpen)}
              aria-label={t('Open menu')}
              aria-expanded={fabOpen}
            >
              {user?.thumb ? (
                <img src={user.thumb} alt={user.username}
                  onError={(e) => { e.currentTarget.outerHTML = `<span class="nav-fab-initial">${user.username.charAt(0).toUpperCase()}</span>` }} />
              ) : (
                <span className="nav-fab-initial">{user?.username?.charAt(0).toUpperCase() || '?'}</span>
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* FAB for mobile */}
      <button className="nav-fab" onClick={() => setFabOpen(!fabOpen)} aria-label={t('Open menu')} aria-expanded={fabOpen}>
        {user?.thumb ? (
          <img src={user.thumb} alt={user.username}
            onError={(e) => { e.currentTarget.outerHTML = `<span class="nav-fab-initial">${user.username.charAt(0).toUpperCase()}</span>` }} />
        ) : (
          <span className="nav-fab-initial">{user?.username?.charAt(0).toUpperCase() || '?'}</span>
        )}
      </button>

      {/* FAB menu */}
      {fabOpen && (
        <>
          <div className="nav-fab-menu open" style={menuRight !== null ? { right: menuRight } : undefined}>
            <a href={`/user/${user?.id}`} className="nav-fab-menu-user nav-fab-menu-user-link" onClick={() => setFabOpen(false)}>
              {user?.thumb ? (
                <img className="nav-fab-menu-avatar" src={user.thumb} alt={user.username}
                  onError={(e) => { e.currentTarget.style.display = 'none' }} />
              ) : (
                <div className="nav-fab-menu-avatar-placeholder">{user?.username?.charAt(0).toUpperCase() || '?'}</div>
              )}
              <span className="nav-fab-menu-username">{user?.username || t('User')}</span>
            </a>
            <a href="/settings" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>⚙ {t('Settings')}</a>
            <a href="/queue" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>☑ {t('Queue')}</a>
            <a href="/history" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>◷ {t('Watch History')}</a>
            <a href="/issues" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>⚠ {t('Issues')}</a>
            <a href="/admin" className="nav-fab-menu-link" onClick={() => setFabOpen(false)}>⚙ {t('Admin')}</a>
            <button className="nav-fab-menu-link nav-fab-menu-info" onClick={() => { setInfoOpen(true); setFabOpen(false) }}>ℹ {t('About')}</button>
            <button className="nav-fab-menu-link nav-fab-menu-signout" onClick={handleSignOut}>{t('Sign out')}</button>
          </div>
          <div className="nav-overlay open" onClick={() => setFabOpen(false)} />
        </>
      )}

      {/* Search dropdown — rendered outside <nav> so its glass effect works
          (a backdrop-filter nested under the nav's backdrop-filter doesn't
          render in Chromium; see the searchPos effect) */}
      {searchDropdownOpen && (
        <div
          className="nav-search-dropdown open"
          ref={searchDropdownRef}
          style={{ position: 'fixed', top: searchPos?.top, left: searchPos?.left, right: 'auto', width: searchPos?.width }}
        >
          {searchResults.slice(0, 6).map((item, idx) => (
            <div
              key={item.id || item.tmdbId}
              className={`hero-suggest-row ${idx === searchActiveIdx ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); navigateToSearch(item) }}
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
                  {[item.year, item.mediaType === 'movie' ? t('Movie') : t('TV Show')].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
          ))}
          <div
            className="hero-suggest-row hero-suggest-all"
            onMouseDown={(e) => { e.preventDefault(); navigateToSearch(searchQuery.trim()) }}
          >
            {t('See all results for “{{query}}”', { query: searchQuery.trim() })}
          </div>
        </div>
      )}

      {/* Bell dropdown — rendered outside <nav> so its glass effect works (see bellPos effect) */}
      {bellOpen && (
        <div
          ref={bellDropdownRef}
          className="nav-bell-dropdown"
          style={{ position: 'fixed', top: bellPos?.top, right: bellPos?.right }}
        >
          <div className="nav-bell-header">
            <span>{t('Notifications')}</span>
            <button onClick={markAllRead}>{t('Mark all read')}</button>
          </div>
          {notifications.length === 0 ? (
            <div className="nav-bell-empty">{t('No notifications')}</div>
          ) : (
            <div className="nav-bell-list">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`nav-bell-item ${n.read ? 'read' : 'unread'}`}
                  onClick={() => handleBellItemClick(n)}
                >
                  <div className="nav-bell-title">{n.title}</div>
                  {n.body && <div className="nav-bell-body">{renderTextWithLinks(n.body)}</div>}
                  <div className="nav-bell-time">{agoString(n.created_at)}{n.read ? ' · ' + t('read') : ''}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Info modal */}
      {infoOpen && (
        <div className="info-modal-backdrop open" onClick={() => setInfoOpen(false)}>
          <div className="info-modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            <button className="info-modal-close" onClick={() => setInfoOpen(false)} aria-label={t('Close')}>✕</button>
            <div className="info-modal-logo">
              <span className="logo-icon"><LogoIcon /></span>
              <span className="logo-text">Diskovarr</span>
              <button className="info-modal-version" onClick={() => { setInfoOpen(false); setChangelogOpen(true) }}>v{import.meta.env.VITE_APP_VERSION || '2.5.1'}</button>
            </div>
            <p className="info-modal-tagline">{t("Your personalized Plex discovery and content management platform. Diskovarr combines recommendations, requests, watch history, reviews, and community features into a single experience. It learns from your viewing habits to help you discover new content, track what you've watched, and share your thoughts with other users.")}</p>
            <div className="info-modal-sections">
              <div className="info-modal-section">
                <div className="info-modal-section-title">Diskovarr</div>
                <p>{t("Your personalized recommendation feed. Diskovarr analyzes your Plex watch history, ratings, genres, actors, directors, and studios to surface movies and shows you're likely to enjoy. Dismiss anything you're not interested in and it won't be recommended again.")}</p>
              </div>
              {discoverAvailable && (
                <div className="info-modal-section">
                  <div className="info-modal-section-title">{t('Diskovarr Requests')}</div>
                  <p>{t("Recommendations for content not currently available in the library. Browse suggested titles based on your interests or search for any movie or show and request it directly. Requested items are tracked automatically so you won't be prompted to request the same title twice.")}</p>
                </div>
              )}
              <div className="info-modal-section">
                <div className="info-modal-section-title">{t('Filter')}</div>
                <p>{t('Browse the entire library with powerful filters for media type, genre, decade, rating, and more. Sort results by recommendation score, release date, rating, recently added content, and other criteria to quickly find something to watch.')}</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">{t('Profile')}</div>
                <p>{t('Your personal profile within Diskovarr. Showcase your favorite movies, shows, and genres, write a short bio, and share your reviews with the community. Your profile also includes your watch history, where you can review previously watched content and share reviews with the community, along with your watchlist and blacklist for viewing and managing saved or excluded titles.')}</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">{t('Reviews')}</div>
                <p>{t("A social-media-style feed of community reviews. Reviews are created from the Watch History section after a user has watched a movie or show in Plex, allowing them to share their thoughts and ratings with the community. Discover what other users are watching, comment on reviews, discuss content, and find new recommendations through other users' experiences. Reviews marked as spoilers are hidden by default and can be revealed when desired.")}</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">{t('Queue')}</div>
                <p>{t('Track the status of your requests from submission to availability. View pending, approved, downloaded, and denied requests in one place. Administrators can also review requests, leave notes, and manage request settings.')}</p>
              </div>
              <div className="info-modal-section">
                <div className="info-modal-section-title">{t('Issues')}</div>
                <p>{t('Report problems with content in the library, including missing episodes, subtitle issues, incorrect files, metadata problems, or other concerns. Users and administrators can discuss issues, track progress, and receive updates when problems are resolved.')}</p>
              </div>
            </div>
            <div className="info-modal-footer">
              {t('Created by')}{' '}
              <a href="https://github.com/Lebbitheplow" target="_blank" rel="noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Lebbitheplow</a>
              {' '}&amp;{' '}
              <a href="https://github.com/gage117" target="_blank" rel="noopener" style={{ color: 'var(--accent)', textDecoration: 'none' }}>gage117</a>
            </div>
          </div>
        </div>
      )}

      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />

      {/* Broadcast notification modal */}
      <Modal isOpen={!!selectedBroadcast} onClose={() => setSelectedBroadcast(null)}>
        {selectedBroadcast && (
          <div className="broadcast-modal-body">
            <div className="broadcast-modal-title">{selectedBroadcast.title}</div>
            <div className="broadcast-modal-message">{renderTextWithLinks(selectedBroadcast.body)}</div>
            <div className="broadcast-modal-time">{agoString(selectedBroadcast.created_at)}</div>
          </div>
        )}
      </Modal>
    </>
  )
}
