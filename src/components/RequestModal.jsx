import React, { useState, useCallback, useEffect } from 'react'
import Modal from './Modal'
import { queueApi, searchApi, tuberrApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'

// Shared request dialog used by Explore, Search, and DetailModal flows.
// Handles season selection and alternate-service choice. YouTube-sourced items
// (TVDB-only shows, when the admin has enabled YouTube requests) default to the
// YouTube downloader with channel suggestions; regular TMDB items never see it.
export default function RequestModal({ item, services, onClose, onSubmitted }) {
  const { t } = useTranslation()
  const { error: toastError, success: toastSuccess } = useToast()
  const { user } = useAuth()
  const isAdmin = !!(user?.isAdmin)

  // TVDB-only items can only go to Sonarr (other services key off TMDB ids);
  // they are how YouTube series enter search results, so they get the YouTube flow
  const tvdbOnly = !!item && !item.tmdbId && !!item.tvdbId
  const isYoutubeItem = tvdbOnly && item.mediaType === 'tv' && !!services.tuberr && !!services.sonarr

  const [seasons, setSeasons] = useState([])
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
    // TVDB-sourced items carry their season list from the Sonarr lookup
    setSeasons(item && item.mediaType === 'tv' && Array.isArray(item.seasons) ? item.seasons : [])
  }

  useEffect(() => {
    if (!item || item.mediaType !== 'tv' || !item.tmdbId) return
    let cancelled = false
    searchApi.getSeasons(item.tmdbId)
      .then(({ data }) => { if (!cancelled) setSeasons(data.seasons || []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [item])

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
    const seasonNums = selectedSeasons[0] === 'all' || selectedSeasons.length === 0 ? null : selectedSeasons.map(Number)
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
      if (onSubmitted) onSubmitted(item)
      onClose()
    } catch (e) {
      const msg = e.response?.data?.error || e.response?.data?.message || e.message || t('Request failed')
      toastError(msg)
    } finally {
      setSubmitting(false)
    }
  }, [item, submitting, isYoutubeItem, selectedChannel, selectedSeasons, onSubmitted, onClose, toastSuccess, toastError, t])

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
    // TVDB-only items already go straight to Sonarr for everyone, so no directRequestAccess gate
    altOptions.push({ svc: 'sonarr', name: 'Sonarr (Torrent)', dl: 'torrent' })
  } else if (!tvdbOnly) {
    if (defaultSvc !== 'overseerr' && hasOverseerr) altOptions.push({ svc: 'overseerr', name: 'Overseerr' })
    if (defaultSvc !== 'riven' && hasRiven) altOptions.push({ svc: 'riven', name: 'DUMB' })
    if (defaultSvc !== directSvc && hasDirect && (services.directRequestAccess !== '1' || isAdmin)) altOptions.push({ svc: directSvc, name: directName })
  }
  const effectiveSvc = isYoutubeItem ? 'sonarr' : defaultSvc

  return (
    <Modal isOpen={!!item} onClose={onClose}>
      <div>
        <h3 style={{ margin: '0 0 16px', fontSize: '1rem', fontWeight: '600' }}>
          {t('Request “{{title}}”?', { title: item.title })}
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
          {item.year || ''}{item.year ? ' · ' : ''}{item.mediaType === 'movie' ? t('Movie') : t('TV Show')}
          {tvdbOnly ? ' · TVDB' : ''}
        </p>
        {item.mediaType === 'tv' && seasons.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '5px' }}>{t('Seasons')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              <button
                type="button"
                className={'chip-sm' + (selectedSeasons[0] === 'all' ? ' active' : '')}
                style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                onClick={() => setSelectedSeasons(['all'])}
              >
                {t('All')}
              </button>
              {seasons.map(s => (
                <button
                  type="button"
                  key={s}
                  className={'chip-sm' + (!selectedSeasons.includes('all') && selectedSeasons.includes(String(s)) ? ' active' : '')}
                  style={{ border: '1px solid var(--border)', cursor: 'pointer' }}
                  onClick={() => handleSeasonToggle(s)}
                >
                  {s}
                </button>
              ))}
            </div>
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
            style={{ background: 'var(--accent)', color: '#000', fontWeight: '600', border: 'none', opacity: submitting ? 0.6 : 1 }}
            disabled={submitting}
            onClick={() => handleSubmit(effectiveSvc)}
          >
            {t('Request')}
          </button>
        </div>
      </div>
    </Modal>
  )
}
