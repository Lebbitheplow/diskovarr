import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequestHarness } from './helpers/requestApp.js'

// Per-user library access on the browse / search / request surfaces
// (routes/api.js + services/requestPolicy): library browse, facets and monitor
// suggestions use the allowed pool; the search family adds the restricted
// tri-state; requests (and Notify Me) for a restricted title are refused.
// Fixture library: Plex sections 1 (movies), 2 (shows) and 10 (YouTube
// shows); users with sections 1+2, 1+2+10, a filtered section 1, no snapshot,
// and the unrestricted owner. The Jellyfin block adds two folders.
const h = createRequestHarness()
const { db } = h
const libraryAccess = h.nodeRequire('../../server/services/libraryAccess/index.js')
const requestPolicy = h.nodeRequire('../../server/services/requestPolicy.js')

const OWNER = '500'
const BASIC = '501' // sections 1 + 2
const TUBE = '502' // sections 1 + 2 + 10
const KID = '503' // section 1 filtered to Movie A, section 2
const NOSNAP = '509' // no access snapshot yet

const LIBRARY = [
  // rating_key, section, title, type, tmdb, tvdb, genres, countries, studio
  ['101', '1', 'Movie A', 'movie', '11', null, ['Drama'], ['France'], 'Studio A'],
  ['102', '1', 'Movie B', 'movie', '12', null, ['Horror'], ['Japan'], 'Studio B'],
  ['201', '2', 'Show A', 'show', '21', '2100', ['Comedy'], ['France'], 'Net A'],
  ['202', '2', 'Twin', 'show', '99', '9900', ['Drama'], [], 'Net A'],
  ['1001', '10', 'Tube A', 'show', '31', '3100', ['Documentary'], ['Canada'], 'YouTube'],
  ['1002', '10', 'Twin', 'show', '99', '9900', ['Drama'], [], 'YouTube'],
]

const seasons = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, episodeCount: 5 }))
// TMDB details (also seeded into tmdb_cache so search pools need no TMDB call)
const TMDB = {
  '11:movie': { title: 'Movie A' },
  '12:movie': { title: 'Movie B' },
  '77:movie': { title: 'Elsewhere' }, // not in any library
  '21:tv': { title: 'Show A', seasonDetails: seasons(2), numberOfSeasons: 2 },
  '31:tv': { title: 'Tube A', seasonDetails: seasons(3), numberOfSeasons: 3 },
  '99:tv': { title: 'Twin', seasonDetails: seasons(1), numberOfSeasons: 1 },
}
const details = (key) => {
  const [id, mediaType] = key.split(':')
  return { tmdbId: Number(id), mediaType, year: 2020, genres: ['Drama'], genreIds: [18], popularity: 100 - Number(id), voteAverage: 7, posterUrl: null, ...TMDB[key] }
}

function seedLibrary() {
  const ins = db.prepare(`INSERT INTO library_items
    (rating_key, section_id, title, year, type, tmdb_id, tvdb_id, genres, countries, studio, audience_rating, source)
    VALUES (?, ?, ?, 2020, ?, ?, ?, ?, ?, ?, 7, 'plex')`)
  for (const [rk, sec, title, type, tmdb, tvdb, genres, countries, studio] of LIBRARY) {
    ins.run(rk, sec, title, type, tmdb, tvdb, JSON.stringify(genres), JSON.stringify(countries), studio)
  }
  for (const s of ['1', '2', '10']) db.setSyncTime(`library_${s}`)
  h.plex.invalidateCache()
  for (const key of Object.keys(TMDB)) {
    const d = details(key)
    db.setTmdbCache(d.tmdbId, d.mediaType, d)
  }
}

function seedAccess() {
  libraryAccess.saveSnapshot(BASIC, 'plex', { role: 'shared', sectionIds: ['1', '2'] })
  libraryAccess.saveSnapshot(TUBE, 'plex', { role: 'shared', sectionIds: ['1', '2', '10'] })
  libraryAccess.saveSnapshot(KID, 'plex', { role: 'shared', sectionIds: ['1', '2'], filteredSectionIds: ['1'], visibleKeys: ['101'] })
  libraryAccess.invalidate()
}

