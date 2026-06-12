import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

// Load through Node's CommonJS loader so every module shares the same db
// instance (Vitest's ESM import would create a second transformed copy).
const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const automation = nodeRequire('../server/db/automation.js')
const listSources = nodeRequire('../server/services/listSources/index.js')
const evaluator = nodeRequire('../server/services/deletion/evaluator.js')
const executor = nodeRequire('../server/services/deletion/executor.js')
const deletionService = nodeRequire('../server/services/deletion/index.js')
const tmdbService = nodeRequire('../server/services/tmdb.js')

const NOW = Math.floor(Date.now() / 1000)

function makeItem(overrides = {}) {
  return {
    ratingKey: 'rk1', sectionId: '1', type: 'movie', title: 'Test Movie', year: 2015,
    genres: [], cast: [], directors: [], writers: [], producers: [], countries: [],
    collections: [], labels: [], audienceRating: 0, rating: 0, contentRating: '',
    studio: '', edition: '', duration: 0, videoResolution: null, fileSize: null,
    addedAt: NOW - 100 * 86400, thumb: null, tmdbId: '550',
    summary: '', ratingImage: '', audienceRatingImage: '', leafCount: null, releaseDate: '',
    ...overrides,
  }
}

const baseCtx = { now: NOW, viewStats: {}, watchlistedKeys: new Set(), watchHistoryAvailable: true }

// ── List URL parsing ──────────────────────────────────────────────────────────

describe('parseListUrl', () => {
  it.each([
    ['https://trakt.tv/users/foo/lists/my-list', 'trakt'],
    ['https://trakt.tv/movies/trending', 'trakt'],
    ['https://mdblist.com/lists/user/some-list', 'mdblist'],
    ['https://www.themoviedb.org/list/12345', 'tmdb'],
    ['https://www.imdb.com/chart/top/', 'imdb'],
    ['https://www.imdb.com/list/ls012345678/', 'imdb'],
    ['https://letterboxd.com/user/list/some-list/', 'letterboxd'],
    ['https://anilist.co/user/SomeUser/animelist', 'anilist'],
  ])('parses %s as %s', (url, sourceType) => {
    expect(listSources.parseListUrl(url).sourceType).toBe(sourceType)
  })

  it('rejects unsupported and malformed URLs', () => {
    expect(() => listSources.parseListUrl('https://example.com/list/1')).toThrow(/Unsupported/)
    expect(() => listSources.parseListUrl('not a url')).toThrow(/valid URL/)
    expect(() => listSources.parseListUrl('https://letterboxd.com/film/parasite-2019/')).toThrow(/Unsupported/)
  })
})

// ── Criteria-based lists ──────────────────────────────────────────────────────

