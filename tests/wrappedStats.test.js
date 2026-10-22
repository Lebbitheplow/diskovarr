import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

const nodeRequire = createRequire(import.meta.url)
const wrapped = nodeRequire('../server/services/wrappedStats.js')
const { computePersonality } = nodeRequire('../server/services/wrappedPersonality.js')

// A play row shaped like wrappedStats.fetchPlays output.
function play(overrides = {}) {
  return {
    user_id: 'u1', user_name: 'User One', user_thumb: null,
    media_type: 'movie', entity_key: 'm1',
    title: 'Some Movie', parent_title: null, year: 2015, thumb: null,
    watched_at: Math.floor(new Date(2025, 5, 15, 21, 0).getTime() / 1000),
    duration: 5400, percent_complete: 95, watched_status: 'complete',
    li_title: null, li_year: null, li_thumb: null, li_genres: null,
    ...overrides,
  }
}

// ── Qualifying-play predicate (the wrapperr accuracy fix) ─────────────────────

describe('playQualifies', () => {
  it('accepts plays Tautulli marked complete, even short ones', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'complete', duration: 120, percent_complete: 5 }))).toBe(true)
  })
  it('rejects 4:59 of playback even at high completion', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'incomplete', duration: 299, percent_complete: 90 }))).toBe(false)
  })
  it('rejects 19% completion even with long duration', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'incomplete', duration: 3600, percent_complete: 19 }))).toBe(false)
  })
  it('accepts exactly 5 min and 20%', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'incomplete', duration: 300, percent_complete: 20 }))).toBe(true)
  })
})

// ── December unlock gate ──────────────────────────────────────────────────────

describe('isYearUnlocked', () => {
  it('is locked on Nov 30 of the wrap year', () => {
    expect(wrapped.isYearUnlocked(2025, new Date(2025, 10, 30, 23, 59))).toBe(false)
  })
  it('unlocks at midnight Dec 1', () => {
    expect(wrapped.isYearUnlocked(2025, new Date(2025, 11, 1, 0, 0))).toBe(true)
  })
  it('stays unlocked forever after (archive)', () => {
    expect(wrapped.isYearUnlocked(2021, new Date(2026, 6, 4))).toBe(true)
  })
  it('never unlocks future years', () => {
    expect(wrapped.isYearUnlocked(2026, new Date(2026, 6, 4))).toBe(false)
  })
})

// ── Entity aggregation ────────────────────────────────────────────────────────

describe('aggregateEntities', () => {
  it('rolls episodes up to the show and sums plays/seconds', () => {
    const entities = wrapped.aggregateEntities([
      play({ media_type: 'episode', entity_key: 's1', parent_title: 'The Show', duration: 1800 }),
      play({ media_type: 'episode', entity_key: 's1', parent_title: 'The Show', duration: 1500 }),
      play({ entity_key: 'm1', duration: 5400 }),
    ])
    expect(entities.size).toBe(2)
    expect(entities.get('s1')).toMatchObject({ mediaType: 'show', title: 'The Show', seconds: 3300, plays: 2 })
    expect(entities.get('m1')).toMatchObject({ mediaType: 'movie', seconds: 5400, plays: 1 })
  })
  it('prefers library_items metadata and parses genres', () => {
    const entities = wrapped.aggregateEntities([
      play({ entity_key: 'm2', title: 'stale title', li_title: 'Canonical', li_year: 1999, li_genres: '["Drama","Crime"]' }),
    ])
    expect(entities.get('m2')).toMatchObject({ title: 'Canonical', year: 1999, genres: ['Drama', 'Crime'] })
  })
})

// ── Genres ────────────────────────────────────────────────────────────────────

describe('computeGenres', () => {
  it('weights genres by seconds and yields a percentage mix', () => {
    const entities = wrapped.aggregateEntities([
      play({ entity_key: 'a', duration: 3000, li_genres: '["Drama"]' }),
      play({ entity_key: 'b', duration: 1000, li_genres: '["Comedy"]' }),
    ])
    const genres = wrapped.computeGenres(entities)
    expect(genres[0]).toMatchObject({ name: 'Drama', pct: 75 })
    expect(genres[1]).toMatchObject({ name: 'Comedy', pct: 25 })
  })
  it('returns [] when nothing has genre metadata', () => {
    const entities = wrapped.aggregateEntities([play({ li_genres: null })])
    expect(wrapped.computeGenres(entities)).toEqual([])
  })
})