const enforce = (on) => { db.setSetting('library_access_enforced', on ? '1' : '0'); libraryAccess.invalidate() }
const get = (route, user, extra = {}) => h.call('GET', route, { user, ...extra })
const keysOf = (items) => items.map(i => i.ratingKey).sort()
const byId = (list) => Object.fromEntries(list.map(r => [`${r.tmdbId}:${r.mediaType}`, r]))

beforeAll(async () => {
  db.setSetting('plex_url', 'http://plex.test:32400') // the fixture's sections live on a configured Plex
  for (const id of [OWNER, BASIC, TUBE, KID, NOSNAP, 'boss']) db.upsertKnownUser(id, `user${id}`, null, null)
  db.setOwnerUserId(OWNER)
  await h.start()
})
afterAll(() => h.stop())
beforeEach(() => {
  h.reset()
  seedLibrary()
  seedAccess()
  enforce(true)
  vi.spyOn(h.tmdb, 'getItemDetails').mockImplementation(async (id, type) => (TMDB[`${id}:${type}`] ? details(`${id}:${type}`) : null))
  vi.spyOn(h.tmdb, 'tmdbFetchPublic').mockImplementation(async (url) => {
    if (url.startsWith('/search/multi')) {
      return { total_pages: 1, results: [{ id: 31, media_type: 'tv' }, { id: 11, media_type: 'movie' }, { id: 77, media_type: 'movie' }, { id: 99, media_type: 'tv' }] }
    }
    if (url.startsWith('/find/')) return { tv_results: [] }
    return null
  })
  vi.spyOn(h.tmdb, 'batchGetDetails').mockResolvedValue([])
  const candidates = [{ tmdbId: 31, mediaType: 'tv' }, { tmdbId: 21, mediaType: 'tv' }, { tmdbId: 77, mediaType: 'movie' }]
  vi.spyOn(h.tmdb, 'getRecommendations').mockImplementation(async (id, type, page) => (page === 1 ? candidates : []))
  vi.spyOn(h.tmdb, 'getPersonCombinedCredits').mockResolvedValue(candidates.map(c => ({ ...c, title: TMDB[`${c.tmdbId}:${c.mediaType}`].title })))
})
afterEach(() => vi.restoreAllMocks())

// ── Library browse, facets, monitor suggestions ──────────────────────────────

describe('library browse uses the allowed pool', () => {
  it('drops what a filtered user cannot see from /discover and its filter options', async () => {
    const kid = await get('/api/discover', KID)
    expect(kid.status).toBe(200)
    expect(keysOf(kid.data.items)).toEqual(['101', '201', '202'])
    expect(kid.data.availableGenres).not.toContain('Horror')

    const basic = await get('/api/discover', BASIC)
    expect(keysOf(basic.data.items)).toEqual(['101', '102', '201', '202'])
  })

  it('limits /discover/genres and /discover/facets to the allowed pool', async () => {
    expect((await get('/api/discover/genres', KID)).data.genres).not.toContain('Horror')
    expect((await get('/api/discover/genres', BASIC)).data.genres).toContain('Horror')
    expect((await get('/api/discover/facets?field=country', KID)).data.values).toEqual(['France'])
    expect((await get('/api/discover/facets?field=studio', KID)).data.values).toEqual(['Net A', 'Studio A'])
  })

  it('limits monitor criteria suggestions to the allowed pool', async () => {
    expect((await get('/api/monitors/criteria/suggest?type=country', KID)).data.values).toEqual(['France'])
    expect((await get('/api/monitors/criteria/suggest?type=studio', KID)).data.values).toEqual(['Net A', 'Studio A'])
    expect((await get('/api/monitors/criteria/suggest?type=country', BASIC)).data.values).toEqual(['France', 'Japan'])
  })

  it('shows a user with no access to the server nothing', async () => {
    libraryAccess.saveSnapshot(BASIC, 'plex', { role: 'removed' })
    libraryAccess.invalidate()
    expect((await get('/api/discover', BASIC)).data.items).toEqual([])
    expect((await get('/api/discover/genres', BASIC)).data.genres).toEqual([])
  })
})

