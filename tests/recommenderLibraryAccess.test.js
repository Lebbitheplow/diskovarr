import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Recommendations, Explore recommendations and /popular under per-user library
// access (services/libraryAccess): pools only hold titles the user may see, the
// taste profile still reads the whole library, and caches carry the access
// fingerprint. Fixture library: Plex sections 1 (movies), 2 and 10 (shows).
// alice shares 1+2, bob 1+2+10, kid sees 2 plus a content-filtered 1; the
// configured owner is unrestricted. TMDB, Tautulli and Plex calls are stubbed
// and any other outbound fetch fails.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-rec-access-'))
process.env.TUBERR_MANAGED = '0'
process.env.SESSION_SECRET ??= 'test-only-secret'
delete process.env.PLEX_SERVER_ID // no plex.tv access refresh

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const libraryAccess = nodeRequire('../server/services/libraryAccess/index.js')
const plex = nodeRequire('../server/services/plex.js')
const tautulli = nodeRequire('../server/services/tautulli.js')
const tmdb = nodeRequire('../server/services/tmdb.js')
const recommender = nodeRequire('../server/services/recommender.js')
const discoverRecommender = nodeRequire('../server/services/discoverRecommender.js')

const OWNER = '1', ALICE = '100', BOB = '200', KID = '300', GONE = '400', PANEL = '999'

function seedLibrary() {
  const ins = db.prepare(`INSERT INTO library_items (rating_key, section_id, title, year, type, tmdb_id, directors, audience_rating, source)
    VALUES (?, ?, ?, 2015, ?, ?, ?, 7, 'plex')`)
  for (const [rk, sec, title, type, tmdbId, director] of [
    ['101', '1', 'Movie A', 'movie', '11', 'Dir X'],
    ['102', '1', 'Movie B', 'movie', '12', 'Dir X'],
    ['103', '1', 'Movie C', 'movie', '13'],
    ['201', '2', 'Show A', 'show', '21'],
    ['202', '2', 'Show B', 'show', '22'],
    ['1001', '10', 'Tube A', 'show', '31'],
    ['1002', '10', 'Tube B', 'show', '32'],
  ]) ins.run(rk, sec, title, type, tmdbId, JSON.stringify(director ? [director] : []))
  for (const s of ['1', '2', '10']) db.setSyncTime(`library_${s}`)
}

function seedAccess() {
  libraryAccess.saveSnapshot(ALICE, 'plex', { role: 'shared', sectionIds: ['1', '2'] })
  libraryAccess.saveSnapshot(BOB, 'plex', { role: 'shared', sectionIds: ['1', '2', '10'] })
  libraryAccess.saveSnapshot(KID, 'plex', { role: 'shared', sectionIds: ['2'], filteredSectionIds: ['1'], visibleKeys: ['101'] })
  libraryAccess.invalidate()
}

// TMDB candidates: 11 is in section 1, 31 only in section 10, 500/600 nowhere
const tmdbItem = (tmdbId, mediaType, title) => ({
  tmdbId, mediaType, title, year: 2015, releaseDate: '2015-01-01', voteAverage: 7,
  genres: [], keywords: [], cast: [], directors: [], isAnime: false, adult: false,
})
const CANDIDATES = [
  tmdbItem(11, 'movie', 'Movie A'), tmdbItem(500, 'movie', 'Elsewhere'),
  tmdbItem(31, 'tv', 'Tube A'), tmdbItem(600, 'tv', 'Elsewhere Show'),
]
const DETAILS = new Map(CANDIDATES.map(c => [`${c.tmdbId}:${c.mediaType}`, c]))

// kid watched Movie B — in section 1 but outside kid's filter
const HISTORY = {
  [KID]: [{ rating_key: '102', grandparent_rating_key: null, watched_at: Math.floor(Date.now() / 1000), percent_complete: 100, media_type: 'movie' }],
}

const realFetch = globalThis.fetch
const outbound = []
let server, base