// ── Time / binge / streak ─────────────────────────────────────────────────────

const ts = (y, m, d, h = 20) => Math.floor(new Date(y, m, d, h).getTime() / 1000)

describe('computeTimeStats', () => {
  it('handles a single day: streak of 1 and that day as binge day', () => {
    const t = wrapped.computeTimeStats([
      play({ watched_at: ts(2025, 2, 10, 21), duration: 3600 }),
      play({ watched_at: ts(2025, 2, 10, 23), duration: 1800 }),
    ])
    expect(t.streak).toMatchObject({ days: 1, start: '2025-03-10', end: '2025-03-10' })
    expect(t.bingeDay).toMatchObject({ date: '2025-03-10', seconds: 5400, plays: 2 })
    expect(t.peakHour).toBeGreaterThanOrEqual(21)
  })
  it('finds the longest consecutive-day streak, including across a month boundary', () => {
    const plays = [
      play({ watched_at: ts(2025, 0, 30) }),
      play({ watched_at: ts(2025, 0, 31) }),
      play({ watched_at: ts(2025, 1, 1) }),
      play({ watched_at: ts(2025, 1, 2) }),
      // gap
      play({ watched_at: ts(2025, 5, 10) }),
    ]
    expect(wrapped.computeTimeStats(plays).streak).toMatchObject({ days: 4, start: '2025-01-30', end: '2025-02-02' })
  })
  it('picks the max-seconds day as binge day over a max-plays day', () => {
    const t = wrapped.computeTimeStats([
      play({ watched_at: ts(2025, 3, 1), duration: 600 }),
      play({ watched_at: ts(2025, 3, 1, 21), duration: 600 }),
      play({ watched_at: ts(2025, 3, 2), duration: 7200 }),
    ])
    expect(t.bingeDay).toMatchObject({ date: '2025-04-02', seconds: 7200, plays: 1 })
  })
  it('accumulates month seconds into the right bucket', () => {
    const t = wrapped.computeTimeStats([play({ watched_at: ts(2025, 6, 4), duration: 1234 })])
    expect(t.months[6]).toBe(1234)
    expect(t.months.reduce((a, b) => a + b, 0)).toBe(1234)
  })
})

// ── Birth decade ──────────────────────────────────────────────────────────────

describe('computeBirthDecade', () => {
  const entitiesFromYears = (years) => wrapped.aggregateEntities(
    years.map((year, i) => play({ entity_key: `e${i}`, year, duration: 3600 }))
  )
  it('is ineligible below 5 dated titles', () => {
    expect(wrapped.computeBirthDecade(entitiesFromYears([1990, 1991, 1992, 1993]), 2025)).toMatchObject({ eligible: false })
  })
  it('puts the nostalgia peak at the cumulative-weight midpoint (uniform case)', () => {
    const result = wrapped.computeBirthDecade(entitiesFromYears([2000, 2000, 2000, 2000, 2000]), 2025)
    // birthYear = 2000 − 18 = 1982 → decade 1980, taste age 2025 − 1982 = 43
    expect(result).toMatchObject({ eligible: true, peakYear: 2000, decade: 1980, age: 43 })
  })
  it('lets log10 age-weighting pull the peak toward older titles', () => {
    // Equal watch time old vs new: the age multiplier makes 1980 outweigh 2024.
    const result = wrapped.computeBirthDecade(entitiesFromYears([1980, 1980, 2024, 2024, 2024]), 2025)
    expect(result.eligible).toBe(true)
    expect(result.peakYear).toBe(1980)
  })
  it('emits a decade distribution that sums to ~100%', () => {
    const result = wrapped.computeBirthDecade(entitiesFromYears([1985, 1995, 2005, 2015, 2020]), 2025)
    const sum = result.distribution.reduce((s, d) => s + d.pct, 0)
    expect(sum).toBeGreaterThanOrEqual(98)
    expect(sum).toBeLessThanOrEqual(102)
  })
})

// ── Percentiles & buddy ───────────────────────────────────────────────────────

