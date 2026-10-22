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
      UserData: { Played: false, PlaybackPositionTicks: 25 * 10_000_000, LastPlayedDate: '2026-05-03T20:00:00Z' },
    }, {
      Id: 'm-3', Name: 'Never started', RunTimeTicks: 100 * 10_000_000, UserData: { Played: false },
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
      source: 'jellyfin', origin: 'snapshot', grandparentRatingKey: null,
    })
    // In progress: the resume position stands in for the time watched; an item
    // with no play date has nothing to place in history.
    expect(rows[1]).toMatchObject({
      ratingKey: 'm-2', duration: 25, percentComplete: 25, watchedStatus: 'incomplete',
      watchedAt: Math.floor(Date.parse('2026-05-03T20:00:00Z') / 1000), origin: 'snapshot',
    })
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

  it('emits every plugin play as its own row, plus a snapshot stand-in per listed item', () => {
    const plays = [
      { itemId: 'm-1', ts: 1000, duration: 50 },
      { itemId: 'm-1', ts: 2000, duration: 100 },
      { itemId: 'm-1', ts: 2000, duration: 100 }, // same-second duplicate collapses
      { itemId: 'gone', ts: 3000, duration: 1200, itemType: 'Episode', itemName: 'Lost - s02e05 - The Hatch' },
      { itemId: 'looked-up', ts: 4000, duration: 60 },
    ]
    const itemsById = new Map([['looked-up', { Id: 'looked-up', Type: 'Movie', Name: 'Found', RunTimeTicks: 120 * 10_000_000 }]])
    const rows = userData.historyRowsOf('jf-guid', 'u', 'n', null, [movie], [episode], plays, itemsById)
    expect(rows.map(r => [r.historyId, r.origin, r.duration, r.percentComplete, r.watchedStatus])).toEqual([
      ['jf:jf-guid:m-1:1000', 'plugin', 50, 50, 'incomplete'],
      ['jf:jf-guid:m-1:2000', 'plugin', 100, 100, 'complete'],
      ['jf:jf-guid:gone:3000', 'plugin', 1200, 0, 'incomplete'],
      ['jf:jf-guid:looked-up:4000', 'plugin', 60, 50, 'incomplete'],
      [`jf:jf-guid:m-1:${Math.floor(Date.parse('2026-05-01T20:00:00Z') / 1000)}`, 'snapshot', 100, 100, 'complete'],
      [`jf:jf-guid:e-1:${Math.floor(Date.parse('2026-05-02T20:00:00Z') / 1000)}`, 'snapshot', 100, 100, 'complete'],
    ])
    // A removed title keeps what the plugin recorded about it.
    expect(rows[2]).toMatchObject({ mediaType: 'episode', title: 'The Hatch', parentTitle: 'Lost', seasonNumber: 2, episodeNumber: 5 })
    expect(rows[3]).toMatchObject({ mediaType: 'movie', title: 'Found' })
  })

  it('probes the plugin once and caches the answer; maps its column/row payload', async () => {
    let probes = 0
    mockFetch((pathname) => {
      if (pathname !== '/user_usage_stats/submit_custom_query') return undefined
      probes++
      return { colums: ['DateCreated', 'ItemId', 'PlayDuration', 'UserId', 'ItemType', 'ItemName'], results: [
        ['2026-05-01 20:00:00', 'm-1', '1800', 'guid', 'Movie', 'Heat'],
        ['bad-date', 'm-2', '10', 'guid', 'Movie', 'Other'],
      ] }
    })
    expect(await userData.probePlaybackReporting(true)).toBe(true)
    expect(await userData.probePlaybackReporting()).toBe(true)
    expect(probes).toBe(1)
    const plays = await userData.getPlaybackReportingPlays('guid')
    expect(plays).toEqual([{
      itemId: 'm-1', ts: Math.floor(Date.parse('2026-05-01 20:00:00') / 1000), duration: 1800, itemType: 'Movie', itemName: 'Heat',
    }])

    mockFetch(() => { throw new Error('Jellyfin API error 404') })
    expect(await userData.probePlaybackReporting(true)).toBe(false)
  })

  it('hasRealJellyfinPlay honours the ±6h window and ignores stand-ins', () => {
    db.prepare("DELETE FROM watch_history").run()
    db.upsertWatchHistoryBatch([
      { historyId: 'jfs:x:i:s:5000', userId: 'u-h', ratingKey: 'i', mediaType: 'movie', title: 't', watchedAt: 5000, source: 'jellyfin', origin: 'session' },
      { historyId: 'jf:x:j:5000', userId: 'u-h', ratingKey: 'j', mediaType: 'movie', title: 't', watchedAt: 5000, source: 'jellyfin', origin: 'snapshot' },
    ])
    expect(userData.hasRealJellyfinPlay('u-h', 'i', 5000 + 3 * 3600)).toBe(true)
    expect(userData.hasRealJellyfinPlay('u-h', 'i', 5000 + 7 * 3600)).toBe(false)
    expect(userData.hasRealJellyfinPlay('u-h', 'other', 5000)).toBe(false)
    expect(userData.hasRealJellyfinPlay('u-h', 'j', 5000)).toBe(false)
  })
})

