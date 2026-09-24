import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Riven (DUMB) reset flow: look a title up by TMDB id, map a season/episode
// selection to Riven item ids, then reset + retry. The db module runs
// migrations at require time — point it at a scratch dir first.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-riven-reset-test-'))
process.env.DISKOVARR_DATA_DIR = DATA_DIR
process.env.TUBERR_MANAGED = '0'
process.env.RIVEN_SETTINGS_PATH = path.join(DATA_DIR, 'no-such-settings.json')

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const tmdb = nodeRequire('../server/services/tmdb.js')
const riven = nodeRequire('../server/services/rivenClient.js')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// Routes: [method, urlNeedle] → body | (url, opts) => body. Records every call.
function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    const method = (opts.method || 'GET').toUpperCase()
    calls.push({ url: u, method, headers: opts.headers || {} })
    for (const [key, body] of routes) {
      const [m, needle] = key.split(' ')
      if (m === method && u.includes(needle)) {
        const payload = typeof body === 'function' ? body(u, opts) : body
        const status = payload?.__status || 200
        return { ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }
      }
    }
    return { ok: false, status: 404, json: async () => ({ detail: 'Item not found' }), text: async () => '{"detail":"Item not found"}' }
  }
  return calls
}

const SHOW = {
  id: 'show_tvdb1', title: 'Some Show', type: 'Show', state: 'Completed', imdb_id: 'tt1',
  seasons: [
    { id: 'season_tvdb1_s2', season_number: 2, state: 'PartiallyCompleted', episodes: [
      { id: 'episode_tvdb21', episode_number: 1, title: 'Two-One', state: 'Completed', aired_at: '2024-01-01 00:00:00' },
    ] },
    { id: 'season_tvdb1_s1', season_number: 1, state: 'Completed', episodes: [
      { id: 'episode_tvdb12', episode_number: 2, title: 'One-Two', state: 'Failed', aired_at: 'None' },
      { id: 'episode_tvdb11', episode_number: 1, title: 'One-One', state: 'Completed', aired_at: 'None' },
    ] },
  ],
}
const MOVIE = { id: 'movie_tmdb9820', title: 'Some Movie', type: 'Movie', state: 'Completed', imdb_id: 'tt2' }

beforeAll(() => {
  db.setSetting('riven_url', 'http://riven.test:8082/')
  db.setSetting('riven_api_key', 'rkey')
  db.setSetting('riven_enabled', '1')
})

describe('rivenClient.getItemByTmdb', () => {
  it('looks the title up by TMDB id with the API key header', async () => {
    const calls = mockFetch([['GET /items/9820', MOVIE]])
    const item = await riven.getItemByTmdb(9820, 'movie')
    expect(item.id).toBe('movie_tmdb9820')
    expect(calls[0].url).toBe('http://riven.test:8082/api/v1/items/9820?use_tmdb_id=true')
    expect(calls[0].headers['X-API-KEY']).toBe('rkey')
  })

  it('returns null when Riven does not know the title', async () => {
    mockFetch([])
    expect(await riven.getItemByTmdb(1, 'movie')).toBeNull()
  })

  it('returns null when the TMDB id resolves to the other media type', async () => {
    mockFetch([['GET /items/9820', MOVIE]])
    expect(await riven.getItemByTmdb(9820, 'tv')).toBeNull()
  })

  it('surfaces other Riven errors with their status', async () => {
    mockFetch([['GET /items/9820', { __status: 503, detail: 'boom' }]])
    await expect(riven.getItemByTmdb(9820, 'movie')).rejects.toMatchObject({ status: 503, message: 'Riven API 503: boom' })
  })

  describe('when a movie and a show share the TMDB id (Doctor Who / The Two Towers)', () => {
    // Riven's use_tmdb_id lookup 500s with "Multiple rows"; the client must fall
    // back to the IMDb id (from the TMDB cache) and search by that.
    const MULTI = { __status: 500, detail: 'Multiple rows were found when one or none was required' }
    const WHO = { id: 'show_tvdb76107', title: 'Doctor Who', type: 'Show', tmdb_id: '121', imdb_id: 'tt0056751', seasons: [] }
    const TOWERS = { id: 'movie_plex_214524', title: 'The Two Towers', type: 'Movie', tmdb_id: '121', imdb_id: 'tt0167261' }
    const realDetails = tmdb.getItemDetails
    afterEach(() => { tmdb.getItemDetails = realDetails })

    it('finds the show via its IMDb id and fetches the tree by Riven id', async () => {
      const asked = []
      tmdb.getItemDetails = async (id, type) => { asked.push([id, type]); return { imdbId: 'tt0056751' } }
      const calls = mockFetch([
        ['GET /items/121?use_tmdb_id=true', MULTI],
        ['GET /items?search=tt0056751&type=show', { success: true, items: [WHO] }],
        ['GET /items/show_tvdb76107', { ...WHO, seasons: [{ id: 'season_tvdb76107_s1', season_number: 1, episodes: [] }] }],
      ])
      const item = await riven.getItemByTmdb(121, 'tv')
      expect(asked).toEqual([[121, 'tv']])
      expect(item.id).toBe('show_tvdb76107')
      expect(item.seasons).toHaveLength(1)
      expect(calls.map(c => c.url.replace('http://riven.test:8082/api/v1', ''))).toEqual([
        '/items/121?use_tmdb_id=true',
        '/items?search=tt0056751&type=show&limit=10',
        '/items/show_tvdb76107',
      ])
    })

    it('finds the movie side the same way', async () => {
      tmdb.getItemDetails = async () => ({ imdbId: 'tt0167261' })
      mockFetch([
        ['GET /items/121?use_tmdb_id=true', MULTI],
        ['GET /items?search=tt0167261&type=movie', { success: true, items: [TOWERS] }],
        ['GET /items/movie_plex_214524', TOWERS],
      ])
      const item = await riven.getItemByTmdb(121, 'movie')
      expect(item.id).toBe('movie_plex_214524')
    })

    it('returns null when the IMDb search comes back empty', async () => {
      tmdb.getItemDetails = async () => ({ imdbId: 'tt0167261' })
      mockFetch([
        ['GET /items/121?use_tmdb_id=true', MULTI],
        ['GET /items?search=tt0167261', { success: true, items: [] }],
      ])
      expect(await riven.getItemByTmdb(121, 'movie')).toBeNull()
    })

    it('explains itself when no IMDb id can be resolved', async () => {
      tmdb.getItemDetails = async () => ({ imdbId: null })
      mockFetch([['GET /items/121?use_tmdb_id=true', MULTI]])
      await expect(riven.getItemByTmdb(121, 'movie')).rejects.toThrow(/Could not resolve an IMDb id/)
    })
  })
})

