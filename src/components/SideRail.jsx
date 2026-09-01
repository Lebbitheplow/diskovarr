import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

// Diskovarr brand mark. Exported so the About modal in AppShell renders the
// identical glyph without a second copy of the path data.
export function LogoIcon() {
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

// Rail glyphs. Stroked 24×24 outlines so they stay legible at the 18px the
// collapsed rail renders them at, and inherit currentColor for the active tint.
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }

const ICONS = {
  home: <><rect x="3" y="3" width="7" height="7" rx="1.5" {...S} /><rect x="14" y="3" width="7" height="7" rx="1.5" {...S} /><rect x="3" y="14" width="7" height="7" rx="1.5" {...S} /><rect x="14" y="14" width="7" height="7" rx="1.5" {...S} /></>,
  requests: <><path d="M12 3l2.1 4.9L19 10l-4.9 2.1L12 17l-2.1-4.9L5 10l4.9-2.1L12 3z" {...S} /><path d="M18.5 16.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8.8-1.7z" {...S} /></>,
  filter: <><line x1="3" y1="6" x2="21" y2="6" {...S} /><line x1="6" y1="12" x2="18" y2="12" {...S} /><line x1="9" y1="18" x2="15" y2="18" {...S} /></>,
  reviews: <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9L12 3.5z" {...S} />,
  queue: <><polyline points="3.5 7 5.5 9 9 5.5" {...S} /><polyline points="3.5 17 5.5 19 9 15.5" {...S} /><line x1="12" y1="7" x2="20.5" y2="7" {...S} /><line x1="12" y1="17" x2="20.5" y2="17" {...S} /></>,
  history: <><circle cx="12" cy="12" r="8.5" {...S} /><polyline points="12 7 12 12 15.5 14" {...S} /></>,
  issues: <><path d="M12 4.5l8.5 15h-17l8.5-15z" {...S} /><line x1="12" y1="10" x2="12" y2="14" {...S} /><circle cx="12" cy="16.8" r="0.9" fill="currentColor" /></>,
  settings: <><circle cx="12" cy="12" r="3" {...S} /><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" {...S} /></>,
  admin: <><path d="M12 3l7.5 3v5.5c0 4.4-3 8-7.5 9.5-4.5-1.5-7.5-5.1-7.5-9.5V6L12 3z" {...S} /><polyline points="9 12 11.2 14.2 15.2 10.2" {...S} /></>,
}

function RailIcon({ name }) {
  return (
    <svg className="rail-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

// Avatar with an initial fallback. State rather than the outerHTML swap the old
// nav used — React owns this subtree now and would clobber a manual mutation.
export function Avatar({ user, className = '' }) {
  const [failed, setFailed] = useState(false)
  const initial = user?.username?.charAt(0).toUpperCase() || '?'
  if (!user?.thumb || failed) {
    return <span className={`avatar-initial ${className}`.trim()}>{initial}</span>
  }
  return <img className={className} src={user.thumb} alt="" onError={() => setFailed(true)} />
}

/**
 * Persistent left navigation rail. Collapses to an icon strip on desktop and
 * becomes an off-canvas drawer at ≤960px, where it also absorbs everything the
 * old FAB popup menu carried (Settings / Queue / History / Issues / Admin plus
 * the profile, About and Sign-out actions at the foot).
 */
export default function SideRail({
  collapsed, onToggle, drawerOpen, onNavigate,
  user, discoverAvailable, currentPath,
  onUserMenu, userMenuOpen,
}) {
  const { t } = useTranslation()

  const primary = [
    { path: '/', label: 'Diskovarr', icon: 'home' },
    ...(discoverAvailable ? [{ path: '/explore', label: t('Diskovarr Requests'), icon: 'requests' }] : []),
    { path: '/discover', label: t('Filter'), icon: 'filter' },
    { path: '/reviews', label: t('Reviews'), icon: 'reviews' },
  ]

  const secondary = [
    { path: '/queue', label: t('Queue'), icon: 'queue' },
    { path: '/history', label: t('Watch History'), icon: 'history' },
    { path: '/issues', label: t('Issues'), icon: 'issues' },
    { path: '/settings', label: t('Settings'), icon: 'settings' },
    { path: '/admin', label: t('Admin'), icon: 'admin' },
  ]

  const renderLink = (item) => (
    <Link
      key={item.path}
      to={item.path}
      className={`rail-link${currentPath === item.path ? ' active' : ''}`}
      // The tooltip is the only label left once the rail is collapsed
      title={collapsed ? item.label : undefined}
      aria-current={currentPath === item.path ? 'page' : undefined}
      onClick={onNavigate}
    >
      <RailIcon name={item.icon} />
      <span className="rail-label">{item.label}</span>
    </Link>
  )

  return (
    <aside
      className={`rail${drawerOpen ? ' drawer-open' : ''}`}
      id="app-rail"
      aria-label={t('Main navigation')}
    >
      <div className="rail-head">
        <button
          className="rail-toggle"
          onClick={onToggle}
          aria-label={collapsed ? t('Expand navigation') : t('Collapse navigation')}
          aria-expanded={!collapsed}
          aria-controls="app-rail"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <line x1="4" y1="7" x2="20" y2="7" {...S} />
            <line x1="4" y1="12" x2="20" y2="12" {...S} />
            <line x1="4" y1="17" x2="20" y2="17" {...S} />
          </svg>
        </button>
        <Link to="/" className="rail-brand" onClick={onNavigate}>
          <span className="rail-brand-mark"><LogoIcon /></span>
          <span className="rail-label rail-brand-text">Diskovarr</span>
        </Link>
      </div>

      <nav className="rail-nav">
        {primary.map(renderLink)}
        <div className="rail-divider" role="presentation" />
        {secondary.map(renderLink)}
      </nav>

      <button
        className={`rail-user${userMenuOpen ? ' open' : ''}`}
        onClick={(e) => onUserMenu(e.currentTarget)}
        aria-label={t('Open menu')}
        aria-expanded={userMenuOpen}
        title={collapsed ? (user?.username || t('User')) : undefined}
      >
        <span className="rail-user-avatar">
          <Avatar user={user} />
        </span>
        <span className="rail-label rail-user-name">{user?.username || t('User')}</span>
      </button>
    </aside>
  )
}