// ── Search family: restricted tri-state ──────────────────────────────────────

describe('search details', () => {
  it('reports a title held only in an inaccessible section as restricted, with nothing to open', async () => {
    // Someone else's request must not turn into a Notify Me for it either
    db.addDiscoverRequestWithStatus(TUBE, 31, 'tv', 'Tube A', 'none', 3, 'approved')
    const res = await get('/api/search/details?tmdbId=31&type=tv', BASIC)
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({ inLibrary: false, restricted: true, ratingKey: null, deepLink: null, plexAppLink: null, isInWatchlist: false, isRequested: false })
  })

  it('does not flag users who can access the section, nor the owner', async () => {
    for (const user of [TUBE, OWNER]) {
      const res = await get('/api/search/details?tmdbId=31&type=tv', user)
      expect(res.data.inLibrary).toBe(false) // section 10 is outside the search pool, as before
      expect('restricted' in res.data).toBe(false)
    }
    const movie = await get('/api/search/details?tmdbId=11&type=movie', BASIC)
    expect(movie.data).toMatchObject({ inLibrary: true, ratingKey: '101' })
    expect(movie.data.deepLink).toContain('/library/metadata/101')
  })

  it('gives unrestricted principals exactly the pre-enforcement payload', async () => {
    const cases = [[OWNER, {}], ['boss', { role: 'panel' }]]
    for (const [user, extra] of cases) {
      for (const q of ['tmdbId=31&type=tv', 'tmdbId=11&type=movie', 'tmdbId=99&type=tv']) {
        enforce(true)
        const on = await get(`/api/search/details?${q}`, user, extra)
        enforce(false)
        const off = await get(`/api/search/details?${q}`, user, extra)
        expect(on.data).toEqual(off.data)
      }
    }
  })

  it('stops flagging once the kill switch is off', async () => {
    enforce(false)
    const res = await get('/api/search/details?tmdbId=31&type=tv', BASIC)
    expect('restricted' in res.data).toBe(false)
  })

  it('hides the library copy from a filtered user: the title reads as restricted', async () => {
    const res = await get('/api/search/details?tmdbId=12&type=movie', KID)
    expect(res.data).toMatchObject({ inLibrary: false, restricted: true, ratingKey: null })
  })
})

describe('text and genre search', () => {
  it('marks restricted results without ratingKey, links or watch flags', async () => {
    db.addDiscoverRequestWithStatus(TUBE, 31, 'tv', 'Tube A', 'none', 3, 'approved')
    const res = await get('/api/search?q=a', BASIC)
    expect(res.status).toBe(200)
    const r = byId(res.data.results)
    expect(r['31:tv']).toMatchObject({ inLibrary: false, restricted: true, ratingKey: null, deepLink: null, isWatched: false, isInWatchlist: false, isRequested: false })
    expect(r['11:movie']).toMatchObject({ inLibrary: true, ratingKey: '101' })
    expect('restricted' in r['11:movie']).toBe(false)
    expect('restricted' in r['77:movie']).toBe(false)
    // In section 2 (accessible) and section 10 (not): the accessible copy wins
    expect(r['99:tv']).toMatchObject({ inLibrary: true, ratingKey: '202' })
  })

  it('leaves users with access and the owner unflagged', async () => {
    for (const user of [TUBE, OWNER]) {
      const r = byId((await get('/api/search?q=a', user)).data.results)
      expect('restricted' in r['31:tv']).toBe(false)
    }
    enforce(true)
    const on = await get('/api/search?q=a', OWNER)
    enforce(false)
    expect(on.data).toEqual((await get('/api/search?q=a', OWNER)).data)
  })

  it('hides restricted titles from genre browsing along with in-library ones', async () => {
    const ids = async (user) => (await get('/api/search?genre=Drama', user)).data.results.map(i => `${i.tmdbId}:${i.mediaType}`).sort()
    expect(await ids(BASIC)).toEqual(['77:movie'])
    // Section 10 sits outside the search pool, so whoever can open it still sees it
    expect(await ids(TUBE)).toEqual(['31:tv', '77:movie'])
    expect(await ids(OWNER)).toEqual(['31:tv', '77:movie'])
  })

  it('searches only the allowed library when TMDB search is off', async () => {
    db.setSetting('discover_enabled', '0')
    const titles = async (user) => (await get('/api/search?q=movie', user)).data.results.map(i => i.ratingKey).sort()
    expect(await titles(KID)).toEqual(['101'])
    expect(await titles(OWNER)).toEqual(['101', '102'])
  })
})