describe('criteria list source', () => {
  const criteriaSource = nodeRequire('../server/services/listSources/criteria.js')

  afterEach(() => vi.restoreAllMocks())

  function mockTmdb(routes) {
    return vi.spyOn(tmdbService, 'tmdbFetchPublic').mockImplementation(async (p) => {
      for (const [prefix, payload] of Object.entries(routes)) {
        if (p.startsWith(prefix)) return typeof payload === 'function' ? payload(p) : payload
      }
      return null
    })
  }

  it('builds discover params for genre and runs both media types', async () => {
    const spy = mockTmdb({
      '/discover/movie': { results: [{ id: 1, title: 'Scary Movie', release_date: '2020-01-01', popularity: 9 }], total_pages: 1 },
      '/discover/tv': { results: [{ id: 2, name: 'Scary Show', first_air_date: '2021-01-01', popularity: 5 }], total_pages: 1 },
    })
    const items = await criteriaSource.fetchEntries({
      mediaType: 'all', matchMode: 'ALL',
      criteria: [{ type: 'genre', entityName: 'comedy' }],
    }, { limit: 10 })
    expect(items.map(i => i.title).sort()).toEqual(['Scary Movie', 'Scary Show'])
    expect(spy.mock.calls.some(([p]) => p.startsWith('/discover/movie') && p.includes('with_genres=35'))).toBe(true)
    expect(spy.mock.calls.some(([p]) => p.startsWith('/discover/tv') && p.includes('with_genres=35'))).toBe(true)
  })

  it('intersects discover results with person credits in ALL mode', async () => {
    mockTmdb({
      '/search/person': { results: [{ id: 99 }] },
      '/person/99/combined_credits': {
        cast: [],
        crew: [
          { media_type: 'movie', id: 1, title: 'Match', release_date: '2018-01-01', job: 'Director', popularity: 8 },
          { media_type: 'movie', id: 3, title: 'Other Genre', release_date: '2019-01-01', job: 'Director', popularity: 7 },
        ],
      },
      '/discover/movie': { results: [
        { id: 1, title: 'Match', release_date: '2018-01-01', popularity: 8 },
        { id: 2, title: 'Different Director', release_date: '2020-01-01', popularity: 6 },
      ], total_pages: 1 },
    })
    const items = await criteriaSource.fetchEntries({
      mediaType: 'movie', matchMode: 'ALL',
      criteria: [{ type: 'genre', entityName: 'Horror' }, { type: 'director', entityName: 'Someone' }],
    }, { limit: 10 })
    expect(items.map(i => i.title)).toEqual(['Match'])
  })

  it('network criteria are TV-only: movies yield nothing in ALL mode', async () => {
    mockTmdb({
      '/discover/tv': { results: [{ id: 5, name: 'Netflix Show', first_air_date: '2022-01-01', popularity: 3 }], total_pages: 1 },
    })
    const all = await criteriaSource.fetchEntries({
      mediaType: 'all', matchMode: 'ALL',
      criteria: [{ type: 'network', entityName: 'Netflix' }],
    }, { limit: 10 })
    expect(all.map(i => i.mediaType)).toEqual(['tv'])
  })

  it('ANY mode unions criteria results without duplicates', async () => {
    mockTmdb({
      '/search/collection': { results: [{ id: 7 }] },
      '/collection/7': { parts: [
        { id: 1, title: 'Shared', release_date: '2001-01-01', popularity: 10 },
        { id: 4, title: 'Collection Only', release_date: '2002-01-01', popularity: 2 },
      ] },
      '/discover/movie': { results: [{ id: 1, title: 'Shared', release_date: '2001-01-01', popularity: 10 }], total_pages: 1 },
    })
    const items = await criteriaSource.fetchEntries({
      mediaType: 'movie', matchMode: 'ANY',
      criteria: [{ type: 'genre', entityName: 'Horror' }, { type: 'collection', entityName: 'Some Saga' }],
    }, { limit: 10 })
    expect(items.map(i => i.title).sort()).toEqual(['Collection Only', 'Shared'])
  })

  it('throws clear errors for unknown entities and types', async () => {
    mockTmdb({ '/search/person': { results: [] } })
    await expect(criteriaSource.fetchEntries({
      mediaType: 'movie', matchMode: 'ALL',
      criteria: [{ type: 'cast', entityName: 'Nobody At All' }],
    }, { limit: 5 })).rejects.toThrow(/person not found/)
    await expect(criteriaSource.fetchEntries({
      mediaType: 'movie', matchMode: 'ALL',
      criteria: [{ type: 'bogus', entityName: 'x' }],
    }, { limit: 5 })).rejects.toThrow(/unsupported criterion type/)
  })
})

// ── Evaluator ─────────────────────────────────────────────────────────────────

describe('deletion evaluator', () => {
  it('matches nothing with empty criteria (empty profile must never mean delete-all)', () => {
    const { matches } = evaluator.evaluateProfile(
      { mediaType: 'movie', criteria: [], exclusions: {} }, [makeItem()], baseCtx)
    expect(matches).toHaveLength(0)
  })

  it('requires ALL criteria to match', () => {
    const items = [makeItem({ audienceRating: 4, videoResolution: '4k' })]
    const both = evaluator.evaluateProfile({
      mediaType: 'movie',
      criteria: [
        { field: 'audience_rating', op: 'lt', value: 5 },
        { field: 'video_resolution', op: 'eq', value: '4k' },
      ],
      exclusions: {},
    }, items, baseCtx)
    expect(both.matches).toHaveLength(1)
    const one = evaluator.evaluateProfile({
      mediaType: 'movie',
      criteria: [
        { field: 'audience_rating', op: 'lt', value: 3 },
        { field: 'video_resolution', op: 'eq', value: '4k' },
      ],
      exclusions: {},
    }, items, baseCtx)
    expect(one.matches).toHaveLength(0)
  })

  it('never matches unrated items on rating thresholds', () => {
    const { matches } = evaluator.evaluateProfile(
      { mediaType: 'movie', criteria: [{ field: 'audience_rating', op: 'lt', value: 9 }], exclusions: {} },
      [makeItem({ audienceRating: 0 })], baseCtx)
    expect(matches).toHaveLength(0)
  })

  it('treats never-played as matching "not played in X days"', () => {
    const items = [
      makeItem({ ratingKey: 'never' }),
      makeItem({ ratingKey: 'recent' }),
      makeItem({ ratingKey: 'old-play' }),
    ]
    const ctx = {
      ...baseCtx,
      viewStats: {
        recent: { lastPlayedAt: NOW - 2 * 86400, plays: 1 },
        'old-play': { lastPlayedAt: NOW - 400 * 86400, plays: 2 },
      },
    }
    const { matches } = evaluator.evaluateProfile(
      { mediaType: 'movie', criteria: [{ field: 'last_played_days_ago', op: 'gt', value: 90 }], exclusions: {} },
      items, ctx)
    expect(matches.map(m => m.item.ratingKey).sort()).toEqual(['never', 'old-play'])
  })

  it('honors watchlist, collection, and min-age exclusions', () => {
    const items = [
      makeItem({ ratingKey: 'wl' }),
      makeItem({ ratingKey: 'col', collections: ['Keep Forever'] }),
      makeItem({ ratingKey: 'fresh', addedAt: NOW - 2 * 86400 }),
      makeItem({ ratingKey: 'ok' }),
    ]
    const ctx = { ...baseCtx, watchlistedKeys: new Set(['wl']) }
    const { matches, excluded } = evaluator.evaluateProfile({
      mediaType: 'movie',
      criteria: [{ field: 'year', op: 'eq', value: 2015 }],
      exclusions: { watchlisted: true, collections: ['keep forever'], minAgeDays: 30 },
    }, items, ctx)
    expect(matches.map(m => m.item.ratingKey)).toEqual(['ok'])
    expect(excluded).toBe(3)
  })

  it('filters by media type and matches people/list fields case-insensitively', () => {
    const items = [
      makeItem({ ratingKey: 'm', type: 'movie', cast: ['Nicolas Cage'] }),
      makeItem({ ratingKey: 's', type: 'show', cast: ['Nicolas Cage'] }),
    ]
    const { matches } = evaluator.evaluateProfile(
      { mediaType: 'movie', criteria: [{ field: 'actor', op: 'contains', value: ['nicolas cage'] }], exclusions: {} },
      items, baseCtx)
    expect(matches.map(m => m.item.ratingKey)).toEqual(['m'])
  })

  it('flags profiles that need watch data', () => {
    expect(evaluator.usesWatchData({ criteria: [{ field: 'never_played', op: 'eq', value: true }] })).toBe(true)
    expect(evaluator.usesWatchData({ criteria: [{ field: 'year', op: 'lt', value: 2000 }] })).toBe(false)
  })
})

