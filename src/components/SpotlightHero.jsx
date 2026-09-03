import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { posterUrl } from '../utils/media'
import useCastPlayer from '../hooks/useCastPlayer'

const CAST_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style={{ verticalAlign: '-3px', marginRight: '6px' }} aria-hidden="true">
    <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.14 7.03 9 1 10zm20-7H3C1.9 3 1 3.9 1 5v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
  </svg>
)

const ROTATE_MS = 7000
const MAX_SLIDES = 5
const REDUCED = '(prefers-reduced-motion: reduce)'

// Plex reports durations in milliseconds.
function runtime(ms) {
  if (!ms || ms < 60000) return null
  const total = Math.round(ms / 60000)
  const h = Math.floor(total / 60)
  const m = total % 60
  return h ? `${h}h ${m}m` : `${m}m`
}

// Normalises the two item shapes this hero is fed. Home passes library rows
// (Plex `art` path, `summary`, `duration`); Explore passes TMDB rows
// (absolute `backdropUrl`, `overview`, no runtime). posterUrl() leaves
// absolute URLs alone, so one call covers both.
function normalise(item) {
  return {
    art: posterUrl(item.art || item.backdropUrl),
    rating: item.audienceRating || item.voteAverage || 0,
    genres: (item.genres || []).slice(0, 2),
    length: runtime(item.duration),
    overview: item.summary || item.overview || '',
    reason: item.reasons?.find(r => r && r.trim()),
    contentRating: item.contentRating || '',
  }
}

/**
 * Cinematic spotlight that cycles through the strongest recommendations.
 *
 * Shared by Home and Explore. Which actions appear is driven by the item
 * itself rather than a variant flag: a library row has a `deepLink` and a
 * `ratingKey` so it offers Play and Watchlist, while an Explore row has
 * neither and offers Request instead — the same rule the cards already use.
 *
 * Auto-rotation pauses on hover, on keyboard focus, and while the tab is
 * hidden, and never starts at all under prefers-reduced-motion.
 */