describe('similar and person browse', () => {
  for (const [name, route, list] of [
    ['similar', '/api/search/similar?tmdbId=11&type=movie', 'similar'],
    ['person', '/api/search/person?personId=5', 'credits'],
  ]) {
    it(`${name}: flags restricted titles and hides them with the library`, async () => {
      const r = byId((await get(route, BASIC)).data[list])
      expect(r['31:tv']).toMatchObject({ inLibrary: false, restricted: true, ratingKey: null, isRequested: false })
      expect(r['21:tv']).toMatchObject({ inLibrary: true, ratingKey: '201' })
      const hidden = (await get(`${route}&hideLibrary=true`, BASIC)).data[list]
      expect(hidden.map(i => `${i.tmdbId}:${i.mediaType}`)).toEqual(['77:movie'])
      const tube = byId((await get(route, TUBE)).data[list])
      expect('restricted' in tube['31:tv']).toBe(false)
    })
  }
})

describe('search seasons', () => {
  it('resolves only a copy the user may see', async () => {
    expect((await get('/api/search/seasons?tmdbId=31', BASIC)).data.inLibrary).toBe(false)
    // A client-supplied key for the inaccessible copy is ignored too
    expect((await get('/api/search/seasons?tmdbId=31&ratingKey=1001', BASIC)).data.inLibrary).toBe(false)
    expect((await get('/api/search/seasons?tmdbId=31', TUBE)).data.inLibrary).toBe(true)
    expect((await get('/api/search/seasons?tmdbId=31&ratingKey=1001', OWNER)).data.inLibrary).toBe(true)
    // Twin lives in sections 2 and 10: the accessible copy is used
    expect((await get('/api/search/seasons?tmdbId=99&ratingKey=1002', BASIC)).data.inLibrary).toBe(true)
  })
})

// ── Requests ─────────────────────────────────────────────────────────────────