// ── Candidate lifecycle ───────────────────────────────────────────────────────

describe('deletion candidates', () => {
  let profileId
  beforeEach(() => {
    profileId = automation.createDeletionProfile({ name: `p-${Math.random()}`, criteria: [{ field: 'year', op: 'lt', value: 2000 }] })
  })

  it('preserves terminal status on re-match and keeps history through pruning', () => {
    automation.upsertCandidate({ profileId, ratingKey: 'a', title: 'A', mediaType: 'movie', status: 'matched' })
    const candidate = automation.getCandidates({ profileId })[0]
    automation.setCandidateStatus(candidate.id, 'deleted', { deleteMethod: 'radarr' })
    // A later run still matching the (now deleted) key must not resurrect it
    automation.upsertCandidate({ profileId, ratingKey: 'a', title: 'A', mediaType: 'movie', status: 'matched' })
    expect(automation.getCandidateById(candidate.id).status).toBe('deleted')
    // Pruning open candidates never removes history rows
    automation.upsertCandidate({ profileId, ratingKey: 'b', title: 'B', mediaType: 'movie', status: 'matched' })
    const pruned = automation.pruneStaleCandidates(profileId, [])
    expect(pruned).toBe(1)
    expect(automation.getCandidateById(candidate.id).status).toBe('deleted')
  })

  it('anchors the grace period at first match', () => {
    automation.upsertCandidate({ profileId, ratingKey: 'g', title: 'G', mediaType: 'movie', status: 'matched' })
    const first = automation.getCandidates({ profileId })[0].firstMatchedAt
    automation.upsertCandidate({ profileId, ratingKey: 'g', title: 'G', mediaType: 'movie', status: 'matched' })
    expect(automation.getCandidates({ profileId })[0].firstMatchedAt).toBe(first)
  })
})

// ── Executor tier selection ───────────────────────────────────────────────────

