import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import RequestModal from './RequestModal'
import MovieNightPickerModal from './MovieNightPickerModal'
import WatchPartyInviteModal from './WatchPartyInviteModal'
import {
  libraryApi,
  watchlistApi,
  exploreApi,
  searchApi,
  socialReviewsApi,
} from '../services/api'
import { useToast } from '../context/ToastContext'
import CastCrewTab from './CastCrewTab'
import ReviewsTab from './ReviewsTab'
import RatingBadges from './RatingBadges'
import { DetailActionBar, DetailManageRow } from './DetailActions'
import { posterUrl, posterSrcSet, CARD_SIZES } from '../utils/media'
import useMissingSeasons from '../hooks/useMissingSeasons'
import { useTranslation } from 'react-i18next'
import useModalOpen from '../hooks/useModalOpen'
import useDialogLayer from '../hooks/useDialogLayer'

export default function DetailModal({ item, onClose, onRefresh, onRequest }) {
  useModalOpen(!!item)
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
  // Reviews from users on this server — fetched on open so the tab can show a
  // count; TMDB's reviews load inside the tab itself.
  const [serverReviews, setServerReviews] = useState(null)
  const [movieNightOpen, setMovieNightOpen] = useState(false)
  const [watchPartyOpen, setWatchPartyOpen] = useState(false)
  // Requests — the full title, or "Request missing seasons" for a show the
  // library already has. Pages that own a RequestModal (Search, Explore)
  // receive the item through onRequest; the rest (Home deep links, Discover,
  // Queue, Reviews, profiles) get one rendered from here.
  const [requestItem, setRequestItem] = useState(null)
  const [services, setServices] = useState(null)
  // Set once a request made from here goes through, so the primary action
  // turns into Notify Me without the page having to reload the item.
  const [requestedHere, setRequestedHere] = useState(false)
  const [prevCreditsTmdbId, setPrevCreditsTmdbId] = useState(item?.tmdbId)
  if (item?.tmdbId !== prevCreditsTmdbId) {
    setPrevCreditsTmdbId(item?.tmdbId)
    setActiveTab('overview')
    setServerReviews(null)
    setCredits(item?.structuredCast ? { cast: item.structuredCast, crew: item.structuredCrew } : null)
    setCreditsLoading(!item?.structuredCast && !!item?.tmdbId)
    setFetchedRatings(null)
    setFetchedMeta(null)
    setMovieNightOpen(false)
    setRequestItem(null)
    setRequestedHere(false)
  }
  const trailerRef = useRef(null)
  const { success, error: toastError } = useToast()

  const reviewMediaType = item?.mediaType || (item?.type === 'show' ? 'tv' : 'movie')
  useEffect(() => {
    if (!item?.tmdbId) return undefined
    let cancelled = false
    socialReviewsApi.getForMedia(reviewMediaType, item.tmdbId)
      .then(r => { if (!cancelled) setServerReviews(r.data?.reviews || []) })
      .catch(() => { if (!cancelled) setServerReviews([]) })
    return () => { cancelled = true }
  }, [item?.tmdbId, reviewMediaType])

  // restricted: the library holds it only where this user can't see it — no
  // play, request, notify or movie night (the server refuses those too)
  const restricted = !!item?.restricted
  const inLibrary = !restricted && (item?.inLibrary ?? !!item?.ratingKey)
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

  // Opens the RequestModal rendered here, for pages without their own
  const openRequest = useCallback(async (reqItem) => {
    if (!services) {
      try {
        const { data } = await exploreApi.getServices()
        setServices(data || {})
      } catch {
        setServices({})
      }
    }
    setRequestItem(reqItem)
  }, [services])

  const handleRequest = useCallback(() => {
    if (onRequest) {
      onRequest(item)
      onClose()
      return
    }
    // Items built by pages without a request flow sometimes carry only the
    // Plex-style type; RequestModal keys everything off mediaType.
    openRequest({ ...item, mediaType: item.mediaType || (item.type === 'show' ? 'tv' : 'movie') })
  }, [onRequest, item, onClose, openRequest])

  const handleNotify = useCallback(async () => {
    try {
      await exploreApi.followRecommendation(item.tmdbId, item.mediaType)
      success('You\'ll be notified when ' + item.title + ' is available')
      onClose()
    } catch (e) {
      // The request this card was following is gone (denied, withdrawn,
      // fulfilled): offer to request the title instead of a dead end
      if (e.status === 409 && e.details?.requestable) handleRequest()
      else toastError(e.message || t('Notify failed'))
    }
  }, [item, success, toastError, onClose, t, handleRequest])

  const handleRequestMissing = useCallback(() => {
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
    openRequest(reqItem)
  }, [item, onRequest, onClose, openRequest])

  // A whole-title request made here flips the action to Notify Me; missing
  // seasons re-check themselves through useMissingSeasons instead.
  const handleRequestSubmitted = useCallback((reqItem) => {
    if (!reqItem?.inLibrary) setRequestedHere(true)
  }, [])

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
  // The layer stack hands Escape to any dialog opened on top of this one
  // (request, movie night, watch together, share, monitor editor) instead.
  const closeDialogAbove = useDialogLayer(!!item, handleClose)

  // Give the modal its own history entry so Android's Back gesture and the
  // browser's back button close it instead of leaving the page. Closing by any
  // other route calls history.back(), which pops that entry and lands here too,
  // so both paths converge on a single close.
  useEffect(() => {
    window.history.pushState({ diskovarrModal: true }, '')
    const onPop = () => {
      // Back, like Escape, closes only the topmost dialog: with one open on
      // top of this modal, close that and put this modal's entry back so the
      // next Back closes the modal itself.
      if (closeDialogAbove()) {
        window.history.pushState({ diskovarrModal: true }, '')
        return
      }
      closedByPopRef.current = true
      handleClose()
    }
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
          {/* Same srcset and sizes as the cards, so the browser picks the very
              file the clicked card already shows. The poster morph
              (utils/viewTransition) snapshots this image as soon as it
              renders; a different size would still be downloading then, and
              the morph would land on an empty frame. */}
          <img
            className="detail-modal-poster"
            src={posterUrl(item.thumb, 360)}
            srcSet={posterSrcSet(item.thumb)}
            sizes={CARD_SIZES}
            alt={item.title}
            style={item.thumb ? {} : { display: 'none' }}
          />
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
            <DetailActionBar
              item={requestedHere && !item.isRequested ? { ...item, isRequested: true } : item}
              inLibrary={inLibrary}
              restricted={restricted}
              inWatchlist={inWatchlist}
              onWatchlist={handleWatchlist}
              onRequest={handleRequest}
              onNotify={handleNotify}
              onMovieNight={item.tmdbId && !restricted ? () => setMovieNightOpen(true) : null}
              onWatchTogether={() => setWatchPartyOpen(true)}
            />
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
              <button
                className={'detail-modal-tab' + (activeTab === 'reviews' ? ' active' : '')}
                onClick={() => setActiveTab('reviews')}
              >
                {t('Reviews')}{serverReviews?.length ? ` (${serverReviews.length})` : ''}
              </button>
            </div>
            {activeTab === 'reviews' ? (
              <ReviewsTab
                mediaType={reviewMediaType}
                tmdbId={item.tmdbId}
                serverReviews={serverReviews}
                serverLoading={serverReviews === null}
                posterUrl={posterUrl(item.thumb)}
              />
            ) : activeTab === 'overview' ? (
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
            <DetailManageRow
              key={item.ratingKey || `${item.mediaType}:${item.tmdbId}`}
              item={item}
              inLibrary={inLibrary}
              onDismiss={handleDismiss}
              onRequestMissing={isShow && item.tmdbId && hasMissingSeasons ? handleRequestMissing : null}
            />
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
        {requestItem && createPortal(
          // Stops the dialog's backdrop click from bubbling (in React's tree)
          // up to the detail wrapper's close handler.
          <div onClick={e => e.stopPropagation()}>
            <RequestModal
              item={requestItem}
              services={services || {}}
              onClose={() => setRequestItem(null)}
              onSubmitted={handleRequestSubmitted}
            />
          </div>,
          document.body
        )}
        {watchPartyOpen && createPortal(
          <div onClick={e => e.stopPropagation()}>
            <WatchPartyInviteModal
              item={{ ratingKey: item.ratingKey, title: item.title || item.name }}
              onClose={() => setWatchPartyOpen(false)}
            />
          </div>,
          document.body
        )}
        {movieNightOpen && createPortal(
          <div onClick={e => e.stopPropagation()}>
            <MovieNightPickerModal
              item={{
                mediaType: item.mediaType || (item.type === 'show' ? 'tv' : 'movie'),
                tmdbId: item.tmdbId, ratingKey: item.ratingKey,
                title: item.title || item.name, year: item.year, thumb: item.thumb,
              }}
              onClose={() => setMovieNightOpen(false)}
            />
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}