// A scripted Jellyfin user library for syncUserData: lists keyed by
// "<Filters>:<IncludeItemTypes>", paged by StartIndex/Limit with
// TotalRecordCount like the real server. `failFrom` makes one list fail from
// a given StartIndex; `plugin` rows answer the Playback Reporting query (or
// it 404s); `items` answers the /Items?Ids= lookup.
function userLibrary(jfGuid, lists, { failFrom = null, plugin = null, items = {} } = {}) {
  return mockFetch((pathname, params) => {
    if (pathname === '/user_usage_stats/submit_custom_query') {
      if (!plugin) throw new Error('Jellyfin API error 404')
      return { colums: ['DateCreated', 'ItemId', 'PlayDuration', 'UserId', 'ItemType', 'ItemName'], results: plugin }
    }
    if (pathname === '/Items') {
      return { Items: (params.get('Ids') || '').split(',').map(id => items[id]).filter(Boolean) }
    }
    if (pathname !== `/Users/${jfGuid}/Items`) return undefined
    const key = `${params.get('Filters')}:${params.get('IncludeItemTypes')}`
    const all = lists[key] || []
    const start = Number(params.get('StartIndex') || 0)
    const limit = Number(params.get('Limit') || all.length)
    if (failFrom && failFrom.key === key && start >= failFrom.start) throw new Error('Jellyfin API error 500')
    return { Items: all.slice(start, start + limit), TotalRecordCount: all.length }
  })
}

