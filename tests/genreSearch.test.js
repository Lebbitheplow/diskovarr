import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createRequestHarness } from './helpers/requestApp.js'

// Genre browsing (/api/search?genre=X) reads the tmdb_cache_genres index
// instead of parsing every cached title, and pages the pool like text search
// does, reporting per-type totals for the Movies/TV tabs.
const h = createRequestHarness()
const { db } = h

const title = (tmdbId, mediaType, genres, originalLanguage = 'en', popularity = tmdbId) => ({
  tmdbId, mediaType, title: `${mediaType} ${tmdbId}`, year: 2020, genres, originalLanguage, popularity, voteAverage: 7, posterUrl: null,
})

// 48 Animation movies (45 en + 3 ja), 5 Animation shows, 2 Horror movies
function seedCache() {
  db.prepare('DELETE FROM tmdb_cache').run()
  db.prepare('DELETE FROM tmdb_cache_genres').run()
  for (let id = 1; id <= 45; id++) db.setTmdbCache(id, 'movie', title(id, 'movie', ['Animation', 'Comedy']))
  for (let id = 46; id <= 48; id++) db.setTmdbCache(id, 'movie', title(id, 'movie', ['Animation'], 'ja'))
  for (let id = 1; id <= 5; id++) db.setTmdbCache(id, 'tv', title(id, 'tv', ['Animation', 'Kids']))
  for (let id = 60; id <= 61; id++) db.setTmdbCache(id, 'movie', title(id, 'movie', ['Horror']))
}

const indexRows = () => db.prepare('SELECT tmdb_id, media_type, genre, original_language FROM tmdb_cache_genres ORDER BY media_type, tmdb_id, genre').all()
const ids = (items) => items.map(i => `${i.tmdbId}:${i.mediaType}`)

beforeAll(async () => { await h.start() })
afterAll(() => h.stop())
beforeEach(() => {
  h.reset()
  seedCache()
  // The route must never need TMDB for a genre that is in the cache
  vi.spyOn(h.tmdb, 'discoverByGenreName').mockRejectedValue(new Error('unexpected TMDB call'))
  vi.spyOn(h.tmdb, 'batchGetDetails').mockRejectedValue(new Error('unexpected TMDB call'))
})
afterEach(() => vi.restoreAllMocks())

describe('tmdb_cache_genres index', () => {
  it('is written with the cache row, one row per genre, carrying the language', () => {
    expect(indexRows().filter(r => r.tmdb_id === 1 && r.media_type === 'movie')).toEqual([
      { tmdb_id: 1, media_type: 'movie', genre: 'Animation', original_language: 'en' },
      { tmdb_id: 1, media_type: 'movie', genre: 'Comedy', original_language: 'en' },
    ])
    expect(indexRows().filter(r => r.genre === 'Horror')).toHaveLength(2)
  })

  it('looks titles up by genre and type, most popular first, optionally by language', () => {
    const movies = db.getItemsByGenre('movie', 'Animation')
    expect(movies).toHaveLength(48)
    expect(movies[0].tmdbId).toBe(48)
    expect(db.getItemsByGenre('tv', 'Animation')).toHaveLength(5)
    expect(ids(db.getItemsByGenre('movie', 'Animation', { originalLanguage: 'ja' }))).toEqual(['48:movie', '47:movie', '46:movie'])
    expect(db.getItemsByGenre('movie', 'Animation', { originalLanguage: 'fr' })).toEqual([])
    expect(db.getItemsByGenre('movie', 'Western')).toEqual([])
  })

  it('follows a title whose genres change, and goes with a deleted title', () => {
    db.setTmdbCache(1, 'movie', title(1, 'movie', ['Horror']))
    expect(indexRows().filter(r => r.tmdb_id === 1 && r.media_type === 'movie').map(r => r.genre)).toEqual(['Horror'])
    expect(db.getItemsByGenre('movie', 'Animation')).toHaveLength(47)

    db.deleteTmdbCache(2, 'movie')
    expect(indexRows().filter(r => r.tmdb_id === 2 && r.media_type === 'movie')).toEqual([])
    expect(db.getItemsByGenre('movie', 'Animation')).toHaveLength(46)
  })

  it('tolerates cache rows that are not objects with a genres array', () => {
    db.setTmdbCache(900, 'movie', JSON.stringify({ title: 'stringified', genres: ['Animation'] }))
    db.setTmdbCache(901, 'movie', { title: 'no genres' })
    db.setTmdbCache(902, 'movie', { title: 'odd genres', genres: 'Animation' })
    expect(indexRows().filter(r => r.tmdb_id >= 900)).toEqual([])
    expect(db.getTmdbCache(901, 'movie')).toEqual({ title: 'no genres' })
  })
})

describe('GET /api/search?genre=', () => {
  const get = (route, user = 'alice') => h.call('GET', route, { user })

  it('pages the pool and reports per-type totals', async () => {
    const p1 = await get('/api/search?genre=Animation')
    expect(p1.status).toBe(200)
    expect(p1.data.results).toHaveLength(40)
    expect(p1.data).toMatchObject({ total: 53, pages: 2, page: 1, counts: { all: 53, movie: 48, tv: 5 } })
    // Most popular first across both types
    expect(p1.data.results[0]).toMatchObject({ tmdbId: 48, mediaType: 'movie' })

    const p2 = await get('/api/search?genre=Animation&page=2')
    expect(p2.data.results).toHaveLength(13)
    expect(new Set([...ids(p1.data.results), ...ids(p2.data.results)]).size).toBe(53)
  })

  it('narrows a page to one media type while the totals stay per type', async () => {
    const tv = await get('/api/search?genre=Animation&type=tv')
    expect(ids(tv.data.results)).toEqual(['5:tv', '4:tv', '3:tv', '2:tv', '1:tv'])
    expect(tv.data).toMatchObject({ total: 5, pages: 1, counts: { all: 53, movie: 48, tv: 5 } })

    const movies = await get('/api/search?genre=Animation&type=movie')
    expect(movies.data.results).toHaveLength(40)
    expect(movies.data.results.every(r => r.mediaType === 'movie')).toBe(true)
    expect(movies.data).toMatchObject({ total: 48, pages: 2 })
  })

  it('counts what the filters leave, not the whole pool', async () => {
    const res = await get('/api/search?genre=Animation&filterGenres=Kids')
    expect(res.data).toMatchObject({ total: 5, counts: { all: 5, movie: 0, tv: 5 } })
    expect(res.data.availableGenres).toEqual(['Animation', 'Comedy', 'Kids'])
  })

  it("applies the user's language preference in the lookup", async () => {
    db.setUserPreferences('bob', { language: 'ja' })
    const res = await get('/api/search?genre=Animation', 'bob')
    expect(ids(res.data.results)).toEqual(['48:movie', '47:movie', '46:movie'])
    expect(res.data.counts).toEqual({ all: 3, movie: 3, tv: 0 })
  })

  it('answers an unknown genre with an empty page, no TMDB call', async () => {
    vi.spyOn(h.tmdb, 'discoverByGenreName').mockResolvedValue([])
    vi.spyOn(h.tmdb, 'batchGetDetails').mockResolvedValue([])
    const res = await get('/api/search?genre=Western')
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ results: [], total: 0, counts: { all: 0, movie: 0, tv: 0 } })
    // Both media types are seeded from TMDB when nothing is cached
    expect(h.tmdb.discoverByGenreName.mock.calls.map(c => c[1]).sort()).toEqual(['movie', 'tv'])
  })
})
