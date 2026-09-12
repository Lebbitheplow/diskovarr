import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import RequestModal from './RequestModal'
import {
  libraryApi,
  watchlistApi,
  issuesApi,
  exploreApi,
  searchApi,
} from '../services/api'
import { useToast } from '../context/ToastContext'
import CastCrewTab from './CastCrewTab'
import RatingBadges from './RatingBadges'
import MonitorDropdown from './MonitorManager/MonitorDropdown'
import { posterUrl } from '../utils/media'
import useCastPlayer from '../hooks/useCastPlayer'
import useMissingSeasons from '../hooks/useMissingSeasons'
import { useTranslation } from 'react-i18next'

const CAST_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" style={{ verticalAlign: '-2px', marginRight: '6px' }}>
    <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.14 7.03 9 1 10zm20-7H3C1.9 3 1 3.9 1 5v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
  </svg>
)


function ReportIssueForm({ item }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [reported, setReported] = useState(false)
  const [error, setError] = useState(null)
  const { success } = useToast()

  const isShow = item.type === 'show' || item.mediaType === 'tv'
  const [scope, setScope] = useState('series')
  const [season, setSeason] = useState('')
  const [episode, setEpisode] = useState('')
  const [missing, setMissing] = useState(false)
  const [description, setDescription] = useState('')

  // The "missing" flag only applies to a specific season/episode of a show.
  const canMarkMissing = isShow && (scope === 'season' || scope === 'episode')

  const handleSubmit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await issuesApi.createIssue({
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'show' : 'movie',
        posterPath: item.thumb || null,
        scope,
        scopeSeason: isShow ? (parseInt(season) || null) : null,
        scopeEpisode: isShow && scope === 'episode' ? (parseInt(episode) || null) : null,
        missing: canMarkMissing ? missing : false,
        description: description.trim() || null,
      })
      success('Issue reported')
      setReported(true)
      setOpen(false)
    } catch (e) {
      setError(e.message || 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (reported) return (
    <button className="modal-btn modal-btn-dismiss" style={{ background: 'rgba(0,180,216,0.08)', color: '#00b4d8', borderColor: 'rgba(0,180,216,0.2)', width: '100%', cursor: 'default' }}>
      {t('✓ Issue Reported')}
    </button>
  )

  return (
    <div style={{ width: '100%' }}>
      <button
        className="modal-btn modal-btn-dismiss"
        style={{ background: 'rgba(0,180,216,0.08)', color: '#00b4d8', borderColor: 'rgba(0,180,216,0.2)' }}
        onClick={() => setOpen(!open)}
      >
        {open ? '▲ Close Report' : '⚑ Report Issue'}
      </button>
      {open && (
        <div style={{ marginTop: '10px', padding: '12px', background: 'var(--bg-elevated)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          {isShow && (
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Scope')}</label>
              <select className="filter-select" value={scope} onChange={e => setScope(e.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: '0.85rem' }}>
                <option value="series">{t('Entire Series')}</option>
                <option value="season">{t('Specific Season')}</option>
                <option value="episode">{t('Specific Episode')}</option>
              </select>
            </div>
          )}
          {isShow && (scope === 'season' || scope === 'episode') && (
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Season Number')}</label>
              <input type="number" min="1" className="filter-select" value={season} onChange={e => setSeason(e.target.value)} style={{ width: '80px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: '0.85rem' }} />
            </div>
          )}
          {isShow && scope === 'episode' && (
            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Episode Number')}</label>
              <input type="number" min="1" className="filter-select" value={episode} onChange={e => setEpisode(e.target.value)} style={{ width: '80px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: '0.85rem' }} />
            </div>
          )}
          {canMarkMissing && (
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '10px', fontSize: '0.82rem', color: 'var(--text)', cursor: 'pointer' }}>
              <input type="checkbox" className="bulk-checkbox" checked={missing} onChange={e => setMissing(e.target.checked)} style={{ marginTop: '2px' }} />
              <span>{t('This content is missing from the library')}
                <span style={{ display: 'block', fontSize: '0.74rem', color: 'var(--text-secondary)' }}>{t('Automatically queues a search for it in the default request app')}</span>
              </span>
            </label>
          )}
          <div style={{ marginBottom: '10px' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>Description (optional)</label>
            <textarea className="filter-select" placeholder={t('Describe the problem...')} value={description} onChange={e => setDescription(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', fontSize: '0.85rem', resize: 'vertical', minHeight: '70px', fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </div>
          {error && <div style={{ fontSize: '0.78rem', color: '#ff5252', marginBottom: '8px' }}>Error: {error}</div>}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button className="chip-sm" onClick={() => setOpen(false)} style={{ padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '0.82rem', cursor: 'pointer' }}>{t('Cancel')}</button>
            <button className="chip-sm" onClick={handleSubmit} disabled={submitting} style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', background: 'rgba(0,180,216,0.18)', color: '#00b4d8', fontSize: '0.82rem', fontWeight: '600', cursor: 'pointer' }}>
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DetailModal({ item, onClose, onRefresh, onRequest }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [trailerKey, setTrailerKey] = useState(null)
  const [trailerLoading, setTrailerLoading] = useState(!!item?.tmdbId)
  // Reset trailer state when the viewed item changes. This render-phase
  // adjustment is React's recommended alternative to a state-resetting effect.
  const [prevTrailerTmdbId, setPrevTrailerTmdbId] = useState(item?.tmdbId)
  if (item?.tmdbId !== prevTrailerTmdbId) {
    setPrevTrailerTmdbId(item?.tmdbId)
    setTrailerKey(null)
    setTrailerLoading(!!item?.tmdbId)
  }
  const [inWatchlist, setInWatchlist] = useState(item?.isInWatchlist || false)
  const { castOpen, castLoading, castingId, clients, handleCastClick, handleCastMedia, canCast, noClientsMessage } = useCastPlayer()
  const [activeTab, setActiveTab] = useState('overview')
  const [credits, setCredits] = useState(
    item?.structuredCast ? { cast: item.structuredCast, crew: item.structuredCrew } : null
  )
  const [creditsLoading, setCreditsLoading] = useState(!item?.structuredCast && !!item?.tmdbId)
  // RT scores live on the Plex library item. Pages that build modal items without
  // them (Reviews, profiles…) can still get them via a lazy getDetails fetch below.
  const [fetchedRatings, setFetchedRatings] = useState(null)
  // Search results arrive before their TMDB details pass has run (enriched:
  // false) — credits, studio and content rating fill in from getDetails here.
  const [fetchedMeta, setFetchedMeta] = useState(null)
  const [prevCreditsTmdbId, setPrevCreditsTmdbId] = useState(item?.tmdbId)
  if (item?.tmdbId !== prevCreditsTmdbId) {
    setPrevCreditsTmdbId(item?.tmdbId)
    setActiveTab('overview')
    setCredits(item?.structuredCast ? { cast: item.structuredCast, crew: item.structuredCrew } : null)
    setCreditsLoading(!item?.structuredCast && !!item?.tmdbId)
    setFetchedRatings(null)
    setFetchedMeta(null)
  }
  // "Request missing seasons" for a show the library already has. Pages that
  // own a RequestModal (Search, Explore) receive the item through onRequest;
  // the rest (Home, Discover, Queue, profiles) get one rendered from here.
  const [missingItem, setMissingItem] = useState(null)
  const [services, setServices] = useState(null)
  const trailerRef = useRef(null)
  const { success, error: toastError } = useToast()

  const inLibrary = item?.inLibrary ?? !!item?.ratingKey
  // Only offer "Request missing seasons" when the library copy is actually
  // short a season that isn't already requested.
  const hasMissingSeasons = useMissingSeasons(item)

  const handleWatchlist = useCallback(async () => {
    try {
      if (inWatchlist) {
        await watchlistApi.removeFromWatchlist(item.ratingKey)
        setInWatchlist(false)
        success('Removed from watchlist')
      } else {
        await watchlistApi.addToWatchlist(item.ratingKey)
        setInWatchlist(true)
        success('Added to watchlist')
      }
      if (onRefresh) onRefresh(item.ratingKey)
    } catch (e) {
      toastError(e.message || t('Watchlist action failed'))
    }
  }, [item, inWatchlist, onRefresh, success, toastError, t])

  const handleDismiss = useCallback(async () => {
    try {
      if (inLibrary) {
        await libraryApi.dismissItem(item.ratingKey)
        if (onRefresh) onRefresh(item.ratingKey)
      } else {
        await exploreApi.dismissRecommendation(item.tmdbId, item.mediaType)
      }
      onClose()
    } catch (e) {
      toastError(e.message || t('Dismiss failed'))
    }
  }, [item, inLibrary, onClose, onRefresh, toastError, t])

  const handleNotify = useCallback(async () => {
    try {
      await exploreApi.followRecommendation(item.tmdbId, item.mediaType)
      success('You\'ll be notified when ' + item.title + ' is available')
      onClose()
    } catch (e) {
      toastError(e.message || t('Notify failed'))
    }
  }, [item, success, toastError, onClose, t])

  const handleRequest = useCallback(() => {
    if (onRequest) {
      onRequest(item)
      onClose()
    }
  }, [onRequest, item, onClose])

  const handleRequestMissing = useCallback(async () => {
    const reqItem = {
      ...item,
      tmdbId: item.tmdbId,
      tvdbId: item.tvdbId || null,
      mediaType: 'tv',
      title: item.title,
      year: item.year || null,
      ratingKey: item.ratingKey || null,
      inLibrary: true,
    }
    if (onRequest) {
      onRequest(reqItem)
      onClose()
      return
    }
    if (!services) {
      try {
        const { data } = await exploreApi.getServices()
        setServices(data || {})
      } catch {
        setServices({})
      }
    }
    setMissingItem(reqItem)
  }, [item, onRequest, onClose, services])

  // Jump to the search page's "More with X" browse for a cast/crew member.
  const handlePersonClick = useCallback((person) => {
    if (!person?.id) return
    const params = new URLSearchParams()
    params.set('personId', person.id)
    if (person.name) params.set('personName', person.name)
    onClose()
    navigate('/search?' + params.toString())
  }, [navigate, onClose])

  const handleMonitorCast = useCallback(async (person) => {
    if (!person?.name) return
    const { monitorsApi } = await import('../services/monitorsApi')
    try {
      await monitorsApi.quickCreate({
        name: `All content with ${person.name}`,
        criteria: [{ type: 'cast', entityName: person.name }],
      })
      success(`Monitoring "${person.name}"`)
    } catch (err) {
      toastError(t('Failed to create monitor'))
    }
  }, [success, toastError, t])

  useEffect(() => {
    if (!item?.tmdbId) return
    const mt = item.type === 'movie' || item.mediaType === 'movie' ? 'movie' : 'tv'
    let active = true
    libraryApi.getTrailer(item.tmdbId, mt)
      .then(({ data }) => {
        if (active && data.trailerKey) setTrailerKey(data.trailerKey)
      })
      .catch(() => {})
      .finally(() => { if (active) setTrailerLoading(false) })

    const trailerEl = trailerRef.current
    return () => {
      active = false
      if (trailerEl) {
        trailerEl.innerHTML = ''
        trailerEl.classList.remove('active')
      }
    }
  }, [item?.tmdbId, item?.type, item?.mediaType])

  // Lazy fetch structured credits and/or RT scores when the parent didn't provide
  // them. Both come from getDetails, so a single fetch covers either gap.
  const hasItemRatings = !!(item?.ratingImage || item?.audienceRatingImage || item?.rating || item?.audienceRating)
  const itemUnenriched = item?.enriched === false
  useEffect(() => {
    if (!item?.tmdbId) return
    const needCredits = !credits && creditsLoading
    const needRatings = !hasItemRatings && !fetchedRatings
    const needMeta = itemUnenriched && !fetchedMeta
    if (!needCredits && !needRatings && !needMeta) return
    const mediaType = item.mediaType || (item.type === 'show' ? 'tv' : 'movie')
    let active = true
    searchApi.getDetails(item.tmdbId, mediaType)
      .then(({ data }) => {
        if (!active) return
        if (needCredits) {
          setCredits({ cast: data.structuredCast || [], crew: data.structuredCrew || [] })
        }
        if (needRatings) {
          setFetchedRatings({
            rating: data.rating || null,
            ratingImage: data.ratingImage || null,
            audienceRating: data.audienceRating || null,
            audienceRatingImage: data.audienceRatingImage || null,
          })
        }
        if (needMeta) {
          setFetchedMeta({
            overview: data.overview || '',
            genres: data.genres || [],
            directors: data.directors || [],
            cast: data.cast || [],
            studio: data.studio || '',
            contentRating: data.contentRating || null,
          })
        }
      })
      .catch(() => {
        if (!active) return
        if (needCredits) setCredits({ cast: [], crew: [] })
        if (needRatings) setFetchedRatings({})
        if (needMeta) setFetchedMeta({})
      })
      .finally(() => { if (active) setCreditsLoading(false) })
    return () => { active = false }
  }, [item?.tmdbId, item?.mediaType, item?.type, credits, creditsLoading, hasItemRatings, fetchedRatings, itemUnenriched, fetchedMeta])

  // Set when a popstate closed us, so the unmount cleanup doesn't pop again.
  const closedByPopRef = useRef(false)

  const handleClose = useCallback(() => {
    if (trailerRef.current) {
      trailerRef.current.innerHTML = ''
      trailerRef.current.classList.remove('active')
    }
    onClose()
  }, [onClose])

  // Escape closes, matching the shared Modal component. Routed through
  // handleClose so the trailer iframe is torn down rather than left playing.
  // While the missing-seasons dialog is up, Escape belongs to it instead.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !missingItem) handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleClose, missingItem])

  // Give the modal its own history entry so Android's Back gesture and the
  // browser's back button close it instead of leaving the page. Closing by any
  // other route calls history.back(), which pops that entry and lands here too,
  // so both paths converge on a single close.
  useEffect(() => {
    window.history.pushState({ diskovarrModal: true }, '')
    const onPop = () => { closedByPopRef.current = true; handleClose() }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Unmounted without the entry being popped (route change while open):
      // drop it so Back doesn't have to be pressed twice to leave.
      if (!closedByPopRef.current) window.history.back()
    }
    // Mounts once per modal — handleClose only changes with onClose, which the
    // pages keep stable, and re-running this would push duplicate entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!item) return null

  const isShow = item.type === 'show' || item.mediaType === 'tv'
  const mediaTypeLabel = isShow ? 'TV Show' : (item.isAnime ? 'Anime' : 'Movie')
  const metaParts = []
  if (item.year) metaParts.push(item.year)
  metaParts.push(mediaTypeLabel)
  const heroPath = item.art || item.thumb
  // Overview-tab fields, with the lazily fetched details filling any gaps
  const view = fetchedMeta ? { ...item, ...fetchedMeta } : item

  return (
    <div className="detail-modal-wrap open" aria-hidden="false" onClick={handleClose}>
      <div className="detail-modal-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <button className="detail-modal-close" onClick={handleClose} aria-label={t('Close')}>✕</button>
        {heroPath && (
          <div className="detail-modal-hero" style={{ backgroundImage: `url(${posterUrl(heroPath)})` }} />
        )}
        <div className="detail-modal-body" style={!heroPath ? { marginTop: '0', paddingTop: '22px' } : {}}>
          <img className="detail-modal-poster" src={posterUrl(item.thumb)} alt={item.title} style={item.thumb ? {} : { display: 'none' }} />
          <div className="detail-modal-info" style={!heroPath ? { paddingTop: '0' } : {}}>
            <div className="detail-modal-title">{item.title}</div>
            <div className="detail-modal-meta">
              {metaParts.join(' · ')}
              {view.contentRating && (
                <>
                  {' · '}
                  <span className={'content-rating-badge rating-' + view.contentRating.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}>{view.contentRating}</span>
                </>
              )}
              {item.isWatched && (
                <>
                  {' · '}
                  <span className="modal-watched-pill">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="11" height="11"><polyline points="20 6 9 17 4 12" /></svg> {t('Watched')}
                  </span>
                </>
              )}
            </div>
            <RatingBadges item={hasItemRatings ? item : { ...item, ...(fetchedRatings || {}) }} />
            <div className="detail-modal-reasons">
              {(item.reasons || []).filter(r => r && r.trim()).slice(0, 3).map((r, i) => (
                <span key={i} className="reason-tag"><span className="reason-tag-text">{r}</span></span>
              ))}
            </div>
            <div className="detail-modal-genres">
              {(view.genres || []).filter(g => g && g.trim()).slice(0, 5).map((g, i) => (
                <span key={i} className="genre-tag">{g}</span>
              ))}
            </div>
            <div className="detail-modal-tabs">
              <button
                className={'detail-modal-tab' + (activeTab === 'overview' ? ' active' : '')}
                onClick={() => setActiveTab('overview')}
              >
                {t('Overview')}
              </button>
              <button
                className={'detail-modal-tab' + (activeTab === 'castcrew' ? ' active' : '')}
                onClick={() => setActiveTab('castcrew')}
              >
                {t('Cast & Crew')}
              </button>
            </div>
            {activeTab === 'overview' ? (
              <>
                <p className="detail-modal-overview">{view.summary || view.overview || ''}</p>
                <div className="detail-modal-credits">
                  {view.directors && view.directors.length > 0 && (
                    <div className="detail-credit-row">
                      <span className="detail-credit-label">{isShow ? 'Created by' : 'Director'}:</span> {view.directors.join(', ')}
                    </div>
                  )}
                  {view.cast && view.cast.length > 0 && (
                    <div className="detail-credit-row">
                      <span className="detail-credit-label">{t('Cast:')}</span> {view.cast.slice(0, 6).join(', ')}
                    </div>
                  )}
                  {view.studio && (
                    <div className="detail-credit-row">
                      <span className="detail-credit-label">{isShow ? 'Network' : 'Studio'}:</span> {view.studio}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <CastCrewTab
                cast={credits?.cast}
                crew={credits?.crew}
                loading={creditsLoading}
                mediaType={item.mediaType || (item.type === 'show' ? 'tv' : 'movie')}
                onPersonClick={handlePersonClick}
                onMonitorCast={handleMonitorCast}
              />
            )}
            <div className="detail-modal-actions">
              {inLibrary ? (
                <>
                  <button className={'modal-btn modal-btn-watchlist' + (inWatchlist ? ' in-watchlist' : '')} onClick={handleWatchlist}>
                    {inWatchlist ? '✓ In Watchlist' : '+ Watchlist'}
                  </button>
                  {canCast(item) && (
                    <div className="modal-cast-wrap">
                      <button className="modal-btn modal-btn-cast" onClick={() => handleCastClick(item)} disabled={castLoading} style={{ display: castLoading ? 'flex' : 'inline-flex' }}>
                        {castLoading ? '…' : CAST_ICON}
                      </button>
                      {castOpen && !castLoading && (
                        <div className="modal-cast-picker">
                          {clients.length === 0 && <span className="cast-no-clients">{noClientsMessage}</span>}
                          {clients.map(client => (
                            <button key={client.machineIdentifier} className="cast-client-btn" onClick={() => handleCastMedia(item, client)} disabled={!!castingId}>
                              {castingId === client.machineIdentifier
                                ? t('Casting…')
                                : client.name + (client.product ? ' · ' + client.product : '')}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {isShow && item.tmdbId && hasMissingSeasons && (
                    <button
                      className="modal-btn modal-btn-watchlist"
                      onClick={handleRequestMissing}
                      style={{ background: 'rgba(0,180,216,0.18)', color: '#00b4d8' }}
                    >
                      {t('Request missing seasons')}
                    </button>
                  )}
                  <MonitorDropdown item={item} />
                  <button className="modal-btn modal-btn-dismiss" onClick={handleDismiss}>{t('✕ Not Interested')}</button>
                  <ReportIssueForm item={item} />
                </>
              ) : (
                <>
                  <button
                    className={'modal-btn modal-btn-watchlist' + (item.isRequested ? ' in-watchlist' : '')}
                    onClick={item.isRequested ? handleNotify : handleRequest}
                    style={{ background: item.isRequested ? 'rgba(255,193,7,0.12)' : 'rgba(0,180,216,0.18)', color: item.isRequested ? '#ffc107' : '#00b4d8' }}
                  >
                    {item.isRequested ? 'Notify Me' : 'Request'}
                  </button>
                  <MonitorDropdown item={item} />
                  <button className="modal-btn modal-btn-dismiss" onClick={handleDismiss}>{t('✕ Not Interested')}</button>
                  {item.tmdbId && (
                    <a className="modal-btn modal-btn-dismiss" href={`https://www.themoviedb.org/${item.mediaType === 'tv' ? 'tv' : 'movie'}/${item.tmdbId}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', cursor: 'pointer' }}>
                      {t('View on TMDB')}
                    </a>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        {(trailerKey || trailerLoading) && (
          <div ref={trailerRef} className={'detail-modal-trailer' + (trailerKey ? ' active' : '')}>
            {trailerKey && (
              <iframe
                // youtube-nocookie.com: same player, but YouTube does not set its
                // tracking cookies unless the video is actually played.
                src={`https://www.youtube-nocookie.com/embed/${trailerKey}?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1`}
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
              />
            )}
          </div>
        )}
        {missingItem && createPortal(
          // Stops the dialog's backdrop click from bubbling (in React's tree)
          // up to the detail wrapper's close handler.
          <div onClick={e => e.stopPropagation()}>
            <RequestModal item={missingItem} services={services || {}} onClose={() => setMissingItem(null)} />
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}