describe('requests for restricted titles', () => {
  const show = (extra = {}) => ({ tmdbId: 31, mediaType: 'tv', title: 'Tube A', service: 'none', ...extra })
  const count = () => db.prepare('SELECT COUNT(*) AS c FROM discover_requests').get().c

  it('refuses POST /api/request with 409 and stores nothing', async () => {
    const res = await h.call('POST', '/api/request', { user: BASIC, body: show() })
    expect(res.status).toBe(409)
    expect(res.data).toEqual({ error: requestPolicy.RESTRICTED_MESSAGE, restricted: true })
    expect(res.data.error).toBe('This title is in a library you don\'t have access to — ask the server owner')
    expect(count()).toBe(0)
  })

  it('also catches a TVDB-only request for it', async () => {
    const res = await h.call('POST', '/api/request', { user: BASIC, body: { tvdbId: 3100, mediaType: 'tv', title: 'Tube A', service: 'none' } })
    expect(res.status).toBe(409)
    expect(count()).toBe(0)
  })

  it('lets users with access, the owner, and everyone with the kill switch off through', async () => {
    expect((await h.call('POST', '/api/request', { user: TUBE, body: show() })).status).toBe(200)
    expect((await h.call('POST', '/api/request', { user: OWNER, body: show() })).status).toBe(200)
    enforce(false)
    expect((await h.call('POST', '/api/request', { user: BASIC, body: show() })).status).toBe(200)
  })

  it('does not refuse titles outside the library, or ones the user can see', async () => {
    expect((await h.call('POST', '/api/request', { user: BASIC, body: { tmdbId: 77, mediaType: 'movie', title: 'Elsewhere', service: 'none' } })).status).toBe(200)
    expect((await h.call('POST', '/api/request', { user: BASIC, body: { tmdbId: 99, mediaType: 'tv', title: 'Twin', service: 'none' } })).status).toBe(200)
  })

  it('applies to background callers through the requester\'s own access', async () => {
    await expect(requestPolicy.createRequest({ userId: BASIC, tmdbId: 31, mediaType: 'tv', title: 'Tube A', service: 'none' }))
      .rejects.toMatchObject({ status: 409, extra: { restricted: true } })
    expect(requestPolicy.isRestrictedTitle({ access: libraryAccess.forUser(TUBE), tmdbId: 31, mediaType: 'tv' })).toBe(false)
    expect(requestPolicy.isRestrictedTitle({ access: null, tmdbId: 31, mediaType: 'tv' })).toBe(false)
    // TMDB ids are per media type: movie 31 is not the show
    expect(requestPolicy.isRestrictedTitle({ access: libraryAccess.forUser(BASIC), tmdbId: 31, mediaType: 'movie' })).toBe(false)
  })

  it('refuses the requester\'s own edits of a request for a restricted title', async () => {
    const id = db.addDiscoverRequestWithStatus(BASIC, 31, 'tv', 'Tube A', 'none', 3, 'pending', [1])
    const own = await h.call('PUT', `/api/queue/${id}`, { user: BASIC, body: { seasons: [1, 2] } })
    expect(own.status).toBe(409)
    expect(own.data).toEqual({ error: requestPolicy.RESTRICTED_MESSAGE, restricted: true })
    expect(db.getRequestById(id).seasons_json).toBe('[1]')

    const tubeId = db.addDiscoverRequestWithStatus(TUBE, 31, 'tv', 'Tube A', 'none', 3, 'pending', [1])
    expect((await h.call('PUT', `/api/queue/${tubeId}`, { user: TUBE, body: { seasons: [1, 2] } })).status).toBe(200)
  })

  it('leaves queue management by admins and request managers unfiltered, like approval', async () => {
    // The password admin, and a request manager who is restricted themselves
    db.setUserAdmin(KID, true)
    try {
      for (const [user, role] of [['boss', 'panel'], [KID, undefined]]) {
        const id = db.addDiscoverRequestWithStatus(BASIC, 31, 'tv', 'Tube A', 'none', 3, 'pending', [1])
        const res = await h.call('PUT', `/api/queue/${id}`, { user, role, body: { seasons: [1, 2] } })
        expect(res.status, user).toBe(200)
        expect(JSON.parse(db.getRequestById(id).seasons_json)).toEqual([1, 2])
      }
    } finally {
      db.setUserAdmin(KID, false)
    }
  })

  it('refuses Notify Me on someone else\'s request for a restricted title', async () => {
    db.addDiscoverRequestWithStatus(TUBE, 31, 'tv', 'Tube A', 'none', 3, 'approved')
    const follow = (user) => h.call('POST', '/api/explore/follow', { user, body: { tmdbId: 31, mediaType: 'tv', title: 'Tube A' } })
    const follows = (user) => db.prepare('SELECT COUNT(*) AS c FROM discover_requests WHERE user_id = ? AND is_follow = 1').get(user).c
    const res = await follow(BASIC)
    expect(res.status).toBe(409)
    expect(res.data).toEqual({ error: requestPolicy.RESTRICTED_MESSAGE, restricted: true })
    expect(follows(BASIC)).toBe(0)
    expect((await follow(OWNER)).status).toBe(200)
    expect(follows(OWNER)).toBe(1)
    enforce(false)
    expect((await follow(BASIC)).status).toBe(200)
    expect(follows(BASIC)).toBe(1)
  })
})

// ── Fail-closed and unrestricted edges ───────────────────────────────────────

