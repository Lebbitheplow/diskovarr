import React, { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  plexApi,
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
import { useTranslation } from 'react-i18next'

const CAST_ICON = (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" style={{ verticalAlign: '-2px', marginRight: '6px' }}>
    <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2C12 14.14 7.03 9 1 10zm20-7H3C1.9 3 1 3.9 1 5v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
  </svg>
)


function CastPicker({ item, onClose }) {
  const { t } = useTranslation()
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const { success, error: toastError } = useToast()

  const handleCast = useCallback(async (client) => {
    try {
      await plexApi.castMedia({ ratingKey: item.ratingKey, clientId: client.machineIdentifier })
      success('Playing on ' + client.name)
      onClose()
    } catch (e) {
      toastError(e.message || t('Cast failed'))
    }
  }, [item.ratingKey, onClose, success, toastError, t])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data } = await plexApi.getClients()
        if (active) setClients(data.clients || [])
      } catch (e) {
        if (active) setError('Could not fetch clients')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  if (loading) return <div className="modal-cast-picker"><span>…</span></div>
  if (error) return <div className="modal-cast-picker"><span className="cast-no-clients">{error}</span></div>
  if (clients.length === 0) return <div className="modal-cast-picker"><span className="cast-no-clients">{t('No Plex clients found.')}<br />{t('Open your Plex app on your TV first.')}</span></div>

  return (
    <div className="modal-cast-picker">
      {clients.map(client => (
        <button key={client.machineIdentifier} className="cast-client-btn" onClick={() => handleCast(client)}>
          {client.name}{client.product ? ' · ' + client.product : ''}
        </button>
      ))}
    </div>
  )
}

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
  const [description, setDescription] = useState('')

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
  const [castOpen, setCastOpen] = useState(false)
  const [castLoading, setCastLoading] = useState(false)
  const [clients, setClients] = useState([])
  const [activeTab, setActiveTab] = useState('overview')
  const [credits, setCredits] = useState(
    item?.structuredCast ? { cast: item.structuredCast, crew: item.structuredCrew } : null
  )
  const [creditsLoading, setCreditsLoading] = useState(!item?.structuredCast && !!item?.tmdbId)
  // RT scores live on the Plex library item. Pages that build modal items without
  // them (Reviews, profiles…) can still get them via a lazy getDetails fetch below.
  const [fetchedRatings, setFetchedRatings] = useState(null)
  const [prevCreditsTmdbId, setPrevCreditsTmdbId] = useState(item?.tmdbId)
  if (item?.tmdbId !== prevCreditsTmdbId) {
    setPrevCreditsTmdbId(item?.tmdbId)
    setActiveTab('overview')
    setCredits(item?.structuredCast ? { cast: item.structuredCast, crew: item.structuredCrew } : null)
    setCreditsLoading(!item?.structuredCast && !!item?.tmdbId)
    setFetchedRatings(null)
  }
  const trailerRef = useRef(null)
  const { success, error: toastError } = useToast()

  const inLibrary = item?.inLibrary ?? !!item?.ratingKey

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
        await plexApi.dismissItem(item.ratingKey)
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

  const handleCastClick = useCallback(async () => {
    if (castOpen) {
      setCastOpen(false)
      return
    }
    setCastLoading(true)
    try {
      const { data } = await plexApi.getClients()
      setClients(data.clients || [])
      setCastOpen(true)
    } catch (e) {
      toastError(t('Could not fetch clients'))
    } finally {
      setCastLoading(false)
    }
  }, [castOpen, toastError, t])

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

  const handleCastMedia = useCallback(async (client) => {
    try {
      await plexApi.castMedia({ ratingKey: item.ratingKey, clientId: client.machineIdentifier })
      success('Playing on ' + client.name)
      setCastOpen(false)
    } catch (e) {
      toastError(e.message || t('Cast failed'))
    }
  }, [item, success, toastError, t])

  useEffect(() => {
    if (!item?.tmdbId) return
    const mt = item.type === 'movie' || item.mediaType === 'movie' ? 'movie' : 'tv'
    let active = true
    plexApi.getTrailer(item.tmdbId, mt)
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
  useEffect(() => {
    if (!item?.tmdbId) return
    const needCredits = !credits && creditsLoading
    const needRatings = !hasItemRatings && !fetchedRatings
    if (!needCredits && !needRatings) return
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
      })
      .catch(() => {
        if (!active) return
        if (needCredits) setCredits({ cast: [], crew: [] })
        if (needRatings) setFetchedRatings({})
      })
      .finally(() => { if (active) setCreditsLoading(false) })
    return () => { active = false }
  }, [item?.tmdbId, item?.mediaType, item?.type, credits, creditsLoading, hasItemRatings, fetchedRatings])

  const handleClose = useCallback(() => {
    if (trailerRef.current) {
      trailerRef.current.innerHTML = ''
      trailerRef.current.classList.remove('active')
    }
    onClose()
  }, [onClose])

  if (!item) return null

  const mediaTypeLabel = item.type === 'show' ? 'TV Show' : (item.isAnime ? 'Anime' : 'Movie')
  const metaParts = []
  if (item.year) metaParts.push(item.year)
  metaParts.push(mediaTypeLabel)
  const heroPath = item.art || item.thumb

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
              {item.contentRating && (
                <>
                  {' · '}
                  <span className={'content-rating-badge rating-' + item.contentRating.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}>{item.contentRating}</span>
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
              {(item.genres || []).filter(g => g && g.trim()).slice(0, 5).map((g, i) => (
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
                <p className="detail-modal-overview">{item.summary || item.overview || ''}</p>
                <div className="detail-modal-credits">
                  {item.directors && item.directors.length > 0 && (
                    <div className="detail-credit-row">
                      <span className="detail-credit-label">{item.type === 'show' ? 'Created by' : 'Director'}:</span> {item.directors.join(', ')}
                    </div>
                  )}
                  {item.cast && item.cast.length > 0 && (
                    <div className="detail-credit-row">
                      <span className="detail-credit-label">{t('Cast:')}</span> {item.cast.slice(0, 6).join(', ')}
                    </div>
                  )}
                  {item.studio && (
                    <div className="detail-credit-row">
                      <span className="detail-credit-label">{item.type === 'show' ? 'Network' : 'Studio'}:</span> {item.studio}
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
                  {item.ratingKey && (
                    <div className="modal-cast-wrap">
                      <button className="modal-btn modal-btn-cast" onClick={handleCastClick} disabled={castLoading} style={{ display: castLoading ? 'flex' : 'inline-flex' }}>
                        {castLoading ? '…' : CAST_ICON}
                      </button>
                      {castOpen && !castLoading && (
                        <div className="modal-cast-picker">
                          {clients.length === 0 && <span className="cast-no-clients">{t('No Plex clients found.')}<br />{t('Open your Plex app on your TV first.')}</span>}
                          {clients.map(client => (
                            <button key={client.machineIdentifier} className="cast-client-btn" onClick={() => handleCastMedia(client)}>
                              {client.name}{client.product ? ' · ' + client.product : ''}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
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
                src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&mute=1&rel=0&modestbranding=1&playsinline=1`}
                allow="autoplay; encrypted-media; fullscreen"
                allowFullScreen
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
