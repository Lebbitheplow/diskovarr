import React, { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import { rivenApi } from '../services/api'
import { useToast } from '../context/ToastContext'

const STATE_CLASS = {
  Completed: 'ok',
  PartiallyCompleted: 'warn',
  Failed: 'bad',
  Paused: 'muted',
  Unreleased: 'muted',
  Ongoing: 'muted',
  Unknown: 'muted',
}

function StateChip({ state }) {
  if (!state) return null
  return <span className={'riven-state riven-state-' + (STATE_CLASS[state] || 'progress')}>{state}</span>
}

// Reset a title in DUMB (Riven): blacklist the torrent Riven downloaded and put
// the item back on its queue. `target` = { tmdbId, mediaType: 'movie'|'tv',
// title, season?, episode? } — season/episode pre-select that part of a show
// (an issue's scope). Renders nothing while target is null.
export default function RivenResetModal({ target, onClose, onDone }) {
  return (
    <Modal isOpen={!!target} onClose={onClose}>
      {target && (
        // Keyed so every new target starts from fresh state.
        <RivenResetBody key={`${target.tmdbId}:${target.mediaType}:${target.season || ''}:${target.episode || ''}`} target={target} onClose={onClose} onDone={onDone} />
      )}
    </Modal>
  )
}

function RivenResetBody({ target, onClose, onDone }) {
  const { t } = useTranslation()
  const { success, error: toastError } = useToast()
  const { tmdbId, mediaType } = target
  const isTv = mediaType === 'tv'
  const initSeason = isTv ? Number(target.season) || null : null
  const initEpisode = initSeason ? Number(target.episode) || null : null

  const [loading, setLoading] = useState(true)
  const [item, setItem] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [mode, setMode] = useState(initSeason ? 'partial' : 'all')
  const [seasons, setSeasons] = useState(() => new Set(initSeason && !initEpisode ? [initSeason] : []))
  const [episodes, setEpisodes] = useState(() => new Set(initEpisode ? [`${initSeason}:${initEpisode}`] : [])) // "season:episode" keys
  const [expanded, setExpanded] = useState(() => new Set(initEpisode ? [initSeason] : []))
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    rivenApi.getItem({ tmdbId, mediaType })
      .then(({ data }) => { if (!cancelled) setItem(data.item) })
      .catch(e => { if (!cancelled) setLoadError({ notFound: e.status === 404, message: e.message }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tmdbId, mediaType])

  const toggleIn = (setter) => (key) => setter(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const toggleSeason = toggleIn(setSeasons)
  const toggleEpisode = toggleIn(setEpisodes)
  const toggleExpanded = toggleIn(setExpanded)

  // Episodes inside a selected season are covered by the season reset.
  const selection = useMemo(() => {
    if (!isTv || mode === 'all') return { seasons: [], episodes: [] }
    const eps = [...episodes]
      .map(k => k.split(':').map(Number))
      .filter(([s]) => !seasons.has(s))
      .map(([season, episode]) => ({ season, episode }))
    return { seasons: [...seasons].sort((a, b) => a - b), episodes: eps }
  }, [isTv, mode, seasons, episodes])

  const partial = isTv && mode === 'partial'
  const targetCount = partial ? selection.seasons.length + selection.episodes.length : 1
  const canSubmit = !!item && !loading && !submitting && targetCount > 0

  const handleReset = async () => {
    setSubmitting(true)
    try {
      const { data } = await rivenApi.reset({ tmdbId, mediaType, ...selection })
      const labels = (data.targets || []).map(x => x.label).join(', ')
      success(t('Reset in Riven: {{what}}', { what: labels || target.title }))
      if (onDone) onDone(data)
    } catch (e) {
      toastError(e.message || t('Riven reset failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="riven-reset">
      <h3 style={{ margin: '0 0 6px', fontSize: '1rem', fontWeight: 600 }}>{t('Reset in DUMB (Riven)')}</h3>
      <div className="riven-reset-title">
        <span>{target.title}</span>
        {item && <StateChip state={item.state} />}
      </div>
      <p className="riven-reset-help">
        {t('Blacklists the torrent Riven downloaded for the selected items, clears their files and sends them back to the queue to be scraped again.')}
      </p>

      {loading && <div className="riven-reset-status">{t('Looking up in Riven...')}</div>}
      {loadError && (
        <div className="riven-reset-status riven-reset-error">
          {loadError.notFound ? t('This title is not in Riven.') : loadError.message}
        </div>
      )}

      {item && isTv && (
        <>
          <div className="riven-reset-modes">
            <label>
              <input type="radio" name="riven-reset-mode" checked={mode === 'all'} onChange={() => setMode('all')} />
              {t('Entire show')}
            </label>
            <label>
              <input type="radio" name="riven-reset-mode" checked={mode === 'partial'} onChange={() => setMode('partial')} />
              {t('Pick seasons or episodes')}
            </label>
          </div>
          {partial && (
            <div className="riven-reset-tree">
              {item.seasons.length === 0 && (
                <div className="riven-reset-status" style={{ padding: '0 10px' }}>{t('Riven has no seasons for this show yet.')}</div>
              )}
              {item.seasons.map(s => {
                const seasonChecked = seasons.has(s.number)
                const isOpen = expanded.has(s.number)
                return (
                  <div key={s.id} className="riven-reset-season">
                    <div className="riven-reset-row">
                      <label>
                        <input type="checkbox" className="bulk-checkbox" checked={seasonChecked} onChange={() => toggleSeason(s.number)} />
                        {t('Season')} {s.number}
                      </label>
                      <StateChip state={s.state} />
                      <button type="button" className="riven-reset-expand" onClick={() => toggleExpanded(s.number)} aria-expanded={isOpen}>
                        {isOpen ? t('Hide episodes') : t('{{n}} episodes', { n: s.episodes.length })}
                      </button>
                    </div>
                    {isOpen && (
                      <div className="riven-reset-episodes">
                        {s.episodes.map(e => {
                          const key = `${s.number}:${e.number}`
                          return (
                            <label key={e.id} className={'riven-reset-row riven-reset-episode' + (seasonChecked ? ' implied' : '')}>
                              <input
                                type="checkbox"
                                className="bulk-checkbox"
                                checked={seasonChecked || episodes.has(key)}
                                disabled={seasonChecked}
                                onChange={() => toggleEpisode(key)}
                              />
                              <span className="riven-reset-epnum">E{e.number}</span>
                              <span className="riven-reset-eptitle">{e.title || ''}</span>
                              <StateChip state={e.state} />
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      <div className="edit-modal-actions">
        <button className="edit-modal-cancel" onClick={onClose} disabled={submitting}>{t('Cancel')}</button>
        <button className="edit-modal-save" style={{ background: 'var(--accent-red, #e53e3e)' }} onClick={handleReset} disabled={!canSubmit}>
          {submitting ? t('Resetting...') : partial ? t('Reset {{n}} item(s)', { n: targetCount }) : t('Reset')}
        </button>
      </div>
    </div>
  )
}