describe('percentileOfRank', () => {
  it('maps rank to a top-X% figure', () => {
    expect(wrapped.percentileOfRank(1, 100)).toBe(1)
    expect(wrapped.percentileOfRank(1, 4)).toBe(25)
    expect(wrapped.percentileOfRank(4, 4)).toBe(100)
  })
  it('handles the single-user server without dividing by zero', () => {
    expect(wrapped.percentileOfRank(1, 1)).toBe(100)
    expect(wrapped.percentileOfRank(1, 0)).toBe(null)
  })
})

// ── Personality ───────────────────────────────────────────────────────────────

describe('computePersonality', () => {
  const base = {
    year: 2025,
    totals: { seconds: 100000, completionRate: 50, movies: { seconds: 40000 }, shows: { seconds: 60000, count: 5 } },
    time: { peakHour: 14, streak: null, bingeDay: null },
    decade: { eligible: false },
  }
  it('assigns the dominant genre-family archetype', () => {
    const p = computePersonality({ ...base, genres: [
      { name: 'Fantasy', seconds: 5000 }, { name: 'Adventure', seconds: 3000 }, { name: 'Drama', seconds: 1000 },
    ] })
    expect(p.title).toBe('The Adventurer')
    expect(p.blurb.length).toBeGreaterThan(40)
  })
  it('falls back to The Omnivore when no family dominates', () => {
    const p = computePersonality({ ...base, genres: [
      { name: 'Comedy', seconds: 1000 }, { name: 'Horror', seconds: 1000 }, { name: 'Drama', seconds: 1000 },
      { name: 'Documentary', seconds: 1000 }, { name: 'Action', seconds: 1000 },
    ] })
    expect(p.title).toBe('The Omnivore')
  })
  it('is The Omnivore with no genre data at all', () => {
    expect(computePersonality({ ...base, genres: [] }).title).toBe('The Omnivore')
  })
  it('awards Night Owl for a 11 PM peak and Completionist at 90%+', () => {
    const p = computePersonality({
      ...base,
      totals: { ...base.totals, completionRate: 95 },
      time: { ...base.time, peakHour: 23 },
      genres: [{ name: 'Horror', seconds: 5000 }],
    })
    const keys = p.traits.map((t) => t.key)
    expect(keys).toContain('night-owl')
    expect(keys).toContain('completionist')
    expect(p.title).toBe('The Thrill Seeker')
  })
  it('caps traits at 3', () => {
    const p = computePersonality({
      year: 2025,
      totals: { seconds: 100000, completionRate: 99, movies: { seconds: 90000 }, shows: { seconds: 10000, count: 1 } },
      time: { peakHour: 23, streak: { days: 10 }, bingeDay: { seconds: 30000 } },
      decade: { eligible: true, peakYear: 1980 },
      genres: [{ name: 'Comedy', seconds: 5000 }],
    })
    expect(p.traits.length).toBe(3)
  })
})

describe('pickShowBuddy', () => {
  it('returns the other user closest in watch time', () => {
    const watchers = new Map([['me', 10000], ['far', 40000], ['close', 11000]])
    expect(wrapped.pickShowBuddy('me', watchers)).toMatchObject({ userId: 'close', theirSeconds: 11000, mySeconds: 10000 })
  })
  it('returns null when nobody else watched the show', () => {
    expect(wrapped.pickShowBuddy('me', new Map([['me', 10000]]))).toBe(null)
  })
  it('returns null when the user is not among the watchers', () => {
    expect(wrapped.pickShowBuddy('ghost', new Map([['a', 1], ['b', 2]]))).toBe(null)
  })
})

// ── Jellyfin history feeding Wrapped ─────────────────────────────────────────

