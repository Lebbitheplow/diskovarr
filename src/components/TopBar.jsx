import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LogoIcon } from './SideRail'

/**
 * Sticky utility bar that sits above page content, to the right of the rail.
 * Carries search, the Plex/Jellyfin source toggle and the notification bell —
 * everything the old top nav held that isn't a navigation destination.
 *
 * Note both dropdowns it anchors (search suggestions, bell) are rendered by
 * AppShell *outside* this element: a backdrop-filter nested inside another
 * backdrop-filter silently fails to render in Chromium, so they position
 * themselves from the refs handed down here.
 */
export default function TopBar({
  search, searchWrapRef,
  availableSources, activeSource, onSourceChange,
  bellBtnRef, bellCount, onBellClick,
}) {
  const { t } = useTranslation()
  const [scrolled, setScrolled] = useState(false)
  // Destructured rather than read as search.* throughout: binding
  // search.inputRef to ref= makes the compiler treat the whole object as a
  // ref container and flag every other read as a ref access during render.
  const { open, query, setQuery, inputRef, handleKeyDown, openAndFocus, clear } = search

  // Deepens the glass once the page moves, so the bar reads as a distinct
  // surface over content but stays quiet at rest.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`topbar${scrolled ? ' is-scrolled' : ''}`}>
      {/* Desktop keeps the wordmark in the rail; on mobile the rail is
          off-canvas, so the bar carries the brand instead. */}
      <Link to="/" className="topbar-brand">
        <span className="topbar-brand-mark"><LogoIcon /></span>
        <span className="topbar-brand-text">Diskovarr</span>
      </Link>

      <div className="topbar-actions">
        <div className={`nav-search-wrap${open ? ' expanded' : ''}`} ref={searchWrapRef}>
          <button
            className="nav-search-toggle"
            onClick={openAndFocus}
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
              ref={inputRef}
              type="search"
              className="nav-search-input"
              placeholder={t('Search movies & shows...')}
              autoComplete="off"
              spellCheck="false"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {query && (
              <button type="button" className="nav-search-clear" onClick={clear} aria-label={t('Clear')}>✕</button>
            )}
          </div>
        </div>

        {availableSources.length > 1 && (
          <div className="nav-source-toggle" role="group" aria-label={t('Library source')}>
            {availableSources.map(src => (
              <button
                key={src}
                className={`nav-source-btn${activeSource === src ? ' active' : ''}`}
                onClick={() => onSourceChange(src)}
                title={src === 'plex' ? 'Plex' : 'Jellyfin'}
              >
                {src === 'plex' ? 'Plex' : 'Jellyfin'}
              </button>
            ))}
          </div>
        )}

        <button
          ref={bellBtnRef}
          className="topbar-bell"
          onClick={onBellClick}
          aria-label={t('Notifications')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          {bellCount > 0 && (
            <span className="topbar-bell-count">{bellCount > 99 ? '99+' : bellCount}</span>
          )}
        </button>
      </div>
    </header>
  )
}