describe('a user with no access snapshot', () => {
  it('sees every library title as restricted and cannot request it', async () => {
    expect((await get('/api/search/details?tmdbId=11&type=movie', NOSNAP)).data)
      .toMatchObject({ inLibrary: false, restricted: true, ratingKey: null, deepLink: null })
    expect((await get('/api/discover', NOSNAP)).data.items).toEqual([])
    const res = await h.call('POST', '/api/request', { user: NOSNAP, body: { tmdbId: 11, mediaType: 'movie', title: 'Movie A', service: 'none' } })
    expect(res.status).toBe(409)
    expect(res.data.restricted).toBe(true)
    // Titles outside the library stay requestable
    expect((await h.call('POST', '/api/request', { user: NOSNAP, body: { tmdbId: 77, mediaType: 'movie', title: 'Elsewhere', service: 'none' } })).status).toBe(200)
  })
})

describe('restriction helpers', () => {
  it('treat access nobody looked up as no access, and only null as unrestricted', () => {
    expect(requestPolicy.restrictedTitles(undefined)(31, null, 'tv')).toBe(true)
    expect(requestPolicy.restrictedTitles(undefined)(77, null, 'movie')).toBe(false) // not in the library
    expect(requestPolicy.restrictedTitles(null)(31, null, 'tv')).toBe(false)
    expect(requestPolicy.isRestrictedTitle({ access: undefined, tmdbId: 31, mediaType: 'tv' })).toBe(true)
    expect(requestPolicy.isRestrictedTitle({ access: libraryAccess.NO_ACCESS, tmdbId: 31, mediaType: 'tv' })).toBe(true)
    expect(requestPolicy.isRestrictedTitle({ access: null, tmdbId: 31, mediaType: 'tv' })).toBe(false)
  })
})

describe('unrestricted principals', () => {
  it('get the pre-enforcement answer from every browse and search route', async () => {
    const routes = [
      '/api/discover', '/api/discover/genres', '/api/discover/facets?field=country', '/api/discover/facets?field=studio',
      '/api/monitors/criteria/suggest?type=country', '/api/monitors/criteria/suggest?type=network',
      '/api/search/similar?tmdbId=11&type=movie', '/api/search/person?personId=5',
      '/api/search/seasons?tmdbId=31', '/api/search?genre=Drama',
    ]
    for (const [user, extra] of [[OWNER, {}], ['boss', { role: 'panel' }]]) {
      for (const route of routes) {
        enforce(true)
        const on = await get(route, user, extra)
        enforce(false)
        const off = await get(route, user, extra)
        expect(on.status, route).toBe(200)
        expect(on.data, `${user} ${route}`).toEqual(off.data)
      }
    }
  })

  it('answer 500 as before when a library section cannot load, not an empty library', async () => {
    vi.spyOn(h.plex, 'getLibraryItems').mockRejectedValue(new Error('Plex unreachable'))
    for (const user of [OWNER, BASIC]) {
      expect((await get('/api/discover', user)).status).toBe(500)
      expect((await get('/api/search/details?tmdbId=11&type=movie', user)).status).toBe(500)
    }
  })
})

// ── Jellyfin rows ────────────────────────────────────────────────────────────

