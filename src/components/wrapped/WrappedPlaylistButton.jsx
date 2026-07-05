import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { wrappedApi } from '../../services/api'
import { useToast } from '../../context/ToastContext'

// Creates (or replaces) the "Diskovarr Wrapped {year}" playlist in the user's
// own Plex account from their top content of the year.
export default function WrappedPlaylistButton({ year }) {
  const { t } = useTranslation()
  const { success: toastSuccess, error: toastError } = useToast() || {}
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState(null)

  const create = async () => {
    setWorking(true)
    try {
      const { data } = await wrappedApi.createPlaylist(year)
      setResult(data)
      toastSuccess?.(t('Playlist created in your Plex account'))
    } catch (e) {
      toastError?.(e?.response?.data?.error || t('Could not create the playlist'))
    }
    setWorking(false)
  }

  return (
    <div className="wrapped-playlist">
      <button className="wrapped-playlist-btn" onClick={create} disabled={working}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="13" y2="6" /><line x1="3" y1="12" x2="13" y2="12" /><line x1="3" y1="18" x2="9" y2="18" />
          <polygon points="16 15 22 18 16 21 16 15" fill="currentColor" stroke="none" />
        </svg>
        {working ? t('Creating…') : result ? t('Rebuild playlist') : `${t('Create')} "Diskovarr Wrapped ${year}" ${t('in Plex')}`}
      </button>
      {result && (
        <a className="wrapped-playlist-open" href={result.deepLink} target="_blank" rel="noopener noreferrer">
          {t('Open in Plex')} ({result.count} {t('items')}) ↗
        </a>
      )}
    </div>
  )
}