describe('rivenClient.summarizeItem', () => {
  it('sorts seasons and episodes and normalises states/dates', () => {
    const s = riven.summarizeItem(SHOW)
    expect(s).toMatchObject({ id: 'show_tvdb1', type: 'show', state: 'Completed', imdbId: 'tt1' })
    expect(s.seasons.map(x => x.number)).toEqual([1, 2])
    expect(s.seasons[0].episodes.map(x => x.number)).toEqual([1, 2])
    expect(s.seasons[0].episodes[1]).toEqual({ id: 'episode_tvdb12', number: 2, title: 'One-Two', state: 'Failed', airedAt: null })
    expect(s.seasons[1].episodes[0].airedAt).toBe('2024-01-01 00:00:00')
  })
})

describe('rivenClient.resolveTargets', () => {
  const tree = riven.summarizeItem(SHOW)

  it('targets the whole show when nothing is selected', () => {
    expect(riven.resolveTargets(tree, {})).toEqual([{ id: 'show_tvdb1', label: 'Entire show' }])
  })

  it('always targets the whole movie', () => {
    const movie = riven.summarizeItem(MOVIE)
    expect(riven.resolveTargets(movie, { seasons: [1], episodes: [{ season: 1, episode: 1 }] })).toEqual([{ id: 'movie_tmdb9820', label: 'Some Movie' }])
  })

  it('maps seasons and episodes, letting a selected season absorb its episodes', () => {
    const targets = riven.resolveTargets(tree, { seasons: [2, 2], episodes: [{ season: 2, episode: 1 }, { season: 1, episode: 2 }, { season: 1, episode: 2 }] })
    expect(targets).toEqual([
      { id: 'season_tvdb1_s2', label: 'Season 2' },
      { id: 'episode_tvdb12', label: 'S1E2' },
    ])
  })

  it('rejects seasons and episodes Riven does not have', () => {
    expect(() => riven.resolveTargets(tree, { seasons: [7] })).toThrow(/Season 7 is not in Riven/)
    expect(() => riven.resolveTargets(tree, { episodes: [{ season: 1, episode: 9 }] })).toThrow(/S1E9 is not in Riven/)
    try { riven.resolveTargets(tree, { seasons: [7] }) } catch (e) { expect(e.status).toBe(404) }
  })
})

describe('rivenClient.resetByTmdb', () => {
  it('resets then retries the resolved ids', async () => {
    const calls = mockFetch([
      ['GET /items/77791', SHOW],
      ['POST /items/reset', { message: 'ok', ids: [] }],
      ['POST /items/retry', { message: 'ok', ids: [] }],
    ])
    const out = await riven.resetByTmdb({ tmdbId: 77791, mediaType: 'tv', seasons: [1], episodes: [{ season: 2, episode: 1 }] })
    expect(out.item).toEqual({ id: 'show_tvdb1', title: 'Some Show' })
    expect(out.targets.map(t => t.id)).toEqual(['season_tvdb1_s1', 'episode_tvdb21'])
    const posts = calls.filter(c => c.method === 'POST').map(c => decodeURIComponent(c.url))
    expect(posts).toEqual([
      'http://riven.test:8082/api/v1/items/reset?ids=season_tvdb1_s1,episode_tvdb21',
      'http://riven.test:8082/api/v1/items/retry?ids=season_tvdb1_s1,episode_tvdb21',
    ])
  })

  it('fails with 404 when the title is not in Riven and never posts', async () => {
    const calls = mockFetch([])
    await expect(riven.resetByTmdb({ tmdbId: 5, mediaType: 'movie' })).rejects.toMatchObject({ status: 404 })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })

  it('does not retry when the reset itself failed', async () => {
    const calls = mockFetch([
      ['GET /items/9820', MOVIE],
      ['POST /items/reset', { __status: 500, detail: 'db locked' }],
    ])
    await expect(riven.resetByTmdb({ tmdbId: 9820, mediaType: 'movie' })).rejects.toMatchObject({ status: 500 })
    expect(calls.some(c => c.url.includes('/items/retry'))).toBe(false)
  })

  it('refuses to run without an API key', async () => {
    db.setSetting('riven_api_key', '')
    mockFetch([['GET /items/9820', MOVIE]])
    await expect(riven.resetByTmdb({ tmdbId: 9820, mediaType: 'movie' })).rejects.toThrow(/API key not configured/)
    db.setSetting('riven_api_key', 'rkey')
  })
})