describe('jellyfin rows', () => {
  const JF_TUBE = `jf_${'0123456789abcdef'.repeat(2)}` // TUBE's linked Jellyfin account
  const JF_ROW = 'aaaabbbbccccddddeeeeffff00001111' // JF Movie (tmdb 41), folder jf_f1
  const JF_COPY = 'bbbbbbbbccccddddeeeeffff00001111' // a copy of Movie A, folder jf_f2
  const NON_ROW = 'ffffffffccccddddeeeeffff00009999' // e.g. an episode: no library row
  const watchParty = h.nodeRequire('../../server/services/watchParty/index.js')
  const jellyfinDriver = h.nodeRequire('../../server/services/watchParty/jellyfinDriver.js')

  beforeEach(() => {
    for (const [k, v] of Object.entries({ jellyfin_url: 'http://jf.invalid', jellyfin_api_key: 'k', jellyfin_enabled: '1' })) db.setSetting(k, v)
    const ins = db.prepare(`INSERT INTO library_items (rating_key, section_id, title, year, type, tmdb_id, genres, source)
      VALUES (?, ?, ?, 2020, 'movie', ?, '[]', 'jellyfin')`)
    ins.run(JF_ROW, 'jf_f1', 'JF Movie', '41')
    ins.run(JF_COPY, 'jf_f2', 'Movie A', '11')
    db.prepare("INSERT OR REPLACE INTO known_users (user_id, username, auth_provider, linked_user_id) VALUES (?, 'jf-tube', 'jellyfin', ?)").run(JF_TUBE, TUBE)
    libraryAccess.saveSnapshot(JF_TUBE, 'jellyfin', { role: 'jellyfin', sectionIds: ['jf_f1'] })
    libraryAccess.invalidate()
    h.tmdb.getItemDetails.mockImplementation(async (id, type) => ({ ...details(`${id}:${type}`), title: `Title ${id}` }))
  })
  afterEach(() => {
    db.setSetting('jellyfin_enabled', '0')
    db.prepare('DELETE FROM known_users WHERE user_id = ?').run(JF_TUBE)
    libraryAccess.invalidate()
  })

  it('flags a Jellyfin-only title for a Plex-only user and refuses its request', async () => {
    expect((await get('/api/search/details?tmdbId=41&type=movie', BASIC)).data)
      .toMatchObject({ inLibrary: false, restricted: true, ratingKey: null, deepLink: null })
    const res = await h.call('POST', '/api/request', { user: BASIC, body: { tmdbId: 41, mediaType: 'movie', title: 'JF Movie', service: 'none' } })
    expect(res.status).toBe(409)
    expect(res.data.restricted).toBe(true)
    // A copy in a Jellyfin folder they can't see doesn't hide the Plex one they can
    expect((await get('/api/search/details?tmdbId=11&type=movie', BASIC)).data).toMatchObject({ inLibrary: true, ratingKey: '101' })
  })

  it('opens it through a linked Jellyfin account that has the folder', async () => {
    for (const user of [TUBE, OWNER]) {
      const res = await get('/api/search/details?tmdbId=41&type=movie', user)
      expect(res.data).toMatchObject({ inLibrary: true, ratingKey: JF_ROW })
      expect('restricted' in res.data).toBe(false)
    }
  })

  it('casts only Jellyfin library rows a restricted user can access', async () => {
    for (const route of ['/api/cast/prepare', '/api/cast']) {
      const cast = (user, ratingKey) => h.call('POST', route, { user, body: { ratingKey, clientId: 'x' } })
      for (const [user, key] of [[BASIC, NON_ROW], [TUBE, NON_ROW], [BASIC, JF_ROW]]) {
        expect(await cast(user, key)).toMatchObject({ status: 403, data: { error: requestPolicy.RESTRICTED_MESSAGE, restricted: true } })
      }
      // These reach the Jellyfin path (no linked session in the harness → 400)
      for (const [user, key] of [[TUBE, JF_ROW], [OWNER, NON_ROW]]) {
        expect(await cast(user, key)).toMatchObject({ status: 400, data: { error: expect.stringMatching(/requires a linked Jellyfin account/) } })
      }
    }
  })

  it('starts Watch Together for a restricted host only from an accessible Jellyfin row', async () => {
    vi.spyOn(jellyfinDriver, 'resolveItem').mockImplementation(async (rk) => ({ ratingKey: rk, title: 'JF Movie', durationMs: 1000 }))
    await expect(watchParty.createParty({ hostId: TUBE, ratingKey: NON_ROW, userIds: [] })).rejects.toMatchObject({ status: 403 })
    expect(jellyfinDriver.resolveItem).not.toHaveBeenCalled()
    expect((await watchParty.createParty({ hostId: TUBE, ratingKey: JF_ROW, userIds: [] })).party).toMatchObject({ source: 'jellyfin', section_id: 'jf_f1' })
    expect((await watchParty.createParty({ hostId: OWNER, ratingKey: NON_ROW, userIds: [] })).party.library_key).toBe(NON_ROW)
  })
})