describe('Wrapped totals from a Jellyfin user across repeated syncs', () => {
  const db = nodeRequire('../server/db/database.js')
  const client = nodeRequire('../server/services/jellyfin/client.js')
  const userData = nodeRequire('../server/services/jellyfin/userData.js')
  const pad = (n) => String(n).padStart(2, '0')
  const local = (ts) => {
    const d = new Date(ts * 1000)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  it('counts each real play once and keeps seconds/plays stable', async () => {
    db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
    db.setSetting('jellyfin_api_key', 'test-key')
    db.setSetting('jellyfin_enabled', '1')
    db.seedJellyfinUser('jf_wrap-1', 'wrapper', null)
    const T = Math.floor(new Date(2025, 5, 14, 20, 0).getTime() / 1000)
    const movie = { Id: 'w-mv', Type: 'Movie', Name: 'Collateral', RunTimeTicks: 3600 * 10_000_000 }
    const episode = { Id: 'w-ep', Type: 'Episode', Name: 'Pilot', SeriesId: 'w-show', RunTimeTicks: 1800 * 10_000_000 }

    // The websocket tracker saw the first play; Playback Reporting has both.
    userData.replaceJellyfinHistoryRow(userData.historyRowFor('wrap-1', 'jf_wrap-1', 'wrapper', null, movie,
      { ts: T + 15, duration: 2900, origin: 'session', historyId: `jfs:wrap-1:w-mv:tv:${T + 15}` }))
    client.jfFetch = async (p) => {
      const [pathname, qs = ''] = p.split('?')
      const params = new URLSearchParams(qs)
      if (pathname === '/user_usage_stats/submit_custom_query') {
        return { colums: ['DateCreated', 'ItemId', 'PlayDuration', 'UserId', 'ItemType', 'ItemName'], results: [
          [local(T), 'w-mv', '3000', 'wrap-1', 'Movie', 'Collateral'],          // 83%: qualifies on time
          [local(T + 7200), 'w-mv', '3600', 'wrap-1', 'Movie', 'Collateral'],   // same-day rewatch
        ] }
      }
      const key = `${params.get('Filters')}:${params.get('IncludeItemTypes')}`
      const lists = {
        'IsPlayed:Movie': [{ ...movie, UserData: { Played: true, LastPlayedDate: new Date((T + 7200) * 1000).toISOString() } }],
        'IsPlayed:Episode': [{ ...episode, UserData: { Played: true, LastPlayedDate: new Date((T + 86400) * 1000).toISOString() } }],
      }
      const items = lists[key] || []
      return { Items: items, TotalRecordCount: items.length }
    }

    const totals = []
    for (let i = 0; i < 3; i++) {
      await userData.probePlaybackReporting(true)
      await userData.syncUserData({ id: 'wrap-1', name: 'wrapper', primaryImageTag: null })
      wrapped.computeWrappedYear(2025)
      totals.push(JSON.parse(db.prepare('SELECT payload FROM wrapped_global WHERE year = 2025').get().payload).totals)
    }
    // Two plugin plays of the movie (the websocket copy and the stand-in drop
    // out) plus the episode's stand-in.
    expect(totals[0]).toMatchObject({ plays: 3, seconds: 3000 + 3600 + 1800 })
    expect(totals[1]).toEqual(totals[0])
    expect(totals[2]).toEqual(totals[0])
  })
})

// ── Playlist target + Jellyfin history refresh (JF-18) ───────────────────────

describe('Wrapped playlist target (JF-18)', () => {
  const express = nodeRequire('../server/node_modules/express')
  const db = nodeRequire('../server/db/database.js')
  const plex = nodeRequire('../server/services/plex.js')
  const jellyfin = nodeRequire('../server/services/jellyfin/index.js')
  const jfPlaylists = nodeRequire('../server/services/jellyfin/playlists.js')
  const router = nodeRequire('../server/routes/wrapped.js')
  let server, base

  const lib = (ratingKey, type, tmdbId, source, title) => ({
    ratingKey, sectionId: source === 'plex' ? '1' : 'jf_x', title, year: 2015, thumb: null, art: null, type,
    genres: [], directors: [], cast: [], audienceRating: 0, contentRating: '', addedAt: 0, summary: '',
    rating: 0, ratingImage: '', audienceRatingImage: '', studio: '', tmdbId, source,
  })
  const pick = (key, title) => ({ ratingKey: key, libraryKey: key, title, year: 2015, seconds: 9000, plays: 2 })

  beforeAll(async () => {
    db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
    db.setSetting('jellyfin_api_key', 'admin-key')
    db.setSetting('jellyfin_enabled', '1')
    db.upsertManyItems([
      lib('55', 'movie', '100', 'plex', 'Shared Movie'), lib('jf-1', 'movie', '100', 'jellyfin', 'Shared Movie'),
      lib('jf-2', 'movie', '200', 'jellyfin', 'Jellyfin Only'),
      lib('77', 'show', '300', 'plex', 'Shared Show'), lib('jf-s', 'show', '300', 'jellyfin', 'Shared Show'),
    ])
    // History keys: one Plex play, one Jellyfin-only title, one show watched on Plex
    vi.spyOn(wrapped, 'isYearUnlocked').mockReturnValue(true)
    vi.spyOn(wrapped, 'getWrapped').mockReturnValue({
      payload: {
        topMovies: { bySeconds: [pick('55', 'Shared Movie'), pick('jf-2', 'Jellyfin Only')] },
        topShows: { bySeconds: [pick('77', 'Shared Show')] },
      },
    })
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      const linked = req.get('x-linked') === '1'
      req.session = {
        plexUser: {
          id: 'u1', username: 'u1', provider: 'plex',
          token: req.get('x-no-plex') ? null : 'PLEX_TOKEN',
          jellyfin: linked ? { userId: 'jfu', token: 'JF_TOKEN' } : null,
        },
        activeSource: req.get('x-source') || 'plex',
        isAdmin: req.get('x-admin') === '1',
      }
      next()
    })
    app.use('/api/wrapped', router)
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    if (server) await new Promise(resolve => server.close(resolve))
  })

  async function post(path, { headers = {}, body } = {}) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) })
    return { status: res.status, data: await res.json() }
  }

  it('builds it on Jellyfin for a linked user browsing Jellyfin, matching titles by TMDB id', async () => {
    const plexCreate = vi.spyOn(plex, 'createPlaylistWithItems').mockResolvedValue({ playlistId: 'p', count: 0 })
    const jfCreate = vi.spyOn(jfPlaylists, 'createPlaylistWithItems').mockResolvedValue({ playlistId: 'jp', count: 3 })
    const { status, data } = await post('/api/wrapped/2025/playlist', { headers: { 'x-linked': '1', 'x-source': 'jellyfin' } })
    expect(status).toBe(200)
    expect(data.source).toBe('jellyfin')
    expect(plexCreate).not.toHaveBeenCalled()
    expect(jfCreate).toHaveBeenCalledWith('jfu', 'Diskovarr Wrapped 2025', ['jf-1', 'jf-2', 'jf-s'], { token: 'JF_TOKEN' })
  })

  it('an explicit target wins over the active source; Plex gets only the titles it has', async () => {
    const plexCreate = vi.spyOn(plex, 'createPlaylistWithItems').mockResolvedValue({ playlistId: 'p', count: 2 })
    const { status, data } = await post('/api/wrapped/2025/playlist', { headers: { 'x-linked': '1', 'x-source': 'jellyfin' }, body: { target: 'plex' } })
    expect(status).toBe(200)
    expect(data.source).toBe('plex')
    expect(plexCreate).toHaveBeenCalledWith('PLEX_TOKEN', 'Diskovarr Wrapped 2025', ['55', '77'])
  })

  it('refuses a target the session cannot use, and falls back when none is asked for', async () => {
    expect((await post('/api/wrapped/2025/playlist', { body: { target: 'jellyfin' } })).status).toBe(400)
    expect((await post('/api/wrapped/2025/playlist', { body: { target: 'emby' } })).status).toBe(400)
    // Jellyfin-only session (no Plex token) still lands on Jellyfin with no target
    const jfCreate = vi.spyOn(jfPlaylists, 'createPlaylistWithItems').mockResolvedValue({ playlistId: 'jp', count: 3 })
    const { data } = await post('/api/wrapped/2025/playlist', { headers: { 'x-linked': '1', 'x-no-plex': '1' } })
    expect(data.source).toBe('jellyfin')
    expect(jfCreate).toHaveBeenCalled()
  })

  it('admin Jellyfin history refresh reports what Jellyfin can provide', async () => {
    const sync = vi.spyOn(jellyfin, 'syncAllUsers').mockResolvedValue(3)
    const probe = vi.spyOn(jellyfin, 'probePlaybackReporting').mockResolvedValue(false)
    expect((await post('/api/wrapped/backfill/jellyfin')).status).toBe(403)
    expect(sync).not.toHaveBeenCalled()
    const { status, data } = await post('/api/wrapped/backfill/jellyfin', { headers: { 'x-admin': '1' } })
    expect(status).toBe(200)
    expect(data).toEqual({ users: 3, playbackReporting: false, history: 'latest-play' })
    expect(probe).toHaveBeenCalledWith(true)
    probe.mockResolvedValue(true)
    expect((await post('/api/wrapped/backfill/jellyfin', { headers: { 'x-admin': '1' } })).data.history).toBe('per-play')
  })
})
