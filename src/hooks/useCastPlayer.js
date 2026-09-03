import { useState, useCallback } from 'react'
import { libraryApi } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useTranslation } from 'react-i18next'
import { sendPlayMedia, probeLocalNetwork, isChromiumBrowser, localNetworkPermission } from '../utils/castPlayer'

// Plex rating keys are numeric; Jellyfin items carry GUIDs.
export const isPlexRatingKey = (ratingKey) => /^\d+$/.test(String(ratingKey ?? ''))

// /api/clients returns Plex clients (no `source`) and Jellyfin sessions
// (`source: 'jellyfin'`); show each only for items from the same server.
function clientMatchesItem(client, ratingKey) {
  const clientSource = client?.source || 'plex'
  return isPlexRatingKey(ratingKey) ? clientSource !== 'jellyfin' : clientSource === 'jellyfin'
}

/**
 * Casting behaviour shared by the detail modal and the spotlight hero: fetch
 * Plex clients into a picker, then deliver playMedia to the chosen device.
 *
 * Chromium delivers playMedia itself (the page is on the same LAN as the TV;
 * the server usually isn't), then falls back to server-side delivery —
 * sequentially, so the player can never get the command twice. Other browsers
 * block page→LAN requests outright, so they cast through the server directly
 * (reaches players on the server's own LAN only).
 */
export default function useCastPlayer() {
  const { t } = useTranslation()
  const { success, error: toastError, info } = useToast()
  const { isPlexLinked, hasJellyfin } = useAuth()
  const [castOpen, setCastOpen] = useState(false)
  const [castSource, setCastSource] = useState('plex')
  const [castLoading, setCastLoading] = useState(false)
  const [castingId, setCastingId] = useState(null)
  const [clients, setClients] = useState([])

  // `item` is optional (the picker is source-neutral without it); when given,
  // the client list is filtered to the item's server.
  const handleCastClick = useCallback(async (item) => {
    if (castOpen) {
      setCastOpen(false)
      return
    }
    setCastLoading(true)
    try {
      const ratingKey = item?.ratingKey
      const jellyfinItem = ratingKey != null && !isPlexRatingKey(ratingKey)
      setCastSource(jellyfinItem ? 'jellyfin' : 'plex')
      const { data } = await libraryApi.getClients()
      const all = data.clients || []
      setClients(ratingKey != null ? all.filter(c => clientMatchesItem(c, ratingKey)) : all)
      setCastOpen(true)
      // Jellyfin sessions are driven server-side — no local-network hand-off.
      if (jellyfinItem) return
      if (!isChromiumBrowser() && !sessionStorage.getItem('castLnaNoticeShown')) {
        sessionStorage.setItem('castLnaNoticeShown', '1')
        info(t('Heads up: casting from this browser may not reach your TV — it needs local network access, which only Chrome and Edge support. If casting fails, try Chrome.'))
      }
      // Surface Chrome's local-network permission prompt now, while the user
      // is picking a device, instead of mid-cast where it stalled delivery.
      const probeUri = (data.clients || []).map(c => c.probeUri).find(Boolean)
      probeLocalNetwork(probeUri)
    } catch (e) {
      toastError(t('Could not fetch clients'))
    } finally {
      setCastLoading(false)
    }
  }, [castOpen, toastError, info, t])

  const handleCastMedia = useCallback(async (item, client) => {
    setCastingId(client.machineIdentifier)
    const castArgs = { ratingKey: item.ratingKey, clientId: client.machineIdentifier }
    try {
      // Jellyfin: the server issues the play command itself; nothing to deliver
      // from the browser and no Plex-specific fallbacks apply.
      if (!isPlexRatingKey(item.ratingKey) || client.source === 'jellyfin') {
        const { data } = await libraryApi.castMedia(castArgs)
        success(t('Playing on {{name}}', { name: data?.clientName || client.name }))
        setCastOpen(false)
        return
      }
      if (isChromiumBrowser()) {
        // If the local-network permission is still undecided, delivery will
        // sit behind a browser prompt — tell the user to look for it.
        if (await localNetworkPermission() === 'prompt') {
          info(t('If your browser asks to access devices on your network, choose Allow — that is how the play command reaches your TV.'))
        }
        const { data: prep } = await libraryApi.prepareCast(castArgs)
        const result = await sendPlayMedia(prep)
        if (!result.ok) {
          try {
            await libraryApi.castMedia(castArgs)
          } catch {
            toastError(result.reason === 'rejected'
              ? t('The device refused the playback command. Try restarting the Plex app on it.')
              : t('Could not reach the device from this browser. Make sure you are on the same Wi-Fi network as your TV, and allow local network access if prompted.'))
            return
          }
        }
      } else {
        await libraryApi.castMedia(castArgs)
      }
      success('Playing on ' + client.name)
      setCastOpen(false)
    } catch (e) {
      // 400 (no linked account / player not found / nothing playable) and 502
      // (server refused) both carry a human-readable `error`.
      toastError(e.response?.data?.error || e.response?.data?.message || e.message || t('Cast failed'))
    } finally {
      setCastingId(null)
    }
  }, [success, toastError, info, t])

  // Gate for rendering the cast/play button at all: Plex items need a linked
  // Plex account, Jellyfin items a linked Jellyfin account.
  const canCast = useCallback((item) => {
    const numeric = isPlexRatingKey(item?.ratingKey)
    return (isPlexLinked && numeric) || (hasJellyfin && !numeric && item?.ratingKey != null)
  }, [isPlexLinked, hasJellyfin])

  const noClientsMessage = castSource === 'jellyfin'
    ? t('No Jellyfin sessions found. Open the Jellyfin app on the device first.')
    : t('No Plex clients found.') + ' ' + t('Open your Plex app on your TV first.')

  return { castOpen, castLoading, castingId, clients, handleCastClick, handleCastMedia, setCastOpen, canCast, castSource, noClientsMessage }
}
