import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { issuesApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import useCastPlayer from '../hooks/useCastPlayer'
import MonitorDropdown from './MonitorManager/MonitorDropdown'

// The detail modal's actions, in two tiers:
//
//   DetailActionBar — sits under the title block: the one primary action
//     (watchlist, or request/notify for titles not in the library) followed
//     by the ways to watch it (play on a device, watch together, movie night).
//     A title held only in a library the user can't access ("restricted")
//     shows a note in place of all of these.
//   DetailManageRow — a quiet footer under the tab content for everything
//     about managing the title rather than watching it: missing seasons,
//     monitors, reporting an issue, TMDB, and "not interested" pinned right.

// Stroked 24×24 glyphs, same drawing style as the rail's icons
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }

const ICONS = {
  plus: <path d="M12 5v14M5 12h14" {...S} />,
  check: <polyline points="20 6 9 17 4 12" {...S} />,
  cast: <><path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" {...S} /><path d="M2 12a8 8 0 0 1 8 8M2 16a4 4 0 0 1 4 4" {...S} /><circle cx="2.5" cy="19.5" r="0.6" fill="currentColor" /></>,
  together: <><circle cx="9" cy="8" r="3.5" {...S} /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" {...S} /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.5a6.5 6.5 0 0 1 3 5.5" {...S} /></>,
  film: <><rect x="3" y="5" width="18" height="14" rx="2" {...S} /><path d="M7 5v14M17 5v14M3 9.5h4M17 9.5h4M3 14.5h4M17 14.5h4" {...S} /></>,
  request: <><path d="M12 4v11M7 10.5l5 5 5-5" {...S} /><path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5" {...S} /></>,
  bell: <><path d="M18 9a6 6 0 0 0-12 0c0 6.5-2.5 8-2.5 8h17S18 15.5 18 9z" {...S} /><path d="M10.3 20.5a2 2 0 0 0 3.4 0" {...S} /></>,
  monitor: <><path d="M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z" {...S} /><circle cx="12" cy="12" r="3" {...S} /></>,
  flag: <><path d="M5 21V4" {...S} /><path d="M5 4.5c3-1.8 6 1.8 9 0s5-.5 5-.5v9s-2-1.3-5 .5-6-1.8-9 0" {...S} /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" {...S} /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" {...S} /></>,
  hide: <><path d="M3 3l18 18" {...S} /><path d="M10.6 5.1A9.7 9.7 0 0 1 12 5c6.5 0 10.5 7 10.5 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.4 8.5 1.5 12 1.5 12S5.5 19 12 19a9.6 9.6 0 0 0 5.4-1.6" {...S} /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" {...S} /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" {...S} /><path d="M8 11V7.5a4 4 0 0 1 8 0V11" {...S} /></>,
}