const keysOf = (items) => (items || []).map(i => String(i.ratingKey)).sort()
const tmdbKeysOf = (items) => (items || []).map(i => `${i.tmdbId}:${i.mediaType}`)
const recKeys = (data) => ({
  movies: keysOf(data.movies),
  shows: [...new Set([...keysOf(data.tvShows), ...keysOf(data.anime)])].sort(),
  topPicks: keysOf(data.topPicks),
})

async function call(route, { user, role, source } = {}) {
  const res = await realFetch(base + route, {
    headers: {
      ...(user ? { 'x-test-user': user } : {}), ...(role ? { 'x-test-role': role } : {}),
      ...(source ? { 'x-test-source': source } : {}),
    },
  })
  return { status: res.status, data: await res.json() }
}

// Explore pools build in the background; poll until they're served
async function explore(userId, access, check = (d) => expect(d.status).toBeUndefined()) {
  let data
  await vi.waitFor(async () => {
    data = await discoverRecommender.getDiscoverRecommendations(userId, null, { access })
    check(data)
  }, { timeout: 4000, interval: 20 })
  return data
}
const poolKeys = (data) => [...new Set([...tmdbKeysOf(data.topPicks), ...tmdbKeysOf(data.movies), ...tmdbKeysOf(data.tvShows)])]

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url) => {
    outbound.push(String(url))
    return new Response('offline', { status: 503 })
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(tautulli, 'getFullHistory').mockImplementation(async (userId) => HISTORY[userId] || [])
  vi.spyOn(tautulli, 'getPopularItems').mockResolvedValue({
    movies: [{ ratingKey: '101', totalPlays: 9 }, { ratingKey: '102', totalPlays: 8 }],
    tvShows: [{ ratingKey: '1001', totalPlays: 7 }, { ratingKey: '201', totalPlays: 6 }],
  })
  vi.spyOn(plex, 'getRelated').mockResolvedValue([])
  vi.spyOn(plex, 'getWatchedKeys').mockResolvedValue(new Set())
  vi.spyOn(tmdb, 'getItemDetails').mockImplementation(async (id, mt) => DETAILS.get(`${id}:${mt}`) || null)
  vi.spyOn(tmdb, 'getTrending').mockImplementation(async (mt, page) =>
    page === 1 ? CANDIDATES.filter(c => c.mediaType === mt).map(({ tmdbId, title, year }) => ({ tmdbId, title, year })) : [])
  for (const fn of ['getRecommendations', 'getSimilar', 'getUpcoming', 'discoverByGenreIds', 'discoverAnime',
    'getPersonCandidates', 'discoverByKeywordId']) vi.spyOn(tmdb, fn).mockResolvedValue([])

  db.setSetting('discover_enabled', '1')
  db.setSetting('tmdb_api_key', 'test-key')
  db.setOwnerUserId(OWNER)
  seedLibrary()
  // Explore's shared candidates come from the cache (default prefs → key '::0')
  db.setDiscoverCandidates('::0', CANDIDATES)
  for (const id of [OWNER, ALICE, BOB, KID, GONE]) db.upsertKnownUser(id, `user${id}`, null, `token-${id}`)

  const api = nodeRequire('../server/routes/api.js')
  const app = express()
  app.use((req, res, next) => {
    req.session = {}
    const user = req.get('x-test-user')
    if (user) req.session.plexUser = { id: user, username: user, provider: 'plex', token: null }
    if (req.get('x-test-role') === 'panel') req.session.isAdmin = true
    if (req.get('x-test-source')) req.session.activeSource = req.get('x-test-source')
    next()
  })
  app.use('/api', api)
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

beforeEach(() => {
  db.setSetting('library_access_enforced', '1')
  seedAccess()
  recommender.invalidateAllCaches()
})

describe('recommendations', () => {
  it('pools only hold the titles each user may see', async () => {
    expect(libraryAccess.forUser(OWNER)).toBeNull()
    const everything = { movies: ['101', '102', '103'], shows: ['201', '202'] }
    for (const id of [OWNER, ALICE, BOB]) {
      const keys = recKeys(await recommender.getRecommendations(id, null, null, libraryAccess.forUser(id)))
      expect(keys.movies).toEqual(everything.movies)
      expect(keys.shows).toEqual(everything.shows)
    }
    const kid = recKeys(await recommender.getRecommendations(KID, null, null, libraryAccess.forUser(KID)))
    expect(kid.movies).toEqual(['101'])
    expect(kid.shows).toEqual(['201', '202'])
    expect(kid.topPicks).not.toContain('102')
    expect(kid.topPicks).not.toContain('103')
  })

  it('resolves access from the user id when none is passed', async () => {
    const kid = recKeys(await recommender.getRecommendations(KID, null))
    expect(kid.movies).toEqual(['101'])
  })

  it('keeps the whole library for the taste profile', async () => {
    // kid's only play (Movie B) is outside their filter, yet it still shapes
    // the profile: Movie A shares its director
    const data = await recommender.getRecommendations(KID, null, null, libraryAccess.forUser(KID))
    const movieA = data.movies.find(i => i.ratingKey === '101')
    expect(movieA.breakdown.dirPts).toBe(30)
    expect(movieA.reasons.join(' ')).toContain('Dir X')
  })

  it('rebuilds a cached pool built for other access', async () => {
    const sections = vi.spyOn(plex, 'getLibraryItems')
    expect(recKeys(await recommender.getRecommendations(ALICE, null, null, libraryAccess.forUser(ALICE))).movies)
      .toEqual(['101', '102', '103'])
    const builds = sections.mock.calls.length
    await recommender.getRecommendations(ALICE, null, null, libraryAccess.forUser(ALICE))
    expect(sections.mock.calls.length).toBe(builds) // same access → served from the cache

    // Share narrowed to section 2; only the memo is dropped, not the rec cache
    libraryAccess.saveSnapshot(ALICE, 'plex', { role: 'shared', sectionIds: ['2'] })
    libraryAccess.invalidate()
    const keys = recKeys(await recommender.getRecommendations(ALICE, null, null, libraryAccess.forUser(ALICE)))
    expect(sections.mock.calls.length).toBeGreaterThan(builds)
    expect(keys.movies).toEqual([])
    expect(keys.shows).toEqual(['201', '202'])
    sections.mockRestore()
  })

  it('shows everyone the whole library with enforcement off', async () => {
    db.setSetting('library_access_enforced', '0')
    libraryAccess.invalidate()
    const kid = recKeys(await recommender.getRecommendations(KID, null))
    expect(kid.movies).toEqual(['101', '102', '103'])
  })

  it('warm-up builds each user for their own access and skips users who see nothing', async () => {
    tautulli.getFullHistory.mockClear()
    await recommender.warmAllUserCaches()
    const warmed = new Set(tautulli.getFullHistory.mock.calls.map(([id]) => String(id)))
    expect(warmed).toEqual(new Set([OWNER, ALICE, BOB, KID])) // GONE has no snapshot

    // kid's warmed pool matches kid's access: served without a rebuild
    const sections = vi.spyOn(plex, 'getLibraryItems')
    const kid = recKeys(await recommender.getRecommendations(KID, 'token', null, libraryAccess.forUser(KID)))
    expect(sections).not.toHaveBeenCalled()
    expect(kid.movies).toEqual(['101'])
    sections.mockRestore()
  })

  it('warm-up leaves a fresh pool built for a password-admin session alone', async () => {
    // kid's session elevated with the admin password: unrestricted ('all') pool
    const panel = await call('/api/recommendations', { user: KID, role: 'panel' })
    expect(recKeys(panel.data).movies).toEqual(['101', '102', '103'])
    tautulli.getFullHistory.mockClear()
    await recommender.warmAllUserCaches()
    expect(tautulli.getFullHistory.mock.calls.map(([id]) => String(id))).not.toContain(KID)

    const sections = vi.spyOn(plex, 'getLibraryItems')
    const again = await call('/api/recommendations', { user: KID, role: 'panel' })
    expect(sections).not.toHaveBeenCalled() // still served from the cache
    expect(recKeys(again.data).movies).toEqual(['101', '102', '103'])
    sections.mockRestore()
    // kid's own access still never reads that pool
    expect(recKeys(await recommender.getRecommendations(KID, null, null, libraryAccess.forUser(KID))).movies).toEqual(['101'])
  })

  it('an explicit undefined access sees nothing', async () => {
    // req.libraryAccess on a router without libraryAccess.middleware
    expect(recKeys(await recommender.getRecommendations(OWNER, null, null, undefined)))
      .toEqual({ movies: [], shows: [], topPicks: [] })
  })
})

describe('explore recommendations', () => {
  beforeEach(() => {
    discoverRecommender.invalidateAllCaches()
    for (const id of [OWNER, ALICE, BOB, KID]) db.setDiscoverPool(id, {}, 0)
  })

  it('excludes only the titles the user may access and flags restricted ones', async () => {
    const alice = await explore(ALICE, libraryAccess.forUser(ALICE))
    expect(poolKeys(alice)).not.toContain('11:movie')
    expect(poolKeys(alice)).toEqual(expect.arrayContaining(['500:movie', '31:tv', '600:tv']))
    expect(alice.tvShows.find(i => i.tmdbId === 31).restricted).toBe(true)
    expect(alice.tvShows.find(i => i.tmdbId === 600).restricted).toBeUndefined()
    // Trending is filtered per request with the same rule
    expect(tmdbKeysOf(alice.trendingMovies)).toEqual(['500:movie'])
    expect(alice.trendingTV.find(i => i.tmdbId === 31).restricted).toBe(true)

    for (const [id, access] of [[BOB, libraryAccess.forUser(BOB)], [OWNER, null]]) {
      const data = await explore(id, access)
      expect(poolKeys(data)).not.toContain('11:movie')
      expect(poolKeys(data)).not.toContain('31:tv')
      expect(tmdbKeysOf(data.trendingTV)).toEqual(['600:tv'])
      const all = Object.values(data).filter(Array.isArray).flat()
      expect(all.some(i => 'restricted' in i)).toBe(false)
    }
  })

  it('stores the fingerprint with the persisted pool and rebuilds on a mismatch', async () => {
    await explore(ALICE, libraryAccess.forUser(ALICE))
    expect(db.getDiscoverPool(ALICE).pools.accessFp).toBe(libraryAccess.fingerprint(libraryAccess.forUser(ALICE)))

    // Restart (memory cache gone) after alice gained section 10
    discoverRecommender.invalidateAllCaches()
    libraryAccess.saveSnapshot(ALICE, 'plex', { role: 'shared', sectionIds: ['1', '2', '10'] })
    libraryAccess.invalidate()
    const access = libraryAccess.forUser(ALICE)
    expect(db.getDiscoverPool(ALICE).pools.tvShows.map(i => i.tmdbId)).toContain(31) // built before section 10
    const stale = await discoverRecommender.getDiscoverRecommendations(ALICE, null, { access })
    expect(stale.status).toBeUndefined() // the old pool is served while it rebuilds...
    expect(poolKeys(stale)).not.toContain('31:tv') // ...minus what alice now has (31 is in section 10)
    expect(poolKeys(stale)).toEqual(expect.arrayContaining(['500:movie', '600:tv']))
    const fresh = await explore(ALICE, access, (d) => expect(poolKeys(d)).not.toContain('31:tv'))
    expect(poolKeys(fresh)).toContain('500:movie')
    expect(db.getDiscoverPool(ALICE).pools.accessFp).toBe(libraryAccess.fingerprint(access))
  })

  it('warm-up builds each user for their own access', async () => {
    await discoverRecommender.warmAllUserDiscoverCaches()
    expect(db.getDiscoverPool(GONE)).toBeNull() // no snapshot: skipped
    expect(db.getDiscoverPool(KID).pools.accessFp).toBe(libraryAccess.fingerprint(libraryAccess.forUser(KID)))
    expect(db.getDiscoverPool(OWNER).pools.accessFp).toBe('all')
    const bob = await discoverRecommender.getDiscoverRecommendations(BOB, null, { access: libraryAccess.forUser(BOB) })
    expect(poolKeys(bob)).not.toContain('31:tv')
  })

  it('an explicit undefined access sees nothing', async () => {
    // req.libraryAccess on a router without libraryAccess.middleware: every
    // library title is someone else's, so none counts as owned
    const data = await explore(OWNER, undefined)
    expect(db.getDiscoverPool(OWNER).pools.accessFp).toBe('none')
    expect(data.movies.find(i => i.tmdbId === 11)?.restricted).toBe(true)
    expect(data.tvShows.find(i => i.tmdbId === 31)?.restricted).toBe(true)
  })
})

// Jellyfin folders F1 (a movie, tmdb 41) and F2 (a show, tmdb 42). alice's
// linked Jellyfin account may see F1 only; bob has no Jellyfin account.
describe('jellyfin', () => {
  const F1 = 'f1'.repeat(16), F2 = 'f2'.repeat(16), JF_ALICE = `jf_${'a1'.repeat(16)}`
  const jfCandidates = [tmdbItem(41, 'movie', 'JF Movie'), tmdbItem(42, 'tv', 'JF Show')]
  const allKeys = (data) => [...new Set(['topPicks', 'movies', 'tvShows', 'anime'].flatMap(k => keysOf(data[k])))].sort()
  const flagged = (data, tmdbId) => Object.values(data).filter(Array.isArray).flat().find(i => i.tmdbId === tmdbId)?.restricted

  beforeAll(() => {
    db.setSetting('jellyfin_url', 'http://jellyfin.test')
    db.setSetting('jellyfin_api_key', 'JF_KEY')
    db.setSetting('jellyfin_enabled', '1')
    const ins = db.prepare(`INSERT INTO library_items (rating_key, section_id, title, year, type, tmdb_id, audience_rating, source)
      VALUES (?, ?, ?, 2015, ?, ?, 7, 'jellyfin')`)
    ins.run('aaaa1111', `jf_${F1}`, 'JF Movie', 'movie', '41')
    ins.run('bbbb2222', `jf_${F2}`, 'JF Show', 'show', '42')
    db.upsertJellyfinUser(JF_ALICE, 'alice-jf', null, null)
    db.linkJellyfinAccount(JF_ALICE, ALICE)
    // Server-wide Jellyfin plays (someone else's) for /popular
    const now = Math.floor(Date.now() / 1000)
    db.upsertWatchHistoryBatch([
      { historyId: 'jf:1', userId: 'jf_other', ratingKey: 'aaaa1111', mediaType: 'movie', watchedAt: now, source: 'jellyfin' },
      { historyId: 'jf:2', userId: 'jf_other', ratingKey: 'ep1', grandparentRatingKey: 'bbbb2222', mediaType: 'episode', watchedAt: now, source: 'jellyfin' },
    ])
    CANDIDATES.push(...jfCandidates)
    for (const c of jfCandidates) DETAILS.set(`${c.tmdbId}:${c.mediaType}`, c)
    db.setDiscoverCandidates('::0', CANDIDATES)
  })

  beforeEach(() => {
    libraryAccess.saveSnapshot(JF_ALICE, 'jellyfin', { role: 'jellyfin', sectionIds: [`jf_${F1}`] })
    libraryAccess.invalidate()
  })

  afterAll(() => {
    db.setSetting('jellyfin_enabled', '0')
    db.unlinkJellyfinAccount(JF_ALICE)
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    db.prepare("DELETE FROM watch_history WHERE source = 'jellyfin'").run()
    CANDIDATES.splice(-jfCandidates.length)
    for (const c of jfCandidates) DETAILS.delete(`${c.tmdbId}:${c.mediaType}`)
    db.setDiscoverCandidates('::0', CANDIDATES)
    libraryAccess.invalidate()
  })

  it('rec pools hold the Jellyfin folders the linked account may see', async () => {
    const jfKeys = (id, access) => recommender.getRecommendations(id, null, null, access)
      .then(d => allKeys(d).filter(k => k === 'aaaa1111' || k === 'bbbb2222'))
    expect(await jfKeys(ALICE, libraryAccess.forUser(ALICE))).toEqual(['aaaa1111'])
    expect(await jfKeys(BOB, libraryAccess.forUser(BOB))).toEqual([]) // unlinked: no Jellyfin access
    expect(await jfKeys(OWNER, null)).toEqual(['aaaa1111', 'bbbb2222'])
    expect(allKeys(await recommender.getRecommendations(GONE, null))).toEqual([]) // no snapshot

    // The Jellyfin side of Home
    const { data } = await call('/api/recommendations', { user: ALICE, source: 'jellyfin' })
    expect(allKeys(data)).toEqual(['aaaa1111'])
  })

  it('explore flags titles held only in a Jellyfin folder the user can\'t see', async () => {
    discoverRecommender.invalidateAllCaches()
    for (const id of [ALICE, BOB]) db.setDiscoverPool(id, {}, 0)
    const alice = await explore(ALICE, libraryAccess.forUser(ALICE))
    expect(poolKeys(alice)).not.toContain('41:movie') // F1: alice has it
    expect(poolKeys(alice)).toContain('42:tv')
    expect(flagged(alice, 42)).toBe(true)
    expect(tmdbKeysOf(alice.trendingMovies)).not.toContain('41:movie')
    expect(alice.trendingTV.find(i => i.tmdbId === 42)?.restricted).toBe(true)

    const bob = await explore(BOB, libraryAccess.forUser(BOB))
    expect(flagged(bob, 41)).toBe(true)
    expect(flagged(bob, 42)).toBe(true)
  })

  it('/popular on the Jellyfin side only lists titles the user may see', async () => {
    const popular = async (user) => {
      const { status, data } = await call('/api/popular', { user, source: 'jellyfin' })
      expect(status).toBe(200)
      return { movies: keysOf(data.movies), shows: keysOf(data.tvShows) }
    }
    expect(await popular(OWNER)).toEqual({ movies: ['aaaa1111'], shows: ['bbbb2222'] })
    expect(await popular(ALICE)).toEqual({ movies: ['aaaa1111'], shows: [] })
    expect(await popular(BOB)).toEqual({ movies: [], shows: [] })
    expect(await popular(GONE)).toEqual({ movies: [], shows: [] })
  })
})

describe('routes', () => {
  it('/popular only lists titles the user may see', async () => {
    const popular = async (user, role) => {
      const { data } = await call('/api/popular', { user, role })
      return { movies: keysOf(data.movies), shows: keysOf(data.tvShows) }
    }
    expect(await popular(ALICE)).toEqual({ movies: ['101', '102'], shows: ['201'] })
    expect(await popular(BOB)).toEqual({ movies: ['101', '102'], shows: ['1001', '201'] })
    expect(await popular(KID)).toEqual({ movies: ['101'], shows: ['201'] })
    expect(await popular(OWNER)).toEqual({ movies: ['101', '102'], shows: ['1001', '201'] })
    expect(await popular(PANEL, 'panel')).toEqual({ movies: ['101', '102'], shows: ['1001', '201'] })
  })

  it('/recommendations uses the request access', async () => {
    const kid = await call('/api/recommendations', { user: KID })
    expect(kid.status).toBe(200)
    expect(recKeys(kid.data).movies).toEqual(['101'])
    // The password admin is unrestricted whatever user id the session carries
    const panel = await call('/api/recommendations', { user: KID, role: 'panel' })
    expect(recKeys(panel.data).movies).toEqual(['101', '102', '103'])
  })

  it('/explore/recommendations uses the request access', async () => {
    discoverRecommender.invalidateAllCaches()
    for (const id of [ALICE, BOB]) db.setDiscoverPool(id, {}, 0)
    const get = async (user) => {
      let data
      await vi.waitFor(async () => {
        ({ data } = await call('/api/explore/recommendations', { user }))
        expect(data.status).toBeUndefined()
      }, { timeout: 4000, interval: 20 })
      return data
    }
    const alice = await get(ALICE)
    expect(alice.tvShows.find(i => i.tmdbId === 31)?.restricted).toBe(true)
    expect(poolKeys(await get(BOB))).not.toContain('31:tv')
  })

  it('made no outbound calls', () => {
    expect(outbound).toEqual([])
  })
})
