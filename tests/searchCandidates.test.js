import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const sc = nodeRequire('../server/services/searchCandidates.js')

const movie = (id, extra = {}) => ({
  id, media_type: 'movie', title: `Movie ${id}`, release_date: '2019-05-01', overview: 'o',
  poster_path: '/p.jpg', backdrop_path: '/b.jpg', genre_ids: [28, 878], vote_average: 7.2, vote_count: 10,
  popularity: 50, original_language: 'en', ...extra,
})
const show = (id, extra = {}) => ({
  id, media_type: 'tv', name: `Show ${id}`, first_air_date: '2021-01-01', genre_ids: [10759, 18], popularity: 5, ...extra,
})

describe('fromMultiResult', () => {
  it('maps a movie result to the details shape with named genres', () => {
    const item = sc.fromMultiResult(movie(1))
    expect(item).toMatchObject({
      tmdbId: 1, mediaType: 'movie', title: 'Movie 1', year: 2019, releaseDate: '2019-05-01',
      posterUrl: 'https://image.tmdb.org/t/p/w342/p.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w780/b.jpg',
      genres: ['Action', 'Science Fiction'], genreIds: [28, 878], voteAverage: 7.2, popularity: 50,
      contentRating: null, enriched: false,
    })
  })

  it('uses TV naming and TV genre names', () => {
    const item = sc.fromMultiResult(show(2))
    expect(item).toMatchObject({ mediaType: 'tv', title: 'Show 2', year: 2021, genres: ['Action & Adventure', 'Drama'] })
  })

  it('tolerates missing dates and unknown genre ids', () => {
    const item = sc.fromMultiResult(show(3, { first_air_date: undefined, genre_ids: [99999] }))
    expect(item.year).toBe(0)
    expect(item.releaseDate).toBeNull()
    expect(item.genres).toEqual([])
  })
})

describe('buildPool', () => {
  it('prefers cached details, builds placeholders otherwise, and skips people/duplicates', () => {
    const cached = { tmdbId: 1, mediaType: 'movie', title: 'Cached One', contentRating: 'PG-13' }
    const getCached = (id, type) => (id === 1 && type === 'movie' ? cached : null)
    const { pool, pending } = sc.buildPool(
      [movie(1), show(2), { id: 9, media_type: 'person' }, show(2)],
      getCached
    )
    expect(pool).toHaveLength(2)
    expect(pool[0]).toBe(cached)
    expect(pool[1]).toMatchObject({ tmdbId: 2, enriched: false })
    expect(pending).toEqual([pool[1]])
  })
})

describe('enrichPending', () => {
  it('upgrades placeholders in place, leaves failures for a retry, and reports the count', async () => {
    const { pool, pending } = sc.buildPool([movie(1), show(2), movie(3)], () => null)
    const getDetails = async (id, type) => {
      if (id === 2) throw new Error('tmdb 502')
      return { tmdbId: id, mediaType: type, contentRating: 'R', directors: ['Someone'], title: `Full ${id}` }
    }
    const upgraded = await sc.enrichPending(pending, getDetails, 2)
    expect(upgraded).toBe(2)
    expect(pool[0]).toMatchObject({ title: 'Full 1', contentRating: 'R', directors: ['Someone'] })
    expect(pool[0].enriched).toBeUndefined()
    expect(pool[1]).toMatchObject({ enriched: false, title: 'Show 2' })
    expect(pool[2].enriched).toBeUndefined()
    // A second pass only retries what is still pending
    let calls = 0
    await sc.enrichPending(pending, async () => { calls++; return null }, 4)
    expect(calls).toBe(1)
  })

  it('handles an empty list', async () => {
    expect(await sc.enrichPending([], async () => ({}))).toBe(0)
  })
})

describe('mergeSonarrLookup', () => {
  it('appends TVDB-only hits and skips titles TMDB already returned', () => {
    const pool = [{ tmdbId: 1, mediaType: 'tv', title: 'The Office', year: 2005 }]
    const lookup = [
      { tvdbId: 73244, title: 'The Office', year: 2005 },
      { tvdbId: 1, title: 'Kitboga', year: 2019, seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }], images: [{ coverType: 'poster', remoteUrl: 'http://x/p.jpg' }], ratings: { value: 8 } },
      { title: 'No id' },
      { tvdbId: 1, title: 'Kitboga dup', year: 2019 },
    ]
    sc.mergeSonarrLookup(pool, lookup)
    expect(pool).toHaveLength(2)
    expect(pool[1]).toMatchObject({ tmdbId: null, tvdbId: 1, mediaType: 'tv', title: 'Kitboga', source: 'tvdb', seasons: [1], posterUrl: 'http://x/p.jpg', voteAverage: 8 })
  })

  it('is a no-op for empty or malformed lookups', () => {
    const pool = []
    expect(sc.mergeSonarrLookup(pool, null)).toBe(pool)
    expect(sc.mergeSonarrLookup(pool, [])).toHaveLength(0)
  })
})
