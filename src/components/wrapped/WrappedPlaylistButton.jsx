import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { wrappedApi } from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { useAuth } from '../../context/AuthContext'

// Creates (or replaces) the "Diskovarr Wrapped {year}" playlist in the user's
// own Plex or Jellyfin account from their top content of the year. A user
// with both accounts picks the server (defaulting to the active source); the
// server resolves the top titles onto it and reports it back as `source`.
const serverName = (source) => (source === 'jellyfin' ? 'Jellyfin' : 'Plex')

export default function WrappedPlaylistButton({ year }) {
  const { t } = useTranslation()
  const { success: toastSuccess, error: toastError } = useToast() || {}
  const { isPlexLinked, hasJellyfin, activeSource, availableSources } = useAuth()
  const bothServers = isPlexLinked && hasJellyfin && (availableSources || []).includes('plex') && (availableSources || []).includes('jellyfin')
  const [target, setTarget] = useState(activeSource === 'jellyfin' ? 'jellyfin' : 'plex')
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState(null)

  const create = async () => {
    setWorking(true)
    try {
      const { data } = await wrappedApi.createPlaylist(year, bothServers ? target : undefined)
      setResult(data)
      toastSuccess?.(t('Playlist created in your {{server}} account', { server: serverName(data?.source) }))
    } catch (e) {
      toastError?.(e?.response?.data?.error || t('Could not create the playlist'))
    }
    setWorking(false)
  }

  // Needs a linked media-server account to create the playlist in.
  if (!isPlexLinked && !hasJellyfin) return null

  return (
    <div className="wrapped-playlist">
      {bothServers && (
        <div className="wrapped-playlist-targets" role="radiogroup" aria-label={t('Create the playlist in')}>
          {['plex', 'jellyfin'].map(s => (
            <button key={s} type="button" role="radio" aria-checked={target === s}
              className={target === s ? 'active' : ''} onClick={() => { setTarget(s); setResult(null) }} disabled={working}>
              {serverName(s)}
            </button>
          ))}
        </div>
      )}
      <button className="wrapped-playlist-btn" onClick={create} disabled={working}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="13" y2="6" /><line x1="3" y1="12" x2="13" y2="12" /><line x1="3" y1="18" x2="9" y2="18" />
          <polygon points="16 15 22 18 16 21 16 15" fill="currentColor" stroke="none" />
        </svg>
        {working ? t('Creating…') : result ? t('Rebuild playlist') : t('Create playlist “Diskovarr Wrapped {{year}}”', { year })}
      </button>
      {result && (
        <a className="wrapped-playlist-open" href={result.deepLink || result.url} target="_blank" rel="noopener noreferrer">
          {t('Open playlist in {{server}}', { server: serverName(result.source) })} ({result.count} {t('items')}) ↗
        </a>
      )}
    </div>
  )
}