function ActionIcon({ name }) {
  return (
    <svg className="detail-action-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

export function DetailActionBar({
  item, inLibrary, inWatchlist, restricted = false,
  onWatchlist, onRequest, onNotify, onMovieNight, onWatchTogether,
}) {
  const { t } = useTranslation()
  const { castOpen, castLoading, castingId, clients, handleCastClick, handleCastMedia, canCast, noClientsMessage } = useCastPlayer()
  const castable = inLibrary && !restricted && canCast(item)

  return (
    <>
      <div className="detail-actions">
        {restricted ? (
          // Nothing to play, request or follow: the server owner decides who sees it
          <span className="detail-action detail-action-primary is-restricted" role="note" title={t('Ask the server owner for access')}>
            <ActionIcon name="lock" />
            {t('In a library you don\'t have access to')}
          </span>
        ) : inLibrary ? (
          <button
            className={'modal-btn modal-btn-watchlist detail-action-primary' + (inWatchlist ? ' in-watchlist' : '')}
            onClick={onWatchlist}
          >
            <ActionIcon name={inWatchlist ? 'check' : 'plus'} />
            {inWatchlist ? t('In Watchlist') : t('Watchlist')}
          </button>
        ) : (
          <button
            className={'modal-btn modal-btn-watchlist detail-action-primary' + (item.isRequested ? ' in-watchlist' : '')}
            onClick={item.isRequested ? onNotify : onRequest}
          >
            <ActionIcon name={item.isRequested ? 'bell' : 'request'} />
            {item.isRequested ? t('Notify Me') : t('Request')}
          </button>
        )}
        {castable && (
          <button
            className={'detail-action' + (castOpen ? ' is-open' : '')}
            onClick={() => handleCastClick(item)}
            disabled={castLoading}
            aria-expanded={castOpen}
          >
            <ActionIcon name="cast" />
            {castLoading ? t('Loading…') : t('Play')}
          </button>
        )}
        {castable && (
          <button className="detail-action" onClick={onWatchTogether}>
            <ActionIcon name="together" />
            {t('Watch Together')}
          </button>
        )}
        {onMovieNight && (
          <button className="detail-action" onClick={onMovieNight}>
            <ActionIcon name="film" />
            {t('Movie Night')}
          </button>
        )}
      </div>
      {castable && castOpen && !castLoading && (
        <div className="modal-cast-picker detail-cast-picker">
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
    </>
  )
}

function ReportIssuePanel({ item, onReported, onCancel }) {
  const { t } = useTranslation()
  const { success } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
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
      onReported()
    } catch (e) {
      setError(e.message || 'Submit failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="report-panel">
      {isShow && (
        <label className="report-field">
          <span>{t('Scope')}</span>
          <select className="report-input" value={scope} onChange={e => setScope(e.target.value)}>
            <option value="series">{t('Entire Series')}</option>
            <option value="season">{t('Specific Season')}</option>
            <option value="episode">{t('Specific Episode')}</option>
          </select>
        </label>
      )}
      {isShow && (scope === 'season' || scope === 'episode') && (
        <div className="report-row">
          <label className="report-field">
            <span>{t('Season Number')}</span>
            <input type="number" min="1" className="report-input report-input-num" value={season} onChange={e => setSeason(e.target.value)} />
          </label>
          {scope === 'episode' && (
            <label className="report-field">
              <span>{t('Episode Number')}</span>
              <input type="number" min="1" className="report-input report-input-num" value={episode} onChange={e => setEpisode(e.target.value)} />
            </label>
          )}
        </div>
      )}
      {canMarkMissing && (
        <label className="report-check">
          <input type="checkbox" className="bulk-checkbox" checked={missing} onChange={e => setMissing(e.target.checked)} />
          <span>{t('This content is missing from the library')}
            <small>{t('Automatically queues a search for it in the default request app')}</small>
          </span>
        </label>
      )}
      <label className="report-field">
        <span>{t('Description (optional)')}</span>
        <textarea className="report-input report-input-text" placeholder={t('Describe the problem...')} value={description} onChange={e => setDescription(e.target.value)} />
      </label>
      {error && <div className="report-error">Error: {error}</div>}
      <div className="report-actions">
        <button className="detail-link" onClick={onCancel}>{t('Cancel')}</button>
        <button className="modal-btn modal-btn-primary" onClick={handleSubmit} disabled={submitting}>
          {submitting ? t('Submitting…') : t('Submit')}
        </button>
      </div>
    </div>
  )
}

export function DetailManageRow({ item, inLibrary, onDismiss, onRequestMissing }) {
  const { t } = useTranslation()
  const [reportOpen, setReportOpen] = useState(false)
  const [reported, setReported] = useState(false)

  return (
    <>
      <div className="detail-manage">
        {onRequestMissing && (
          <button className="detail-link detail-link-accent" onClick={onRequestMissing}>
            <ActionIcon name="request" />
            {t('Request missing seasons')}
          </button>
        )}
        <MonitorDropdown
          item={item}
          buttonClassName="detail-link"
          label={<><ActionIcon name="monitor" />{t('Monitor')}</>}
        />
        {inLibrary && (reported ? (
          <span className="detail-link is-done">
            <ActionIcon name="check" />
            {t('Issue reported')}
          </span>
        ) : (
          <button
            className={'detail-link' + (reportOpen ? ' is-open' : '')}
            onClick={() => setReportOpen(o => !o)}
            aria-expanded={reportOpen}
          >
            <ActionIcon name="flag" />
            {t('Report issue')}
          </button>
        ))}
        {!inLibrary && item.tmdbId && (
          <a
            className="detail-link"
            href={`https://www.themoviedb.org/${item.mediaType === 'tv' ? 'tv' : 'movie'}/${item.tmdbId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ActionIcon name="external" />
            {t('View on TMDB')}
          </a>
        )}
        <button className="detail-link detail-link-dismiss" onClick={onDismiss}>
          <ActionIcon name="hide" />
          {t('Not interested')}
        </button>
      </div>
      {reportOpen && !reported && (
        <ReportIssuePanel
          item={item}
          onReported={() => { setReported(true); setReportOpen(false) }}
          onCancel={() => setReportOpen(false)}
        />
      )}
    </>
  )
}