export default function SpotlightHero({
  items, loading,
  onOpenModal, onToggleWatchlist, onRequest, onNotify,
  isInWatchlist,
}) {
  const { t } = useTranslation()
  const { castOpen, castLoading, castingId, clients, handleCastClick, handleCastMedia, canCast, noClientsMessage } = useCastPlayer()
  const slides = (items || []).filter(Boolean).slice(0, MAX_SLIDES)
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  const reduced = useRef(false)

  useEffect(() => {
    reduced.current = window.matchMedia(REDUCED).matches
  }, [])

  // Derived rather than synced: if the list shrinks under us (a dismiss, a
  // filter change) the stored index can briefly point past the end, and
  // clamping here avoids an effect that would only exist to fix up state.
  const count = slides.length
  const current = active < count ? active : 0
  // The slide being replaced. Rotation only ever moves forward, so this is
  // the one that should exit to the left; a dot jump just cross-fades.
  const outgoing = count ? (current - 1 + count) % count : 0

  useEffect(() => {
    if (count < 2 || paused || reduced.current) return
    const id = setInterval(() => setActive((i) => (i + 1) % count), ROTATE_MS)
    return () => clearInterval(id)
  }, [count, paused])

  // Don't burn through the rotation in a background tab
  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const go = useCallback((i) => {
    setActive(i)
  }, [])

  if (loading) return <section className="spotlight spotlight-loading" aria-hidden="true" />
  if (!count) return null

  const item = slides[current]
  const d = normalise(item)

  return (
    <section
      className="spotlight"
      aria-roledescription="carousel"
      aria-label={t('Top picks for you')}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {/* Every slide's art stays mounted so switching is a cross-slide rather
          than a fresh image load. The zoom lives on an inner element — the
          outer one owns the slide transform. */}
      <div className="spotlight-stage" aria-hidden="true">
        {slides.map((s, i) => {
          const art = posterUrl(s.art || s.backdropUrl)
          const fallback = posterUrl(s.thumb || s.posterUrl)
          return (
            <div
              key={s.tmdbId ? `${s.tmdbId}:${s.mediaType || ''}` : (s.ratingKey || i)}
              className={`spotlight-slide${i === current ? ' is-active' : ''}${i === outgoing ? ' is-prev' : ''}`}
            >
              <div
                className={`spotlight-art${art ? '' : ' spotlight-art-poster'}`}
                style={{ backgroundImage: `url(${art || fallback})` }}
              />
            </div>
          )
        })}
      </div>
      <div className="spotlight-scrim" aria-hidden="true" />

      {/* Keyed so the copy replays its entrance as the spotlight advances */}
      <div className="spotlight-body" key={current}>
        <p className="spotlight-eyebrow">
          <span className="spotlight-rule" aria-hidden="true" />
          {t('Top pick for you')}
        </p>
        <h1 className="spotlight-title">{item.title}</h1>

        <div className="spotlight-meta">
          {d.rating > 0 && <span className="spotlight-score">★ {Number(d.rating).toFixed(1)}</span>}
          {item.year && <span>{item.year}</span>}
          {d.genres.map(g => <span key={g}>{g}</span>)}
          {d.length && <span>{d.length}</span>}
          {d.contentRating && <span className="spotlight-cert">{d.contentRating}</span>}
        </div>

        {d.overview && <p className="spotlight-overview">{d.overview}</p>}
        {d.reason && <p className="spotlight-reason">{d.reason}</p>}

        <div className="spotlight-actions">
          {canCast(item) && (
            <div className="spotlight-cast-wrap">
              <button
                className="spotlight-btn spotlight-btn-play"
                onClick={() => handleCastClick(item)}
                disabled={castLoading}
              >
                {CAST_ICON}{castLoading ? t('Loading…') : t('Play')}
              </button>
              {castOpen && !castLoading && (
                <div className="spotlight-cast-picker">
                  {clients.length === 0 && (
                    <span className="cast-no-clients">{noClientsMessage}</span>
                  )}
                  {clients.map(client => (
                    <button
                      key={client.machineIdentifier}
                      className="cast-client-btn"
                      onClick={() => handleCastMedia(item, client)}
                      disabled={!!castingId}
                    >
                      {castingId === client.machineIdentifier
                        ? t('Casting…')
                        : client.name + (client.product ? ' · ' + client.product : '')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {item.ratingKey && onToggleWatchlist && (
            <button
              className={`spotlight-btn spotlight-btn-ghost${isInWatchlist?.(item) ? ' active' : ''}`}
              onClick={() => onToggleWatchlist(item)}
            >
              {isInWatchlist?.(item) ? '✓ ' + t('In Watchlist') : '+ ' + t('Watchlist')}
            </button>
          )}
          {!item.ratingKey && onRequest && (
            <button
              className="spotlight-btn spotlight-btn-play"
              onClick={() => (item.isRequested ? onNotify?.(item) : onRequest(item))}
              disabled={item.isMyRequest}
            >
              {item.isMyRequest
                ? t('Requested') + ' ✓'
                : item.isRequested ? t('Notify Me') : t('Request')}
            </button>
          )}
          <button className="spotlight-btn spotlight-btn-ghost" onClick={() => onOpenModal(item)}>
            {t('Details')}
          </button>
        </div>
      </div>

      {count > 1 && (
        <div className="spotlight-dots" role="tablist" aria-label={t('Choose a top pick')}>
          {slides.map((s, i) => (
            <button
              key={s.tmdbId ? `${s.tmdbId}:${s.mediaType || ''}` : (s.ratingKey || i)}
              className={`spotlight-dot${i === current ? ' is-active' : ''}`}
              onClick={() => go(i)}
              role="tab"
              aria-selected={i === current}
              aria-label={s.title}
            />
          ))}
        </div>
      )}
    </section>
  )
}