// Playback Reporting stores DateCreated as a local "YYYY-MM-DD HH:MM:SS" string.
const pad = (n) => String(n).padStart(2, '0')
function pluginDate(ts) {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const iso = (ts) => new Date(ts * 1000).toISOString()
const historyOf = (userId) => db.prepare(
  "SELECT history_id, rating_key, origin, watched_at, duration, percent_complete, watched_status, title FROM watch_history WHERE user_id = ? ORDER BY watched_at, history_id"
).all(userId)
const sync = async (guid, name = guid) => {
  await userData.probePlaybackReporting(true)
  return userData.syncUserData({ id: guid, name, primaryImageTag: null })
}

describe('complete reads before reconciling', () => {
  it('pages the played lists past one page and mirrors the whole set', async () => {
    db.seedJellyfinUser('jf_page-1', 'pager', null)
    const movies = Array.from({ length: 2500 }, (_, i) => ({ Id: `pm-${i}`, Type: 'Movie', UserData: { Played: true } }))
    const calls = userLibrary('page-1', { 'IsPlayed:Movie': movies })
    await sync('page-1')
    expect(db.getWatchedKeysFromDb('jf_page-1').size).toBe(2500)
    const starts = calls.filter(c => c.path.includes('Filters=IsPlayed') && c.path.includes('IncludeItemTypes=Movie'))
      .map(c => new URLSearchParams(c.path.split('?')[1]).get('StartIndex'))
    expect(starts).toEqual(['0', '1000', '2000'])
  })

  it('a failed second page changes no watched keys, history or ratings', async () => {
    db.seedJellyfinUser('jf_page-2', 'pager', null)
    db.replaceWatchedBatch('jf_page-2', ['keep'], 'jellyfin')
    db.upsertUserRatings('jf_page-2', [{ ratingKey: 'liked', userRating: 7.5 }], 'jellyfin')
    const movies = Array.from({ length: 1500 }, (_, i) => ({ Id: `pm-${i}`, Type: 'Movie', UserData: { Played: true, LastPlayedDate: iso(1_700_000_000) } }))
    userLibrary('page-2', { 'IsPlayed:Movie': movies }, { failFrom: { key: 'IsPlayed:Movie', start: 1000 } })
    await expect(sync('page-2')).rejects.toThrow('500')
    expect([...db.getWatchedKeysFromDb('jf_page-2')]).toEqual(['keep'])
    expect(historyOf('jf_page-2')).toEqual([])
    expect(db.getUserRatingsFromDb('jf_page-2').get('liked')).toBe(7.5)
  })

  it('a short page that disagrees with TotalRecordCount is an incomplete read', async () => {
    mockFetch(() => ({ Items: [{ Id: 'a' }], TotalRecordCount: 3 }))
    await expect(userData.queryUserItems('g', { Filters: 'IsPlayed' })).rejects.toThrow('Incomplete Jellyfin listing')
  })

  it('a failed favorites page removes nothing', async () => {
    db.prepare('DELETE FROM watchlist').run()
    db.addToWatchlistDb('u-favpage', 'old-fav', 'jellyfin')
    db.prepare('UPDATE watchlist SET added_at = 0').run()
    const favs = Array.from({ length: 1200 }, (_, i) => ({ Id: `f-${i}` }))
    userLibrary('fav-guid', { 'IsFavorite:Movie,Series': favs }, { failFrom: { key: 'IsFavorite:Movie,Series', start: 1000 } })
    await userData.syncFavoritesWatchlist('fav-guid', 'u-favpage')
    expect(db.getWatchlistFromDb('u-favpage', 'jellyfin')).toEqual(['old-fav'])
  })
})

describe('in-progress items and real plays in the watched list', () => {
  const T = 1_760_000_000

  it('counts a resumable movie past the threshold and any resumable episode', async () => {
    db.seedJellyfinUser('jf_res-1', 'resumer', null)
    userLibrary('res-1', {
      'IsResumable:Movie,Episode': [
        { Id: 'half', Type: 'Movie', Name: 'Half', RunTimeTicks: 100 * 10_000_000, UserData: { PlaybackPositionTicks: 50 * 10_000_000, LastPlayedDate: iso(T) } },
        { Id: 'barely', Type: 'Movie', Name: 'Barely', RunTimeTicks: 100 * 10_000_000, UserData: { PlaybackPositionTicks: 5 * 10_000_000, LastPlayedDate: iso(T) } },
        { Id: 'ep-r', Type: 'Episode', Name: 'Ep', SeriesId: 'show-r', RunTimeTicks: 100 * 10_000_000, UserData: { PlaybackPositionTicks: 3 * 10_000_000, LastPlayedDate: iso(T) } },
      ],
    })
    await sync('res-1')
    expect([...db.getWatchedKeysFromDb('jf_res-1')].sort()).toEqual(['half', 'show-r'])
    expect(historyOf('jf_res-1').find(r => r.rating_key === 'half'))
      .toMatchObject({ origin: 'snapshot', duration: 50, percent_complete: 50, watched_status: 'incomplete' })
  })

  it('an item marked unplayed leaves the list unless a real play keeps it', async () => {
    db.seedJellyfinUser('jf_res-2', 'unmarker', null)
    const played = (id) => ({ Id: id, Type: 'Movie', Name: id, RunTimeTicks: 100 * 10_000_000, UserData: { Played: true, LastPlayedDate: iso(T) } })
    userLibrary('res-2', { 'IsPlayed:Movie': [played('marked'), played('watched')] })
    await sync('res-2')
    expect([...db.getWatchedKeysFromDb('jf_res-2')].sort()).toEqual(['marked', 'watched'])
    // A real partial play of 'watched' was observed by the websocket tracker.
    userData.replaceJellyfinHistoryRow(userData.historyRowFor('res-2', 'jf_res-2', 'u', null,
      { Id: 'watched', Type: 'Movie', Name: 'watched', RunTimeTicks: 100 * 10_000_000 },
      { ts: T - 86400, duration: 40, origin: 'session', historyId: `jfs:res-2:watched:s:${T - 86400}` }))
    userLibrary('res-2', {}) // both marked unplayed in Jellyfin
    await sync('res-2')
    expect([...db.getWatchedKeysFromDb('jf_res-2')]).toEqual(['watched'])
  })

  it('a resumed viewing stays one history row through to completion', async () => {
    db.seedJellyfinUser('jf_res-3', 'resumer', null)
    const item = (userDataFields) => ({ Id: 'long', Type: 'Movie', Name: 'Long', RunTimeTicks: 100 * 10_000_000, UserData: userDataFields })
    userLibrary('res-3', { 'IsResumable:Movie,Episode': [item({ PlaybackPositionTicks: 40 * 10_000_000, LastPlayedDate: iso(T) })] })
    await sync('res-3')
    userLibrary('res-3', { 'IsResumable:Movie,Episode': [item({ PlaybackPositionTicks: 70 * 10_000_000, LastPlayedDate: iso(T + 86400) })] })
    await sync('res-3')
    userLibrary('res-3', { 'IsPlayed:Movie': [item({ Played: true, LastPlayedDate: iso(T + 86400) })] })
    await sync('res-3')
    expect(historyOf('jf_res-3')).toMatchObject([{ watched_at: T + 86400, duration: 100, watched_status: 'complete', origin: 'snapshot' }])
  })

  it('records plugin plays of removed and unlisted items, looking each up once', async () => {
    db.seedJellyfinUser('jf_plg-1', 'plugger', null)
    const plugin = [
      [pluginDate(T), 'removed', '2400', 'plg-1', 'Movie', 'Gone Girl'],
      [pluginDate(T + 3600), 'rewatching', '600', 'plg-1', 'Movie', 'Heat'],
    ]
    const items = { rewatching: { Id: 'rewatching', Type: 'Movie', Name: 'Heat', RunTimeTicks: 1200 * 10_000_000 } }
    const calls = userLibrary('plg-1', {}, { plugin, items })
    await sync('plg-1')
    expect(historyOf('jf_plg-1')).toMatchObject([
      { rating_key: 'removed', origin: 'plugin', title: 'Gone Girl', duration: 2400, percent_complete: 0 },
      { rating_key: 'rewatching', origin: 'plugin', title: 'Heat', duration: 600, percent_complete: 50 },
    ])
    expect(calls.filter(c => c.path.startsWith('/Items?')).length).toBe(1)
    // Stored rows keep their metadata: no new lookup, nothing duplicated.
    const again = userLibrary('plg-1', {}, { plugin, items: {} })
    await sync('plg-1')
    expect(again.filter(c => c.path.startsWith('/Items?')).length).toBe(0)
    expect(historyOf('jf_plg-1').map(r => [r.rating_key, r.title])).toEqual([['removed', 'Gone Girl'], ['rewatching', 'Heat']])
  })
})

describe('history provenance', () => {
  const T = 1_760_100_000
  const item = { Id: 'mv', Type: 'Movie', Name: 'Thief', RunTimeTicks: 3600 * 10_000_000 }
  const session = (sid, ts, duration) => userData.historyRowFor('prov', 'jf_prov', 'u', null, item,
    { ts, duration, origin: 'session', historyId: `jfs:prov:mv:${sid}:${ts}` })

  beforeEach(() => { db.prepare("DELETE FROM watch_history WHERE user_id = 'jf_prov'").run() })

  it('keeps same-day rewatches and simultaneous devices as separate plays', () => {
    userData.replaceJellyfinHistoryRow(session('tv', T, 3000))
    userData.replaceJellyfinHistoryRow(session('tv', T + 7200, 3000)) // two hours later
    userData.replaceJellyfinHistoryRow(session('phone', T + 60, 2900)) // another device, same time
    expect(historyOf('jf_prov').map(r => r.history_id)).toEqual([
      `jfs:prov:mv:tv:${T}`, `jfs:prov:mv:phone:${T + 60}`, `jfs:prov:mv:tv:${T + 7200}`,
    ])
  })

  it('a real play replaces only the stand-in of that play', () => {
    db.upsertWatchHistoryBatch([
      { ...userData.historyRowFor('prov', 'jf_prov', 'u', null, { ...item, UserData: { Played: true, LastPlayedDate: iso(T) } }) },
      { historyId: `jf:prov:mv:${T - 3 * 3600}`, userId: 'jf_prov', ratingKey: 'mv', mediaType: 'movie', title: 'Thief',
        watchedAt: T - 3 * 3600, duration: 3600, source: 'jellyfin', origin: 'plugin' },
    ])
    userData.replaceJellyfinHistoryRow(session('tv', T + 30, 3500))
    expect(historyOf('jf_prov').map(r => r.origin)).toEqual(['plugin', 'session'])
  })

  it('plugin and websocket rows of one play count once, the plugin row winning', async () => {
    db.seedJellyfinUser('jf_prov', 'prov', null)
    userData.replaceJellyfinHistoryRow(session('tv', T + 20, 3400))
    userLibrary('prov', { 'IsPlayed:Movie': [{ ...item, UserData: { Played: true, LastPlayedDate: iso(T + 20) } }] },
      { plugin: [[pluginDate(T), 'mv', '3500', 'prov', 'Movie', 'Thief']] })
    await sync('prov')
    await sync('prov')
    expect(historyOf('jf_prov')).toMatchObject([{ history_id: `jf:prov:mv:${T}`, origin: 'plugin', duration: 3500 }])
    // The tracker seeing that play again (e.g. after a restart) adds nothing.
    userData.replaceJellyfinHistoryRow(session('tv2', T + 1800, 1700))
    expect(historyOf('jf_prov')).toHaveLength(1)
  })

  it('a snapshot stand-in never overwrites a real play with the same id', () => {
    const id = `jf:prov:mv:${T}`
    db.upsertWatchHistoryBatch([{ historyId: id, userId: 'jf_prov', ratingKey: 'mv', mediaType: 'movie', title: 'Thief', watchedAt: T, duration: 1234, source: 'jellyfin', origin: 'plugin' }])
    db.upsertWatchHistoryBatch([{ historyId: id, userId: 'jf_prov', ratingKey: 'mv', mediaType: 'movie', title: 'Thief', watchedAt: T, duration: 3600, source: 'jellyfin', origin: 'snapshot' }])
    expect(historyOf('jf_prov')).toMatchObject([{ origin: 'plugin', duration: 1234 }])
  })
})

describe('like/dislike reconcile', () => {
  const run = async (liked, disliked, opts = {}) => {
    userLibrary('rate-1', {
      'Likes:Movie,Series': liked.map(Id => ({ Id })),
      'Dislikes:Movie,Series': disliked.map(Id => ({ Id })),
    }, opts)
    await sync('rate-1')
    return Object.fromEntries(db.getUserRatingsFromDb('jf_rate-1'))
  }

  it('drops cleared likes/dislikes and follows a flip, keeping Plex ratings', async () => {
    db.seedJellyfinUser('jf_rate-1', 'rater', null)
    db.upsertUserRatings('jf_rate-1', [{ ratingKey: '12345', userRating: 8 }]) // Plex star rating
    expect(await run(['a', 'b'], ['c', 'd'])).toEqual({ 12345: 8, a: 7.5, b: 7.5, c: 2.5, d: 2.5 })
    // a: like → clear, c: dislike → clear, b: like → dislike
    expect(await run([], ['b', 'd'])).toEqual({ 12345: 8, b: 2.5, d: 2.5 })
  })

  it('a failed or partial read changes nothing', async () => {
    const before = await run(['x'], [])
    const likes = Array.from({ length: 1001 }, (_, i) => `l-${i}`)
    expect(await run(likes, [], { failFrom: { key: 'Likes:Movie,Series', start: 1000 } })).toEqual(before)
  })
})

describe('syncAllUsers concurrency', () => {
  it('a caller arriving mid-sync shares the running sync and its user count', async () => {
    const libraryAccess = nodeRequire('../server/services/libraryAccess/index.js')
    const realPolicies = libraryAccess.syncJellyfinPolicies
    const realGetUsers = client.getUsers
    libraryAccess.syncJellyfinPolicies = async () => {}
    let release
    let usersCalls = 0
    client.getUsers = async () => {
      usersCalls++
      await new Promise(r => { release = r })
      return [{ id: 'cc'.repeat(16), name: 'one', isDisabled: false }, { id: 'dd'.repeat(16), name: 'two', isDisabled: false }]
    }
    mockFetch(() => undefined)
    try {
      const first = userData.syncAllUsers()
      const second = userData.syncAllUsers()
      await new Promise(r => setImmediate(r))
      release()
      expect(await first).toBe(2)
      expect(await second).toBe(2)
      expect(usersCalls).toBe(1)
    } finally {
      client.getUsers = realGetUsers
      libraryAccess.syncJellyfinPolicies = realPolicies
    }
  })
})
