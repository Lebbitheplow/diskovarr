import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import useNavSearch from '../hooks/useNavSearch'
import useNotifications from '../hooks/useNotifications'
import useShellMotion from '../hooks/useShellMotion'
import SideRail, { LogoIcon, Avatar } from './SideRail'
import TopBar from './TopBar'
import Footer from './Footer'
import Modal from './Modal'
import ChangelogModal from './ChangelogModal'
import { renderTextWithLinks } from '../utils/renderRichText'
import { useTranslation } from 'react-i18next'

const RAIL_KEY = 'dk-rail-collapsed'

/**
 * Application chrome: the collapsible rail, the sticky top bar, and every
 * overlay that hangs off them. Page content is passed as children and rendered
 * inside the scrolling column to the right of the rail.
 *
 * Overlay placement rule: dropdowns and menus are rendered here, as children of
 * .app-shell, rather than inside .rail or .topbar. Both of those are
 * backdrop-filter surfaces, and Chromium will not render a backdrop-filter that
 * is nested inside another one — the child simply comes out unblurred. They
 * position themselves with fixed coordinates measured off their anchor.
 */
export default function AppShell({ children }) {
  const { t } = useTranslation()
  const { user, logout, discoverAvailable, activeSource, availableSources, setActiveSource } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const search = useNavSearch()
  const bell = useNotifications()
  useShellMotion()

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(RAIL_KEY) === 'true' } catch { return false }
  })
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [userMenuPos, setUserMenuPos] = useState(null)
  const [bellOpen, setBellOpen] = useState(false)
  const [bellPos, setBellPos] = useState(null)
  const [searchPos, setSearchPos] = useState(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)

  const searchWrapRef = useRef(null)
  const searchDropdownRef = useRef(null)
  const bellBtnRef = useRef(null)
  const bellDropdownRef = useRef(null)
  const userMenuRef = useRef(null)

  const currentPath = location.pathname
  const userMenuOpen = userMenuPos !== null

  // Close every transient surface when the route changes. Render-phase
  // adjustment — React's recommended alternative to a state-resetting effect.
  const [prevPath, setPrevPath] = useState(currentPath)
  if (currentPath !== prevPath) {
    setPrevPath(currentPath)
    setDrawerOpen(false)
    setUserMenuPos(null)
    setBellOpen(false)
    setInfoOpen(false)
    search.setOpen(false)
  }

  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, collapsed ? 'true' : 'false') } catch { /* ignore */ }
  }, [collapsed])

  // Hold the page still behind the mobile drawer
  useEffect(() => {
    if (!drawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [drawerOpen])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      setDrawerOpen(false)
      setUserMenuPos(null)
      setBellOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const handleSourceChange = useCallback((src) => {
    if (activeSource === src) return
    setActiveSource(src).then(() => window.location.reload())
  }, [activeSource, setActiveSource])

  // Anchor the user menu above the rail's user button, clamped to the viewport.
  const handleUserMenu = useCallback((btn) => {
    if (userMenuPos) { setUserMenuPos(null); return }
    const rect = btn.getBoundingClientRect()
    const MENU_W = 220
    setUserMenuPos({
      left: Math.round(Math.min(rect.left, Math.max(8, window.innerWidth - MENU_W - 8))),
      bottom: Math.round(window.innerHeight - rect.top + 8),
    })
  }, [userMenuPos])

  const handleBellClick = useCallback(async () => {
    if (!bellOpen) {
      if (bellBtnRef.current) {
        const rect = bellBtnRef.current.getBoundingClientRect()
        setBellPos({
          top: Math.round(rect.bottom + 8),
          right: Math.round(window.innerWidth - rect.right),
        })
      }
      await bell.loadNotifications()
    }
    setBellOpen((o) => !o)
  }, [bellOpen, bell])

  // Close search when clicking outside (the dropdown lives outside the top bar,
  // so it must be checked separately from the input wrap)
  useEffect(() => {
    const handler = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target) &&
          (!searchDropdownRef.current || !searchDropdownRef.current.contains(e.target))) {
        search.setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [search])

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

  useEffect(() => {
    if (!userMenuOpen) return
    const handler = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setUserMenuPos(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [userMenuOpen])

  // Position the search dropdown under the input. Recomputed on resize because
  // the anchor moves with the rail's collapsed state and the mobile breakpoint.
  const searchDropdownOpen = search.results.length > 0
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
  }, [searchDropdownOpen, search.open, collapsed])

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
    <div className="app-shell" data-rail={collapsed ? 'collapsed' : 'expanded'}>
      <SideRail
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        drawerOpen={drawerOpen}
        onNavigate={() => setDrawerOpen(false)}
        user={user}
        discoverAvailable={discoverAvailable}
        currentPath={currentPath}
        onUserMenu={handleUserMenu}
        userMenuOpen={userMenuOpen}
      />

      <div className="app-main">
        <TopBar
          search={search}
          searchWrapRef={searchWrapRef}
          availableSources={availableSources}
          activeSource={activeSource}
          onSourceChange={handleSourceChange}
          bellBtnRef={bellBtnRef}
          bellCount={bell.bellCount}
          onBellClick={handleBellClick}
          onOpenDrawer={() => setDrawerOpen((o) => !o)}
          drawerOpen={drawerOpen}
        />
        {children}
        <Footer />
      </div>

      {drawerOpen && <div className="rail-scrim" onClick={() => setDrawerOpen(false)} />}

      {/* User menu — anchored above the rail's user button */}
      {userMenuOpen && (
        <div
          className="user-menu open"
          ref={userMenuRef}
          style={{ left: userMenuPos.left, bottom: userMenuPos.bottom }}
        >
          <Link to={`/user/${user?.id}`} className="nav-fab-menu-user nav-fab-menu-user-link">
            <Avatar user={user} className="nav-fab-menu-avatar" />
            <span className="nav-fab-menu-username">{user?.username || t('User')}</span>
          </Link>
          <button className="nav-fab-menu-link nav-fab-menu-info" onClick={() => { setInfoOpen(true); setUserMenuPos(null) }}>ℹ {t('About')}</button>
          <button className="nav-fab-menu-link nav-fab-menu-signout" onClick={handleSignOut}>{t('Sign out')}</button>
        </div>
      )}

      {/* Search dropdown — see the overlay placement note at the top of the file */}
      {searchDropdownOpen && (
        <div
          className="nav-search-dropdown open"
          ref={searchDropdownRef}
          style={{ position: 'fixed', top: searchPos?.top, left: searchPos?.left, right: 'auto', width: searchPos?.width }}
        >
          {search.results.slice(0, 6).map((item, idx) => (
            <div
              key={item.id || item.tmdbId}
              className={`hero-suggest-row ${idx === search.activeIdx ? 'active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); search.navigateToSearch(item) }}
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
            onMouseDown={(e) => { e.preventDefault(); search.navigateToSearch(search.query.trim()) }}
          >
            {t('See all results for “{{query}}”', { query: search.query.trim() })}
          </div>
        </div>
      )}

      {/* Bell dropdown */}
      {bellOpen && (
        <div
          ref={bellDropdownRef}
          className="nav-bell-dropdown"
          style={{ position: 'fixed', top: bellPos?.top, right: bellPos?.right }}
        >
          <div className="nav-bell-header">
            <span>{t('Notifications')}</span>
            <button onClick={bell.markAllRead}>{t('Mark all read')}</button>
          </div>
          {bell.notifications.length === 0 ? (
            <div className="nav-bell-empty">{t('No notifications')}</div>
          ) : (
            <div className="nav-bell-list">
              {bell.notifications.map((n) => (
                <div
                  key={n.id}
                  className={`nav-bell-item ${n.read ? 'read' : 'unread'}`}
                  onClick={() => bell.handleItemClick(n, () => setBellOpen(false))}
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
              <button className="info-modal-version" onClick={() => { setInfoOpen(false); setChangelogOpen(true) }}>v{import.meta.env.VITE_APP_VERSION || '2.7.1'}</button>
            </div>
            <p className="info-modal-tagline">{t("Your personalized discovery and content management platform for Plex and Jellyfin. Diskovarr combines recommendations, requests, watch history, reviews, and community features into a single experience. It learns from your viewing habits to help you discover new content, track what you've watched, and share your thoughts with other users.")}</p>
            <div className="info-modal-sections">
              <div className="info-modal-section">
                <div className="info-modal-section-title">Diskovarr</div>
                <p>{t("Your personalized recommendation feed. Diskovarr analyzes your watch history from Plex and Jellyfin, along with your ratings, genres, actors, directors, and studios, to surface movies and shows you're likely to enjoy. Dismiss anything you're not interested in and it won't be recommended again.")}</p>
              </div>
              {discoverAvailable && (
                <div className="info-modal-section">
                  <div className="info-modal-section-title">{t('Diskovarr Requests')}</div>
                  <p>{t("Recommendations for content not currently available in the library. Browse suggested titles based on your interests or search for any movie or show and request it directly. Requested items are tracked automatically so you won't be prompted to request the same title twice.")}</p>
                </div>
              )}
              {availableSources.length > 1 && (
                <div className="info-modal-section">
                  <div className="info-modal-section-title">{t('Library Source')}</div>
                  <p>{t('This server hosts both a Plex and a Jellyfin library. Use the Plex / Jellyfin switch in the navigation bar to choose which one you are browsing — recommendations, search, and availability all follow the selected source. Link both accounts in Settings to sign in with either one and keep a single combined watch profile.')}</p>
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
                <p>{t("A social-media-style feed of community reviews. Reviews are created from the Watch History section after a user has watched a movie or show on Plex or Jellyfin, allowing them to share their thoughts and ratings with the community. Discover what other users are watching, comment on reviews, discuss content, and find new recommendations through other users' experiences. Reviews marked as spoilers are hidden by default and can be revealed when desired.")}</p>
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
      <Modal isOpen={!!bell.selectedBroadcast} onClose={() => bell.setSelectedBroadcast(null)}>
        {bell.selectedBroadcast && (
          <div className="broadcast-modal-body">
            <div className="broadcast-modal-title">{bell.selectedBroadcast.title}</div>
            <div className="broadcast-modal-message">{renderTextWithLinks(bell.selectedBroadcast.body)}</div>
            <div className="broadcast-modal-time">{agoString(bell.selectedBroadcast.created_at)}</div>
          </div>
        )}
      </Modal>
    </div>
  )
}
