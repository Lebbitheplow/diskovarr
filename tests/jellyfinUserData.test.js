import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-jf-user-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const client = nodeRequire('../server/services/jellyfin/client.js')
const userData = nodeRequire('../server/services/jellyfin/userData.js')

db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
db.setSetting('jellyfin_api_key', 'test-key')
db.setSetting('jellyfin_enabled', '1')

function mockFetch(handler) {
  const calls = []
  client.jfFetch = async (p, opts = {}) => {
    calls.push({ path: p, method: opts.method || 'GET' })
    const [pathname, qs = ''] = p.split('?')
    const out = handler(pathname, new URLSearchParams(qs))
    return out === undefined ? { Items: [] } : out
  }
  return calls
}

describe('historyRowsOf', () => {
  it('maps played movies and episodes into watch_history rows keyed on the canonical user', () => {
    const movies = [{
      Id: 'm-1', Name: 'Heat', ProductionYear: 1995, RunTimeTicks: 170 * 60 * 10_000_000,
      ImageTags: { Primary: 't' },
      UserData: { Played: true, LastPlayedDate: '2026-05-01T20:00:00Z' },
    }, {
      Id: 'm-2', Name: 'Half', RunTimeTicks: 100 * 10_000_000,
      UserData: { Played: false, PlaybackPositionTicks: 25 * 10_000_000 },
    }]
    const episodes = [{
      Id: 'e-1', Name: 'Pilot', SeriesId: 's-1', SeasonId: 'sea-1', SeriesName: 'The Wire',
      ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 60 * 60 * 10_000_000,
      UserData: { Played: true, LastPlayedDate: '2026-05-02T21:00:00Z' },
    }]
    const rows = userData.historyRowsOf('jf-guid', '12345', 'kaleb', '/avatar', movies, episodes)
    expect(rows).toHaveLength(3)
    const heatAt = Math.floor(Date.parse('2026-05-01T20:00:00Z') / 1000)
    expect(rows[0]).toMatchObject({
      historyId: `jf:jf-guid:m-1:${heatAt}`, userId: '12345', ratingKey: 'm-1', mediaType: 'movie',
      title: 'Heat', year: 1995, thumb: '/Items/m-1/Images/Primary', watchedAt: heatAt,
      duration: 170 * 60, percentComplete: 100, watchedStatus: 'complete', userName: 'kaleb', userThumb: '/avatar',
      source: 'jellyfin', grandparentRatingKey: null,
    })
    expect(rows[1]).toMatchObject({ ratingKey: 'm-2', duration: 0, percentComplete: 25, watchedStatus: 'incomplete', watchedAt: 0 })
    expect(rows[2]).toMatchObject({
      ratingKey: 'e-1', grandparentRatingKey: 's-1', parentRatingKey: 'sea-1', parentTitle: 'The Wire',
      mediaType: 'episode', thumb: '/Items/s-1/Images/Primary', seasonNumber: 1, episodeNumber: 1,
      duration: 3600, percentComplete: 100, source: 'jellyfin',
    })
  })
})

describe('syncFavoritesWatchlist', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM watchlist').run()
  })

  it('adds new favorites, removes stale rows, and keeps rows inside the grace window', async () => {
    const user = 'u-fav'
    db.addToWatchlistDb(user, 'just-added', 'jellyfin')          // not favorited yet, but fresh
    db.addToWatchlistDb(user, 'stale', 'jellyfin')                // not favorited, old
    db.addToWatchlistDb(user, 'still-fav', 'jellyfin')
    db.addToWatchlistDb(user, 'plex-row', 'plex')                 // other source — untouched
    db.prepare('UPDATE watchlist SET added_at = ? WHERE rating_key IN (?, ?)')
      .run(Math.floor(Date.now() / 1000) - 3600, 'stale', 'still-fav')

    mockFetch((pathname, params) => (
      pathname === '/Users/jf-guid/Items' && params.get('Filters') === 'IsFavorite'
        ? { Items: [{ Id: 'still-fav' }, { Id: 'new-fav' }] }
        : undefined
    ))
    await userData.syncFavoritesWatchlist('jf-guid', user)

    const keys = db.getWatchlistFromDb(user, 'jellyfin').sort()
    expect(keys).toEqual(['just-added', 'new-fav', 'still-fav'])
    expect(db.getWatchlistFromDb(user, 'plex')).toEqual(['plex-row'])
  })

  it('swallows API errors without touching the table', async () => {
    db.addToWatchlistDb('u-err', 'keep', 'jellyfin')
    mockFetch(() => { throw new Error('offline') })
    await userData.syncFavoritesWatchlist('jf-guid', 'u-err')
    expect(db.getWatchlistFromDb('u-err', 'jellyfin')).toEqual(['keep'])
  })
})

