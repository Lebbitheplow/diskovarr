import { useEffect, useSyncExternalStore } from 'react'
import { searchApi } from '../services/api'

// Whether a library show still has seasons worth requesting: at least one
// season that is neither complete in the library nor already requested. Backs
// the "Request missing seasons" buttons so they only appear when the request
// modal would actually have something to offer.
//
// Answers are memoised per show so a search card and the detail modal opened
// from it share one /search/seasons call. invalidateMissingSeasons() drops a
// show's entry after a request is submitted so the buttons hide right away.

const TTL_MS = 60 * 1000
const cache = new Map() // key -> { promise, value, ts }
const listeners = new Set()

function notify() {
  for (const l of listeners) l()
}

function keyOf(item) {
  if (!item || !item.tmdbId) return null
  const isShow = item.mediaType === 'tv' || item.type === 'show'
  if (!isShow || !(item.inLibrary ?? item.ratingKey)) return null
  return `${item.tmdbId}:${item.ratingKey || ''}`
}

function isFresh(hit) {
  return !!hit && (hit.promise != null || Date.now() - hit.ts < TTL_MS)
}

function load(key, tmdbId, ratingKey) {
  const promise = searchApi.getSeasons(tmdbId, ratingKey || undefined)
    .then(({ data }) => (Array.isArray(data?.details) ? data.details : []).some(s => s.selectable !== false))
    // A failed lookup leaves the request modal with nothing selectable either,
    // so treating it as "nothing missing" keeps the two in agreement.
    .catch(() => false)
    .then(value => {
      cache.set(key, { promise: null, value, ts: Date.now() })
      notify()
    })
  cache.set(key, { promise, value: undefined, ts: Date.now() })
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function invalidateMissingSeasons(item) {
  const prefix = item?.tmdbId ? `${item.tmdbId}:` : null
  if (!prefix) return
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
  notify()
}

// Returns true only once the show is known to have a requestable season, so
// callers hide the button while the answer is still loading.
export default function useMissingSeasons(item) {
  const key = keyOf(item)
  const tmdbId = item?.tmdbId
  const ratingKey = item?.ratingKey
  const value = useSyncExternalStore(subscribe, () => (key ? cache.get(key)?.value : undefined))

  useEffect(() => {
    if (!key || isFresh(cache.get(key))) return
    load(key, tmdbId, ratingKey)
  }, [key, tmdbId, ratingKey, value])

  return value === true
}
