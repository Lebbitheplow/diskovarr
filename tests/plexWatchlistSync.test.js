import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Plex.tv watchlist sync in a mixed Plex + Jellyfin library: plex.tv entries
// resolve to Plex rows only, never to a Jellyfin GUID stored under the Plex
// source, and Jellyfin favorites are left alone. plex.tv is mocked.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-plex-watchlist-'))
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const plex = nodeRequire('../server/services/plex.js')

const realFetch = global.fetch
const NOW = Math.floor(Date.now() / 1000)

function libItem(ratingKey, sectionId, source, tmdbId) {
  return {
    ratingKey, sectionId, source, tmdbId, type: 'movie', title: `Movie ${tmdbId}`, year: 2000,
    thumb: null, genres: [], directors: [], cast: [], addedAt: NOW - 86400,
    audienceRating: 0, contentRating: '', summary: '', rating: 0, ratingImage: '', audienceRatingImage: '', studio: '',
  }
}

const watchlist = (userId) => db.prepare('SELECT rating_key, source FROM watchlist WHERE user_id = ? ORDER BY rating_key')
  .all(userId).map(r => ({ ...r }))

beforeAll(() => {
  // Jellyfin rows first, so an unfiltered "first match" would pick them
  db.upsertManyItems([
    libItem('0123456789abcdef0123456789abcd55', 'jf_movies', 'jellyfin', '550'),
    libItem('0123456789abcdef0123456789abcd77', 'jf_movies', 'jellyfin', '777'),
    libItem('101', '1', 'plex', '550'),
  ])
  global.fetch = async (url) => {
    const u = String(url)
    const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    if (u.startsWith('https://discover.provider.plex.tv/library/sections/watchlist/all')) {
      return json({ MediaContainer: { Metadata: [{ ratingKey: 'w550' }, { ratingKey: 'w777' }] } })
    }
    if (u.startsWith('https://metadata.provider.plex.tv/library/metadata/w550,w777')) {
      return json({ MediaContainer: { Metadata: [
        { type: 'movie', Guid: [{ id: 'tmdb://550' }] },  // on both servers
        { type: 'movie', Guid: [{ id: 'tmdb://777' }] },  // Jellyfin only
      ] } })
    }
    throw new Error(`unexpected fetch ${u}`)
  }
})

afterAll(() => { global.fetch = realFetch })

describe('syncPlexTvWatchlist with a mixed library', () => {
  it('stores only the Plex row, under the Plex source, and leaves Jellyfin favorites alone', async () => {
    const user = 'plex-user-1'
    db.addToWatchlistDb(user, '0123456789abcdef0123456789abcd77', 'jellyfin') // a Jellyfin favorite
    const kept = await plex.syncPlexTvWatchlist(user, 'USER_TOKEN')
    expect(kept).toBe(1)
    expect(watchlist(user)).toEqual([
      { rating_key: '0123456789abcdef0123456789abcd77', source: 'jellyfin' },
      { rating_key: '101', source: 'plex' },
    ])
  })

  it('drops a Jellyfin GUID an earlier sync stored under the Plex source', async () => {
    const user = 'plex-user-2'
    db.prepare("INSERT INTO watchlist (user_id, rating_key, added_at, source) VALUES (?, ?, ?, 'plex')")
      .run(user, '0123456789abcdef0123456789abcd55', NOW - 86400)
    await plex.syncPlexTvWatchlist(user, 'USER_TOKEN')
    expect(watchlist(user)).toEqual([{ rating_key: '101', source: 'plex' }])
  })

  it('getLibraryItemByTmdbId keeps its source-blind default for other callers', () => {
    expect(db.getLibraryItemByTmdbId('777', 'movie')).toBeTruthy()
    expect(db.getLibraryItemByTmdbId('777', 'movie', 'plex')).toBeUndefined()
    expect(db.getLibraryItemByTmdbId('550', 'movie', 'plex').rating_key).toBe('101')
  })
})