describe('syncReviewRating (like/dislike mapping)', () => {
  it('maps ≥3.5 to like, ≤2.0 to dislike, and clears otherwise', async () => {
    const calls = mockFetch(() => null)
    await userData.syncReviewRating('jf-guid', 'item', 4)
    await userData.syncReviewRating('jf-guid', 'item', 3.5)
    await userData.syncReviewRating('jf-guid', 'item', 2)
    await userData.syncReviewRating('jf-guid', 'item', 3)
    await userData.syncReviewRating('jf-guid', 'item', null)
    expect(calls).toEqual([
      { path: '/Users/jf-guid/Items/item/Rating?Likes=true', method: 'POST' },
      { path: '/Users/jf-guid/Items/item/Rating?Likes=true', method: 'POST' },
      { path: '/Users/jf-guid/Items/item/Rating?Likes=false', method: 'POST' },
      { path: '/Users/jf-guid/Items/item/Rating', method: 'DELETE' },
      { path: '/Users/jf-guid/Items/item/Rating', method: 'DELETE' },
    ])
  })
})

describe('syncUserData', () => {
  it('mirrors played state, likes/dislikes and favorites onto the canonical user', async () => {
    db.seedJellyfinUser('jf_guid-2', 'linked', null)
    db.seedKnownUser('777', 'plexuser', null, null)
    db.linkJellyfinAccount('jf_guid-2', '777')

    mockFetch((pathname, params) => {
      if (pathname !== '/Users/guid-2/Items') return undefined
      const filters = params.get('Filters')
      const types = params.get('IncludeItemTypes')
      if (filters === 'IsPlayed' && types === 'Movie') {
        return { Items: [{ Id: 'm-1', Name: 'Heat', UserData: { Played: true, LastPlayedDate: '2026-05-01T20:00:00Z' } }] }
      }
      if (filters === 'IsPlayed' && types === 'Episode') {
        return { Items: [
          { Id: 'e-1', SeriesId: 's-1', Name: 'Pilot', UserData: { Played: true, LastPlayedDate: '2026-05-02T20:00:00Z' } },
          { Id: 'e-2', SeriesId: 's-1', Name: 'Ep 2', UserData: { Played: true, LastPlayedDate: '2026-05-03T20:00:00Z' } },
        ] }
      }
      if (filters === 'Likes') return { Items: [{ Id: 'm-1' }] }
      if (filters === 'Dislikes') return { Items: [{ Id: 's-1' }] }
      if (filters === 'IsFavorite') return { Items: [{ Id: 'm-1' }] }
      return undefined
    })

    await userData.syncUserData({ id: 'guid-2', name: 'linked', primaryImageTag: null })

    // Everything keyed on the Plex (canonical) id, nothing on the jf_ id.
    expect([...db.getWatchedKeysFromDb('777')].sort()).toEqual(['m-1', 's-1'])
    expect(db.getWatchedKeysFromDb('jf_guid-2').size).toBe(0)
    const ratings = db.getUserRatingsFromDb('777')
    expect(ratings.get('m-1')).toBe(7.5)
    expect(ratings.get('s-1')).toBe(2.5)
    expect(db.getWatchlistFromDb('777', 'jellyfin')).toEqual(['m-1'])

    // History for the recommenders: one movie row, the show de-duped with episodeCount.
    const history = userData.getFullHistoryFromDb('777')
    expect(history.find(h => h.media_type === 'movie')).toMatchObject({ rating_key: 'm-1', percent_complete: 100 })
    expect(history.find(h => h.media_type === 'show')).toMatchObject({ rating_key: 's-1', grandparent_rating_key: 's-1', episodeCount: 2 })
    expect(db.getSyncTime('jf_watched_guid-2')).toBeGreaterThan(0)
  })
})

