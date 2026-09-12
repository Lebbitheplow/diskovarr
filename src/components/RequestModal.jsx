import React, { useState, useCallback, useEffect, useMemo } from 'react'
import Modal from './Modal'
import { queueApi, searchApi, tuberrApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'
import { invalidateMissingSeasons } from '../hooks/useMissingSeasons'

// Shared request dialog used by Explore, Search, and DetailModal flows.
// Handles season selection and alternate-service choice. YouTube-sourced items
// (TVDB-only shows, when the admin has enabled YouTube requests) default to the
// YouTube downloader with channel suggestions; any other TV show can opt into
// the same flow with the "Download from YouTube" toggle (T9).
//
// Season chips carry availability: seasons the library already holds in full,
// or that someone has already requested, are grayed out and can't be picked.
// A show that's already in the library only reaches this dialog through
// "Request missing seasons", where the submission is always an explicit list.

// Plain season numbers (TVDB lookups, older API shape) -> chip objects
const seasonFromNumber = (n) => ({ number: Number(n), selectable: true, complete: false, requested: false })

export default function RequestModal({ item, services, onClose, onSubmitted }) {
  const { t } = useTranslation()
  const { error: toastError, success: toastSuccess } = useToast()
  const { user } = useAuth()
  const isAdmin = !!(user?.isAdmin)

  // TVDB-only items can only go to Sonarr (other services key off TMDB ids);
  // they are how YouTube series enter search results, so they get the YouTube flow
  const tvdbOnly = !!item && !item.tmdbId && !!item.tvdbId
  const youtubeAvailable = !!item && item.mediaType === 'tv' && !!services.tuberr && !!services.sonarr
  // TMDB-known shows can opt in; TVDB-only shows are always YouTube (no other service keys off TVDB)
  const [youtubeMode, setYoutubeMode] = useState(false)
  const youtubeOptIn = youtubeAvailable && !tvdbOnly
  const isYoutubeItem = youtubeAvailable && (tvdbOnly || youtubeMode)
  const missingMode = !!item && item.mediaType === 'tv' && !!(item.inLibrary ?? item.ratingKey)
  const needsSeasonFetch = (it) => !!it && it.mediaType === 'tv' && !!it.tmdbId

  const [seasons, setSeasons] = useState([])
  const [seasonsLoading, setSeasonsLoading] = useState(needsSeasonFetch(item))
  const [selectedSeasons, setSelectedSeasons] = useState(['all'])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [channels, setChannels] = useState([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [selectedChannel, setSelectedChannel] = useState(null)
  const [channelQuery, setChannelQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per-item state when a different item opens (render-phase adjustment,
  // React's recommended alternative to a state-resetting effect)
  const [prevItem, setPrevItem] = useState(item)
  if (item !== prevItem) {
    setPrevItem(item)
    setSelectedSeasons(['all'])
    setChannels([])
    setSelectedChannel(null)
    setChannelQuery('')
    setAdvancedOpen(false)
    setYoutubeMode(false)
    // TVDB-sourced items carry their season list from the Sonarr lookup
    setSeasons(item && item.mediaType === 'tv' && Array.isArray(item.seasons) ? item.seasons.map(seasonFromNumber) : [])
    setSeasonsLoading(needsSeasonFetch(item))
  }

  useEffect(() => {
    if (!needsSeasonFetch(item)) return
    let cancelled = false
    searchApi.getSeasons(item.tmdbId, item.ratingKey || undefined)
      .then(({ data }) => {
        if (cancelled) return
        const details = Array.isArray(data?.details) && data.details.length > 0
          ? data.details
          : (data?.seasons || []).map(seasonFromNumber)
        setSeasons(details)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setSeasonsLoading(false) })
    return () => { cancelled = true }
  }, [item])

  const selectableNums = useMemo(
    () => seasons.filter(s => s.selectable !== false).map(s => s.number),
    [seasons]
  )
  const hasBlocked = seasons.some(s => s.selectable === false)
  const nothingToRequest = missingMode && !seasonsLoading && selectableNums.length === 0

  const searchChannels = useCallback(async (query) => {
    setChannelsLoading(true)
    try {
      const { data } = await tuberrApi.searchChannels(query)
      setChannels(data || [])
      if ((data || []).length > 0) setSelectedChannel(data[0])
    } catch {
      setChannels([])
    } finally {
      setChannelsLoading(false)
    }
  }, [])

  // YouTube items open straight into channel selection — fetch suggestions up front
  useEffect(() => {
    if (isYoutubeItem) searchChannels(item.title)
  }, [item, isYoutubeItem, searchChannels])

  const handleSeasonToggle = useCallback((season) => {
    setSelectedSeasons(prev => {
      if (prev[0] === 'all' && prev.length === 1) return [String(season)]
      if (prev.includes(String(season))) {
        const next = prev.filter(s => String(s) !== String(season))
        return next.length === 0 ? ['all'] : next
      }
      return [...prev, String(season)]
    })
  }, [])

  const handleSubmit = useCallback(async (service, dl = isYoutubeItem ? 'youtube' : 'torrent') => {
    if (!item || submitting) return
    if (dl === 'youtube' && !selectedChannel) {
      toastError(t('Pick a YouTube channel first'))
      return
    }
    let seasonNums = null
    if (item.mediaType === 'tv') {
      const wholeShow = selectedSeasons[0] === 'all' || selectedSeasons.length === 0
      // "All" means the whole show unless some seasons are grayed out, in
      // which case it means every season that can still be requested.
      seasonNums = wholeShow
        ? ((missingMode || hasBlocked) ? selectableNums : null)
        : selectedSeasons.map(Number)
      if (missingMode && (!seasonNums || seasonNums.length === 0)) {
        toastError(t('No missing seasons to request'))
        return
      }
    }
    setSubmitting(true)
    try {
      await queueApi.createRequest({
        tmdbId: item.tmdbId || null,
        tvdbId: item.tvdbId || null,
        mediaType: item.mediaType,
        title: item.title,
        year: item.year || null,
        service,
        seasons: seasonNums,
        ...(dl === 'youtube' ? {
          downloader: 'youtube',
          youtube: { channelId: selectedChannel.channelId, channelTitle: selectedChannel.title, playlistIds: [] },
        } : {}),
      })
      toastSuccess(t('Request submitted for {{title}}', { title: item.title }))
      // The seasons just requested no longer count as missing, so any
      // "Request missing seasons" button for this show re-checks itself.
      if (item.mediaType === 'tv') invalidateMissingSeasons(item)
      if (onSubmitted) onSubmitted(item)
      onClose()
    } catch (e) {
      const msg = e.response?.data?.error || e.response?.data?.message || e.message || t('Request failed')
      toastError(msg)
    } finally {
      setSubmitting(false)
    }
  }, [item, submitting, isYoutubeItem, selectedChannel, selectedSeasons, missingMode, hasBlocked, selectableNums, onSubmitted, onClose, toastSuccess, toastError, t])

  if (!item) return null

  const hasOverseerr = services.overseerr
  const hasRiven = services.riven
  // Radarr only handles movies, Sonarr only handles shows — pick the one for this media type
  const hasDirect = item.mediaType === 'movie' ? services.radarr : services.sonarr
  const directName = item.mediaType === 'movie' ? 'Radarr' : 'Sonarr'
  const directSvc = item.mediaType === 'movie' ? 'radarr' : 'sonarr'
  const available = tvdbOnly
    ? { [directSvc]: hasDirect }
    : { overseerr: hasOverseerr, riven: hasRiven, [directSvc]: hasDirect }
  const rawDefault = services.defaultService === 'direct' ? directSvc : services.defaultService
  const defaultSvc = available[rawDefault] ? rawDefault
    : (!tvdbOnly && hasOverseerr) ? 'overseerr'
    : (!tvdbOnly && hasRiven) ? 'riven'
    : hasDirect ? directSvc
    : 'none'
  const altOptions = []
  if (isYoutubeItem) {
    // TVDB-only items already go straight to Sonarr for everyone, so no directRequestAccess gate.
    // Opted-in TMDB shows just flip the toggle back off instead.
    if (tvdbOnly) altOptions.push({ svc: 'sonarr', name: 'Sonarr (Torrent)', dl: 'torrent' })
  } else if (!tvdbOnly) {
    if (defaultSvc !== 'overseerr' && hasOverseerr) altOptions.push({ svc: 'overseerr', name: 'Overseerr' })
    if (defaultSvc !== 'riven' && hasRiven) altOptions.push({ svc: 'riven', name: 'DUMB' })
    if (defaultSvc !== directSvc && hasDirect && (services.directRequestAccess !== '1' || isAdmin)) altOptions.push({ svc: directSvc, name: directName })
  }
  const effectiveSvc = isYoutubeItem ? 'sonarr' : defaultSvc
  const canSubmit = !submitting && !nothingToRequest && !(missingMode && seasonsLoading)

  const chipTitle = (s) => {
    if (s.complete) {
      return s.episodeCount
        ? t('In library ({{have}}/{{total}})', { have: s.libraryCount, total: s.episodeCount })
        : t('In library')
    }
    if (s.requested) return t('Requested')
    if (s.libraryCount > 0 && s.episodeCount) return t('Partial ({{have}}/{{total}})', { have: s.libraryCount, total: s.episodeCount })
    return undefined
  }

  return (
    <Modal isOpen={!!item} onClose={onClose}>
      <div>
        <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: '600' }}>
          {missingMode
            ? t('Request missing seasons of “{{title}}”?', { title: item.title })
            : t('Request “{{title}}”?', { title: item.title })}
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
          {item.year || ''}{item.year ? ' · ' : ''}{item.mediaType === 'movie' ? t('Movie') : t('TV Show')}
          {tvdbOnly ? ' · TVDB' : ''}
          {missingMode ? ' · ' + t('In Library') : ''}
        </p>
        {item.mediaType === 'tv' && seasonsLoading && seasons.length === 0 && (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>{t('Loading seasons…')}</p>
        )}
        {item.mediaType === 'tv' && seasons.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Seasons')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button
                type="button"
                className={'chip-sm' + (selectedSeasons[0] === 'all' && selectableNums.length > 0 ? ' active' : '') + (selectableNums.length === 0 ? ' chip-disabled' : '')}
                style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                disabled={selectableNums.length === 0}
                onClick={() => setSelectedSeasons(['all'])}
              >
                {hasBlocked ? t('All missing') : t('All')}
              </button>
              {seasons.map(s => {
                const blocked = s.selectable === false
                const active = !blocked && !selectedSeasons.includes('all') && selectedSeasons.includes(String(s.number))
                return (
                  <button
                    type="button"
                    key={s.number}
                    className={'chip-sm' + (active ? ' active' : '') + (blocked ? ' chip-disabled' : '')}
                    style={{ border: '1px solid var(--border)', cursor: blocked ? 'not-allowed' : 'pointer' }}
                    disabled={blocked}
                    aria-disabled={blocked}
                    title={chipTitle(s)}
                    onClick={() => { if (!blocked) handleSeasonToggle(s.number) }}
                  >
                    {s.number}
                  </button>
                )
              })}
            </div>
            {hasBlocked && !nothingToRequest && (
              <p className="season-legend">{t('Grayed-out seasons are already in the library or requested.')}</p>
            )}
            {nothingToRequest && (
              <p className="season-legend">{t('Every season is already in the library or requested.')}</p>
            )}
          </div>
        )}
        {youtubeOptIn && (
          <div style={{ marginBottom: '14px' }}>
            <button
              type="button"
              className={'chip-sm' + (youtubeMode ? ' active' : '')}
              style={{ border: '1px solid var(--border)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              aria-pressed={youtubeMode}
              onClick={() => setYoutubeMode(m => !m)}
            >
              <span aria-hidden="true">{youtubeMode ? '☑' : '☐'}</span> {t('Download from YouTube')}
            </button>
            {youtubeMode && (
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '6px 0 0' }}>
                {t('Episodes are fetched from the selected YouTube channel and delivered through Sonarr.')}
              </p>
            )}
          </div>
        )}
        {isYoutubeItem && (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Source channel')}</label>
            {channelsLoading && <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{t('Searching channels…')}</p>}
            {!channelsLoading && channels.map(ch => (
              <button
                key={ch.channelId}
                type="button"
                className={'chip-sm' + (selectedChannel?.channelId === ch.channelId ? ' active' : '')}
                style={{ border: '1px solid var(--border)', cursor: 'pointer', width: '100%', marginBottom: '5px', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px' }}
                onClick={() => setSelectedChannel(ch)}
              >
                {ch.thumbnail && <img src={ch.thumbnail} alt="" style={{ width: 22, height: 22, borderRadius: '50%' }} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.title}</span>
              </button>
            ))}
            <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
              <input
                type="text"
                value={channelQuery}
                onChange={e => setChannelQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && channelQuery.trim()) searchChannels(channelQuery.trim()) }}
                placeholder={t('Channel name or URL…')}
                style={{ flex: 1, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 10px', color: 'var(--text-primary)', fontSize: '0.82rem' }}
              />
              <button
                type="button"
                className="chip-sm"
                style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => channelQuery.trim() && searchChannels(channelQuery.trim())}
              >
                {t('Search')}
              </button>
            </div>
          </div>
        )}
        {altOptions.length > 0 && (
          <div style={{ marginBottom: '12px' }}>
            <button
              type="button"
              className="chip-sm"
              style={{ border: '1px solid var(--border)', cursor: 'pointer', width: '100%', textAlign: 'center' }}
              onClick={() => setAdvancedOpen(o => !o)}
            >
              {t('Advanced')} {advancedOpen ? '▾' : '▸'}
            </button>
            {advancedOpen && (
              <div style={{ marginTop: '8px' }}>
                {altOptions.map(opt => (
                  <button
                    key={opt.svc}
                    type="button"
                    className="chip-sm"
                    style={{ border: '1px solid var(--border)', cursor: 'pointer', width: '100%', marginBottom: '6px', textAlign: 'left' }}
                    disabled={!canSubmit}
                    onClick={() => handleSubmit(opt.svc, opt.dl)}
                  >
                    {t('Send to {{name}} instead', { name: opt.name })}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button className="chip-sm" onClick={onClose}>{t('Cancel')}</button>
          <button
            className="chip-sm"
            style={{ background: 'var(--accent)', color: '#000', fontWeight: '600', border: 'none', opacity: canSubmit ? 1 : 0.6 }}
            disabled={!canSubmit}
            onClick={() => handleSubmit(effectiveSvc)}
          >
            {t('Request')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