describe('deletion executor', () => {
  const realFetch = global.fetch
  let calls

  beforeEach(() => {
    calls = []
    db.setSetting('radarr_enabled', '1')
    db.setSetting('radarr_url', 'http://radarr.test')
    db.setSetting('radarr_api_key', 'rk')
    db.setSetting('sonarr_enabled', '0')
    db.setSetting('riven_enabled', '0')
    db.setSetting('plex_url', 'http://plex.test')
    db.setSetting('plex_token', 'pt')
  })

  afterEach(() => {
    global.fetch = realFetch
    vi.restoreAllMocks()
  })

  function mockFetch(handler) {
    global.fetch = vi.fn(async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' })
      const result = handler(String(url), opts.method || 'GET')
      if (result === undefined) return { ok: true, status: 200, text: async () => '[]', json: async () => [] }
      return result
    })
  }

  it('deletes via Radarr when the movie is managed there', async () => {
    mockFetch((url) => {
      if (url.includes('/api/v3/movie?tmdbId=550')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 42 }]) }
      }
      return undefined
    })
    const item = makeItem({ ratingKey: 'rad1' })
    db.upsertManyItems([{ ...item, sectionId: '1' }])
    const { method } = await executor.deleteItem(item, { arrImportExclusion: true })
    expect(method).toBe('radarr')
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/api/v3/movie/42') && c.url.includes('addImportExclusion=true'))).toBe(true)
    // Never touched Plex's delete endpoint
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/library/metadata'))).toBe(false)
    // Cached library row is gone
    expect(db.getLibraryItemByKey('rad1')).toBeNull()
  })

  it('falls back to Plex when Radarr does not manage the movie', async () => {
    mockFetch((url) => {
      if (url.includes('/api/v3/movie?tmdbId=550')) {
        return { ok: true, status: 200, text: async () => '[]' }
      }
      return undefined
    })
    const { method } = await executor.deleteItem(makeItem({ ratingKey: 'plex1' }), { arrImportExclusion: true })
    expect(method).toBe('plex')
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/library/metadata/plex1'))).toBe(true)
  })

  it('surfaces an actionable error when Plex blocks deletion', async () => {
    db.setSetting('radarr_enabled', '0')
    mockFetch((url, method) => {
      if (method === 'DELETE' && url.includes('/library/metadata')) {
        return { ok: false, status: 403, text: async () => '' }
      }
      return undefined
    })
    await expect(executor.deleteItem(makeItem(), { arrImportExclusion: false }))
      .rejects.toThrow(/Allow media deletion/)
  })

  it('cleans up Riven and old requests after deletion', async () => {
    db.setSetting('radarr_enabled', '0')
    db.setSetting('riven_enabled', '1')
    db.setSetting('riven_api_key', 'riven-key')
    db.setSetting('riven_url', 'http://riven.test')
    vi.spyOn(tmdbService, 'tmdbFetchPublic').mockResolvedValue({ imdb_id: 'tt0137523' })

    // Seed an approved request + a list item that both reference the title
    db.addDiscoverRequestWithStatus('autorequest', 550, 'movie', 'Test Movie', 'riven', 1, 'approved', null, null)
    const listId = automation.createListSource({ name: 'l1', sourceType: 'imdb', url: 'https://www.imdb.com/chart/top/' })
    automation.upsertListItem({ listId, tmdbId: 550, mediaType: 'movie', title: 'Test Movie', status: 'requested' })

    mockFetch((url) => {
      if (url.includes('/items/imdb/tt0137523')) {
        return { ok: true, status: 200, text: async () => '', json: async () => ({ items: [{ id: 'movie_99' }] }) }
      }
      return undefined
    })

    await executor.deleteItem(makeItem({ ratingKey: 'riv1' }), { arrImportExclusion: false })
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/items/remove?ids=movie_99'))).toBe(true)
    // Old request rows removed → DUMB pull mode can't re-request it
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM discover_requests WHERE tmdb_id = 550').get()
    expect(remaining.c).toBe(0)
    // List item flagged so list sync skips it forever
    expect(automation.getListItems(listId)[0].status).toBe('deleted')
  })
})

// ── runProfiles safety ────────────────────────────────────────────────────────

describe('deletion runProfiles', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  it('no-ops when no profiles exist', async () => {
    db.prepare('DELETE FROM deletion_profiles').run()
    const result = await deletionService.runProfiles()
    expect(result.skipped).toBe(true)
  })

  it('dry-run records matches without any network calls', async () => {
    db.prepare('DELETE FROM deletion_profiles').run()
    db.prepare('DELETE FROM library_items').run()
    db.upsertManyItems([makeItem({ ratingKey: 'dry1', year: 1990, sectionId: '1' })])
    const profileId = automation.createDeletionProfile({
      name: 'dry', mode: 'dry_run', criteria: [{ field: 'year', op: 'lt', value: 2000 }],
    })
    global.fetch = vi.fn(() => { throw new Error('dry run must not call the network') })
    await deletionService.runProfiles()
    const candidates = automation.getCandidates({ profileId })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].status).toBe('matched')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('skips watch-data profiles when no watch history has synced', async () => {
    db.prepare('DELETE FROM deletion_profiles').run()
    db.prepare('DELETE FROM watch_history').run()
    db.upsertManyItems([makeItem({ ratingKey: 'wh1', sectionId: '1' })])
    const profileId = automation.createDeletionProfile({
      name: 'watch-guard', mode: 'dry_run',
      criteria: [{ field: 'never_played', op: 'eq', value: true }],
    })
    const result = await deletionService.runProfiles()
    expect(result[profileId].error).toMatch(/watch history/)
    expect(automation.getCandidates({ profileId })).toHaveLength(0)
  })
})