describe('per-play history (Playback Reporting)', () => {
  const movie = { Id: 'm-1', Name: 'Heat', RunTimeTicks: 100 * 10_000_000, UserData: { Played: true, LastPlayedDate: '2026-05-01T20:00:00Z' } }
  const episode = { Id: 'e-1', Name: 'Pilot', SeriesId: 's-1', RunTimeTicks: 100 * 10_000_000, UserData: { Played: true, LastPlayedDate: '2026-05-02T20:00:00Z' } }

  it('emits one row per play for items with plays, the item-level row otherwise', () => {
    const plays = [
      { itemId: 'm-1', ts: 1000, duration: 50 },
      { itemId: 'm-1', ts: 2000, duration: 100 },
      { itemId: 'm-1', ts: 2000, duration: 100 }, // same-second duplicate collapses
      { itemId: 'unknown', ts: 3000, duration: 10 },
    ]
    const rows = userData.historyRowsOf('jf-guid', 'u', 'n', null, [movie], [episode], plays)
    expect(rows.map(r => [r.historyId, r.duration, r.percentComplete, r.watchedStatus])).toEqual([
      ['jf:jf-guid:m-1:1000', 50, 50, 'incomplete'],
      ['jf:jf-guid:m-1:2000', 100, 100, 'complete'],
      [`jf:jf-guid:e-1:${Math.floor(Date.parse('2026-05-02T20:00:00Z') / 1000)}`, 100, 100, 'complete'],
    ])
  })

  it('probes the plugin once and caches the answer; maps its column/row payload', async () => {
    let probes = 0
    mockFetch((pathname) => {
      if (pathname !== '/user_usage_stats/submit_custom_query') return undefined
      probes++
      return { colums: ['DateCreated', 'ItemId', 'PlayDuration', 'UserId'], results: [
        ['2026-05-01 20:00:00', 'm-1', '1800', 'guid'],
        ['bad-date', 'm-2', '10', 'guid'],
      ] }
    })
    expect(await userData.probePlaybackReporting(true)).toBe(true)
    expect(await userData.probePlaybackReporting()).toBe(true)
    expect(probes).toBe(1)
    const plays = await userData.getPlaybackReportingPlays('guid')
    expect(plays).toEqual([{ itemId: 'm-1', ts: Math.floor(Date.parse('2026-05-01 20:00:00') / 1000), duration: 1800 }])

    mockFetch(() => { throw new Error('Jellyfin API error 404') })
    expect(await userData.probePlaybackReporting(true)).toBe(false)
  })

  it('hasRecentJellyfinHistory honours the ±6h window', () => {
    db.prepare("DELETE FROM watch_history").run()
    db.upsertWatchHistoryBatch([{ historyId: 'jf:x:i:5000', userId: 'u-h', ratingKey: 'i', mediaType: 'movie', title: 't', watchedAt: 5000, source: 'jellyfin' }])
    expect(userData.hasRecentJellyfinHistory('u-h', 'i', 5000 + 3 * 3600)).toBe(true)
    expect(userData.hasRecentJellyfinHistory('u-h', 'i', 5000 + 7 * 3600)).toBe(false)
    expect(userData.hasRecentJellyfinHistory('u-h', 'other', 5000)).toBe(false)
  })
})
