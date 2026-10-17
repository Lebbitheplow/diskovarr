import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequestHarness } from './helpers/requestApp.js'

// Per-user library access on the social and playback surfaces: watchlist,
// casting, issues, request-queue availability, reviews, Movie Night, Watch
// Together, monitor "added" alerts and the plex.tv watchlist sync. Fixture
// library: Plex sections 1 (movies), 2 (shows) and 10 (YouTube shows); one
// user with sections 1+2, one with 1+2+10, and the unrestricted owner.
const realFetch = globalThis.fetch
const h = createRequestHarness()
const { db } = h
const libraryAccess = h.nodeRequire('../../server/services/libraryAccess/index.js')
const reviewFeed = h.nodeRequire('../../server/services/reviewFeed.js')
const monitorMatcher = h.nodeRequire('../../server/services/monitorMatcher.js')
const watchParty = h.nodeRequire('../../server/services/watchParty/index.js')
const plexDriver = h.nodeRequire('../../server/services/watchParty/plexDriver.js')

const OWNER = '600'
const BASIC = '601' // sections 1 + 2
const TUBE = '602' // sections 1 + 2 + 10

const LIBRARY = [
  // rating_key, section, title, type, tmdb, tvdb, genres — the section-10 twin
  // first, so an unfiltered "first match" would pick it
  ['1002', '10', 'Twin', 'show', '99', null, ['Drama']],
  ['101', '1', 'Movie A', 'movie', '11', null, ['Documentary']],
  ['201', '2', 'Show A', 'show', '21', null, ['Comedy']],
  ['202', '2', 'Twin', 'show', '99', null, ['Drama']],
  ['1001', '10', 'Tube A', 'show', '31', '3100', ['Documentary']],
]
const thumb = (rk) => `/library/metadata/${rk}/thumb/1`
const poster = (rk) => `/api/poster?path=${encodeURIComponent(thumb(rk))}`

function seed() {
  const ins = db.prepare(`INSERT INTO library_items (rating_key, section_id, title, year, type, tmdb_id, tvdb_id, genres, thumb, content_rating, source)
    VALUES (?, ?, ?, 2020, ?, ?, ?, ?, ?, 'TV-14', 'plex')`)
  for (const [rk, sec, title, type, tmdb, tvdb, genres] of LIBRARY) ins.run(rk, sec, title, type, tmdb, tvdb, JSON.stringify(genres), thumb(rk))
  db.prepare('INSERT OR IGNORE INTO known_users (user_id, username) VALUES (?, ?), (?, ?), (?, ?)').run(OWNER, 'owner', BASIC, 'basic', TUBE, 'tube')
  db.setSetting('owner_plex_user_id', OWNER)
  db.upsertKnownUser('boss', 'boss', null, null) // a Diskovarr admin (queue management)
  db.setUserAdmin('boss', true)
  libraryAccess.saveSnapshot(BASIC, 'plex', { role: 'shared', sectionIds: ['1', '2'] })
  libraryAccess.saveSnapshot(TUBE, 'plex', { role: 'shared', sectionIds: ['1', '2', '10'] })
  enforce(true)
}

const enforce = (on) => { db.setSetting('library_access_enforced', on ? '1' : '0'); libraryAccess.invalidate() }
const get = (route, user, extra = {}) => h.call('GET', route, { user, ...extra })
const post = (route, user, body) => h.call('POST', route, { user, body })

// A second app over the API and Watch Together routers whose session can
// carry a linked Jellyfin account (x-test-jf: its user id, no stored token, so
// Jellyfin calls fall back to the admin key).
async function miniApp() {
  const express = h.nodeRequire('../../server/node_modules/express')
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    const jf = req.get('x-test-jf')
    req.session = { plexUser: { id: req.get('x-test-user'), username: 'x', provider: 'plex', token: null, ...(jf ? { jellyfin: { userId: jf, token: null } } : {}) } }
    next()
  })
  app.use('/wp', libraryAccess.middleware, h.nodeRequire('../../server/routes/watchParty.js'))
  app.use('/api', h.api)
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const call = async (user, path, body = {}, headers = {}) => {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...headers }, body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }
  return { call, close: () => new Promise(resolve => server.close(resolve)) }
}

beforeAll(async () => {
  vi.spyOn(h.tmdb, 'getItemDetails').mockResolvedValue(null) // queue enrichment: no TMDB calls
  await h.start()
})
afterAll(async () => { await h.stop() })
beforeEach(() => {
  h.reset()
  for (const t of ['watchlist', 'reviews', 'issues', 'monitors', 'monitor_criteria', 'movie_night_entries']) db.prepare(`DELETE FROM ${t}`).run()
  seed()
})

describe('watchlist', () => {
  beforeEach(() => {
    for (const user of [BASIC, TUBE, OWNER]) for (const k of ['101', '1001', 'ep-77']) db.addToWatchlistDb(user, k)
  })

  it('GET leaves out titles in sections the user cannot access', async () => {
    const keys = async (user) => (await get('/api/watchlist', user)).data.items.map(i => i.ratingKey).sort()
    expect(await keys(BASIC)).toEqual(['101', 'ep-77'])
    expect(await keys(TUBE)).toEqual(['1001', '101', 'ep-77'])
    expect(await keys(OWNER)).toEqual(['1001', '101', 'ep-77'])
    enforce(false)
    expect(await keys(BASIC)).toEqual(['1001', '101', 'ep-77'])
  })

  it('refuses to add a restricted title (403)', async () => {
    const res = await post('/api/watchlist/add', BASIC, { ratingKey: '1001' })
    expect(res.status).toBe(403)
    expect(res.data.restricted).toBe(true)
    expect((await post('/api/watchlist/add', BASIC, { ratingKey: '201' })).status).toBe(200)
    expect((await post('/api/watchlist/add', TUBE, { ratingKey: '1002' })).status).toBe(200)
    expect((await post('/api/watchlist/add', OWNER, { ratingKey: '1002' })).status).toBe(200)
  })

  it('plex.tv sync stores the copy the user can access', async () => {
    h.setResponder((url) => {
      if (url.startsWith('https://discover.provider.plex.tv/')) return Response.json({ MediaContainer: { Metadata: [{ ratingKey: 'w99' }, { ratingKey: 'w31' }] } })
      if (url.startsWith('https://metadata.provider.plex.tv/')) {
        return Response.json({ MediaContainer: { Metadata: [
          { type: 'show', Guid: [{ id: 'tmdb://99' }] }, // in sections 2 and 10
          { type: 'show', Guid: [{ id: 'tmdb://31' }] }, // section 10 only
        ] } })
      }
      return Response.json({})
    })
    const stored = (user) => db.getWatchlistRows(user, 'plex').map(r => r.rating_key).sort()
    db.prepare('DELETE FROM watchlist').run()
    await h.plex.syncPlexTvWatchlist(BASIC, 'TOKEN')
    // The section-2 twin; Tube A has no accessible copy, so it stays mirrored but hidden
    expect(stored(BASIC)).toEqual(['1001', '202'])
    expect((await get('/api/watchlist', BASIC)).data.items.map(i => i.ratingKey)).toEqual(['202'])
    await h.plex.syncPlexTvWatchlist(TUBE, 'TOKEN')
    expect(stored(TUBE)).toEqual(['1001', db.getLibraryItemByTmdbId('99', 'tv', 'plex').rating_key].sort())
  })
})

describe('casting and issues', () => {
  it('refuses to cast a restricted title on either route', async () => {
    for (const route of ['/api/cast/prepare', '/api/cast']) {
      expect((await post(route, BASIC, { ratingKey: '1001', clientId: 'tv' })).status).toBe(403)
      // Allowed titles reach the cast path (no Plex token in the harness → 400)
      expect((await post(route, BASIC, { ratingKey: '101', clientId: 'tv' })).data.error).toMatch(/requires a Plex account/)
      expect((await post(route, TUBE, { ratingKey: '1001', clientId: 'tv' })).data.error).toMatch(/requires a Plex account/)
      expect((await post(route, OWNER, { ratingKey: '1001', clientId: 'tv' })).data.error).toMatch(/requires a Plex account/)
    }
  })

  describe('on Jellyfin', () => {
    const JF_HIDDEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' // a series in a folder BASIC can't access
    const JF_EP = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2' // one of its episodes: not a library row
    const JF_OPEN = 'cccccccccccccccccccccccccccccc03' // a movie in a folder they can
    const dashed = (id) => id.toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
    let app
    beforeAll(async () => { app = await miniApp() })
    afterAll(async () => { await app.close() })
    beforeEach(() => {
      db.setSetting('jellyfin_url', 'http://jf.invalid')
      db.setSetting('jellyfin_api_key', 'ADMINKEY')
      db.setSetting('jellyfin_enabled', '1')
      const ins = db.prepare("INSERT INTO library_items (rating_key, section_id, title, type, source) VALUES (?, ?, ?, ?, 'jellyfin')")
      ins.run(JF_HIDDEN, 'jf_hidden', 'JF Secret', 'show')
      ins.run(JF_OPEN, 'jf_open', 'JF Open', 'movie')
      // The Jellyfin account a session carries must really be linked
      // (requireAuth drops one that isn't): jf-<user> for each caster
      for (const user of [BASIC, OWNER]) {
        db.upsertJellyfinUser(`jf_jf-${user}`, `jf${user}`, null, null)
        db.linkJellyfinAccount(`jf_jf-${user}`, user)
      }
      libraryAccess.saveSnapshot(`jf_jf-${BASIC}`, 'jellyfin', { role: 'jellyfin', sectionIds: ['jf_open'] })
      libraryAccess.invalidate()
      h.setResponder((url) => (url.includes('/Sessions?')
        ? Response.json([{ Id: 'sess1', DeviceName: 'TV', Client: 'Jellyfin', Capabilities: { PlayableMediaTypes: ['Video'] } }])
        : new Response(null, { status: 204 })))
    })
    afterEach(() => {
      for (const user of [BASIC, OWNER]) db.unlinkJellyfinAccount(`jf_jf-${user}`)
      db.setSetting('jellyfin_enabled', '0')
      libraryAccess.invalidate()
    })
    const cast = (route, user, ratingKey) => app.call(user, route, { ratingKey, clientId: 'sess1' }, { 'x-test-jf': `jf-${user}` })
    const played = () => h.outbound.filter(o => o.method === 'POST' && o.url.includes('/Sessions/sess1/Playing'))
      .map(o => new URL(o.url).searchParams.get('ItemIds'))
    const jellyfinCalls = () => h.outbound.filter(o => o.url.startsWith('http://jf.invalid/')).length

    it('refuses a hidden series and any id that is not a library row', async () => {
      for (const route of ['/api/cast/prepare', '/api/cast']) {
        for (const key of [JF_HIDDEN, dashed(JF_HIDDEN), JF_EP, dashed(JF_EP)]) {
          const res = await cast(route, BASIC, key)
          expect([route, key, res.status, res.data.restricted]).toEqual([route, key, 403, true])
        }
      }
      expect(jellyfinCalls()).toBe(0) // nothing reached Jellyfin, on any key
      // A row they can access plays, dashed or not; the owner may still cast an episode id
      expect((await cast('/api/cast', BASIC, dashed(JF_OPEN))).data).toMatchObject({ ok: true, itemIds: [dashed(JF_OPEN)] })
      expect((await cast('/api/cast', OWNER, JF_EP)).data).toMatchObject({ ok: true, itemIds: [JF_EP] })
      expect(played()).toEqual([dashed(JF_OPEN), JF_EP])
      enforce(false)
      expect((await cast('/api/cast', BASIC, JF_EP)).data).toMatchObject({ ok: true, itemIds: [JF_EP] })
    })

    it('refuses a restricted host a Watch Together party on a non-row id before any Jellyfin call', async () => {
      const res = await app.call(BASIC, '/wp', { ratingKey: JF_EP, userIds: [] }, { 'x-test-jf': 'jf-basic' })
      expect([res.status, res.data.error]).toEqual([403, expect.stringMatching(/library you don't have access to/)])
      expect((await app.call(BASIC, '/wp', { ratingKey: dashed(JF_HIDDEN), userIds: [] }, { 'x-test-jf': 'jf-basic' })).status).toBe(403)
      expect(jellyfinCalls()).toBe(0)
    })
  })

  it('refuses an issue report for a restricted title', async () => {
    const report = (user, ratingKey) => post('/api/issues', user, { ratingKey, title: 'X', mediaType: 'tv', description: 'broken' })
    expect((await report(BASIC, '1001')).status).toBe(403)
    expect((await report(BASIC, '201')).status).toBe(200)
    expect((await report(BASIC, 'episode-5')).status).toBe(200) // not a library row
    expect((await report(TUBE, '1001')).status).toBe(200)
    expect((await report(OWNER, '1001')).status).toBe(200)
  })
})

describe('request queue availability', () => {
  it('shows a title only in a hidden section as requested to its requester', async () => {
    const add = (user, tmdbId, extra = {}) => db.addDiscoverRequestWithStatus(user, tmdbId, 'tv', 'Tube A', 'sonarr', 1, 'approved', null, null, extra)
    const basicTmdb = add(BASIC, 31)
    const basicTvdb = add(BASIC, 0, { tvdbId: 3100 })
    const tubeTmdb = add(TUBE, 31)
    const ownerTmdb = add(OWNER, 31)
    const basicShow = add(BASIC, 21)
    const statuses = (data) => Object.fromEntries(data.requests.map(r => [r.id, r.displayStatus]))

    expect(statuses((await get('/api/queue', BASIC)).data)).toEqual({
      [basicTmdb]: 'requested', [basicTvdb]: 'requested', [basicShow]: 'available',
    })
    expect(statuses((await get('/api/queue', TUBE)).data)).toEqual({ [tubeTmdb]: 'available' })
    // An admin sees each row as its requester would
    const all = (await get('/api/queue', 'boss', { role: 'admin' })).data
    expect(statuses(all)).toMatchObject({ [basicTmdb]: 'requested', [tubeTmdb]: 'available', [ownerTmdb]: 'available' })
    const available = (await get('/api/queue?status=available', 'boss', { role: 'admin' })).data.requests.map(r => r.id).sort()
    expect(available).toEqual([tubeTmdb, ownerTmdb, basicShow].sort())

    // Editing: available for TUBE; for BASIC it is a restricted title instead
    expect((await h.call('PUT', `/api/queue/${tubeTmdb}`, { user: TUBE, body: {} })).status).toBe(400)
    expect((await h.call('PUT', `/api/queue/${basicTmdb}`, { user: BASIC, body: {} })).status).toBe(409)

    enforce(false)
    expect(statuses((await get('/api/queue', BASIC)).data)[basicTmdb]).toBe('available')
  })
})

describe('Notify Me (explore/follow)', () => {
  it('refuses to follow a title held only in a section the user cannot access', async () => {
    db.addDiscoverRequestWithStatus(TUBE, 31, 'tv', 'Tube A', 'sonarr', 1, 'approved', null, null, {})
    db.addDiscoverRequestWithStatus(TUBE, 99, 'tv', 'Twin', 'sonarr', 1, 'approved', null, null, {})
    const follow = (user, tmdbId) => post('/api/explore/follow', user, { tmdbId, mediaType: 'tv', title: 'X' })
    const rows = (user) => db.prepare('SELECT tmdb_id FROM discover_requests WHERE user_id = ? AND is_follow = 1').all(user).map(r => r.tmdb_id)

    const refused = await follow(BASIC, 31)
    expect([refused.status, refused.data.restricted]).toEqual([409, true])
    expect(refused.data.requestable).toBeUndefined() // the client toasts instead of offering a request
    expect(rows(BASIC)).toEqual([])
    expect((await follow(BASIC, 99)).status).toBe(200) // a section-2 copy
    expect((await follow(OWNER, 31)).status).toBe(200)
    expect(rows(BASIC)).toEqual([99])
    enforce(false)
    expect((await follow(BASIC, 31)).status).toBe(200)
  })
})

describe('reviews', () => {
  let ids
  beforeEach(() => {
    const ins = db.prepare('INSERT INTO reviews (user_id, media_type, tmdb_id, title, rating, review_text, watched_date, created_at) VALUES (?,?,?,?,?,?,?,?)')
    ids = {
      tube: Number(ins.run(TUBE, 'tv', 31, 'Tube A', 4, 'great channel', 1, 300).lastInsertRowid),
      twin: Number(ins.run(TUBE, 'tv', 99, 'Twin', 3, 'twice', 1, 200).lastInsertRowid),
      movie: Number(ins.run(TUBE, 'movie', 11, 'Movie A', 5, 'classic', 1, 100).lastInsertRowid),
    }
    reviewFeed.invalidateFeedCache()
  })
  const art = (r) => [r.posterUrl, r.contentRating]

  it('feed: no library poster or rating for a title the viewer cannot access, review text kept', async () => {
    const feed = async (user, q = '') => Object.fromEntries((await get(`/api/reviews/feed${q}`, user)).data.reviews.map(r => [r.id, r]))
    const basic = await feed(BASIC)
    expect(art(basic[ids.tube])).toEqual([null, ''])
    expect(basic[ids.tube].reviewText).toBe('great channel')
    expect(art(basic[ids.twin])).toEqual([poster('202'), 'TV-14']) // the copy they can see
    expect(art(basic[ids.movie])).toEqual([poster('101'), 'TV-14'])
    // The shared feed cache was not altered by the restricted viewer
    expect(art((await feed(TUBE))[ids.tube])).toEqual([poster('1001'), 'TV-14'])
    expect(art((await feed(OWNER))[ids.tube])).toEqual([poster('1001'), 'TV-14'])
    db.prepare('INSERT INTO user_follows (follower_id, followee_id) VALUES (?, ?)').run(BASIC, TUBE)
    expect(art((await feed(BASIC, '?followedOnly=true'))[ids.tube])).toEqual([null, ''])
  })

  it('media tab, single review and profile reviews resolve per viewer', async () => {
    expect(art((await get('/api/reviews/media/tv/31', BASIC)).data.reviews[0])).toEqual([null, ''])
    expect(art((await get('/api/reviews/media/tv/31', TUBE)).data.reviews[0])).toEqual([poster('1001'), 'TV-14'])
    expect(art((await get(`/api/reviews/${ids.tube}`, BASIC)).data)).toEqual([null, ''])
    expect((await get(`/api/reviews/${ids.tube}`, BASIC)).data.reviewText).toBe('great channel')
    expect(art((await get(`/api/reviews/${ids.tube}`, OWNER)).data)).toEqual([poster('1001'), 'TV-14'])
    const profile = async (user) => Object.fromEntries((await get(`/api/users/${TUBE}/reviews`, user)).data.reviews.map(r => [r.id, r]))
    expect(art((await profile(BASIC))[ids.tube])).toEqual([null, ''])
    expect(art((await profile(BASIC))[ids.twin])).toEqual([poster('202'), 'TV-14'])
    expect(art((await profile(TUBE))[ids.tube])).toEqual([poster('1001'), 'TV-14'])
  })
})

describe('Movie Night', () => {
  let group
  beforeEach(() => {
    group = db.createMovieNightGroup({ name: 'Friday', mode: 'rolling', createdBy: TUBE, rotateMode: 1 })
    db.addMovieNightMember(group.id, BASIC)
    db.addMovieNightMember(group.id, OWNER)
  })
  const addEntry = (user, body) => post(`/api/movie-night/groups/${group.id}/entries`, user, { mediaType: 'tv', ...body })

  it('refuses to nominate a title the adder cannot access', async () => {
    expect((await addEntry(BASIC, { ratingKey: '1001', tmdbId: 31, title: 'Tube A' })).status).toBe(403)
    // Known only by TMDB id, but the library holds it only in section 10
    expect((await addEntry(BASIC, { tmdbId: 31, title: 'Tube A' })).status).toBe(403)
    expect((await addEntry(BASIC, { tmdbId: 99, title: 'Twin' })).status).toBe(201) // section-2 copy
    expect((await addEntry(BASIC, { tmdbId: 4242, title: 'Not in the library' })).status).toBe(201)
    expect((await addEntry(OWNER, { ratingKey: '1001', tmdbId: 31, title: 'Tube A' })).status).toBe(201)
  })

  it('masks entries a viewer cannot access and drops their notification poster', async () => {
    const added = await addEntry(TUBE, { ratingKey: '1001', tmdbId: 31, title: 'Tube A', thumb: poster('1001') })
    expect(added.status).toBe(201)
    expect(added.data.entry).toMatchObject({ ratingKey: '1001', thumb: poster('1001') })
    expect(added.data.entry.restricted).toBeUndefined()

    const entries = async (user) => (await get(`/api/movie-night/groups/${group.id}/entries`, user)).data.entries
    expect((await entries(BASIC))[0]).toMatchObject({ title: 'Tube A', ratingKey: null, thumb: null, restricted: true })
    expect((await entries(OWNER))[0]).toMatchObject({ ratingKey: '1001', thumb: poster('1001') })
    expect((await entries(OWNER))[0].restricted).toBeUndefined()

    const groupFor = async (user) => (await get('/api/movie-night/groups', user)).data.groups.find(g => g.id === group.id)
    expect((await groupFor(BASIC)).posterCollage).toEqual([])
    expect((await groupFor(BASIC)).nextUp).toMatchObject({ thumb: null, restricted: true })
    expect((await groupFor(TUBE)).posterCollage).toEqual([poster('1001')])
    expect((await get(`/api/movie-night/groups/${group.id}/next`, BASIC)).data.entry).toMatchObject({ thumb: null, restricted: true })
    const rotated = (await post(`/api/movie-night/groups/${group.id}/rotate`, TUBE, {})).data.next.entry
    expect(rotated.thumb).toBe(poster('1001'))

    const notified = (user) => db.prepare("SELECT data FROM notifications WHERE type = 'movie_night_added' AND user_id = ?").all(user)
      .map(n => JSON.parse(n.data).thumb)
    expect(notified(BASIC)).toEqual([null])
    expect(notified(OWNER)).toEqual([poster('1001')])
    expect(h.queued('movie_night_added').find(q => q.user_id === BASIC).payload.posterUrl).toBeNull()

    enforce(false)
    expect((await entries(BASIC))[0]).toMatchObject({ ratingKey: '1001', thumb: poster('1001') })
  })
})

describe('Watch Together', () => {
  const realResolve = plexDriver.resolveItem
  beforeAll(() => {
    plexDriver.resolveItem = async (rk) => ({ ratingKey: `ep-${rk}`, title: 'Tube A', subtitle: 'S1E1', thumb: thumb(rk), durationMs: 1000 })
  })
  afterAll(() => { plexDriver.resolveItem = realResolve })
  const memberIds = (party) => db.getWatchPartyMembers(party.id).map(m => m.user_id).sort()

  it('refuses a host without access and skips invitees without it', async () => {
    await expect(watchParty.createParty({ hostId: BASIC, ratingKey: '1001', userIds: [] })).rejects.toMatchObject({ status: 403 })
    const { party, skipped } = await watchParty.createParty({ hostId: TUBE, ratingKey: '1001', userIds: [BASIC, OWNER] })
    expect([party.rating_key, party.library_key, party.section_id]).toEqual(['ep-1001', '1001', '10'])
    expect(skipped).toEqual([{ userId: BASIC, username: 'basic' }])
    expect(memberIds(party)).toEqual([OWNER, TUBE].sort())
    expect(watchParty.invite(party, [BASIC]).skipped.map(s => s.userId)).toEqual([BASIC])
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'watch_party_invite' AND user_id = ?").get(BASIC).n).toBe(0)

    // Someone who lost access after being invited can't pick a TV or join
    db.addWatchPartyMember(party.id, BASIC)
    await expect(watchParty.setDevice(party, BASIC, 'tv-1')).rejects.toMatchObject({ status: 403 })

    // Everyone may join a party for a title in a section they all share
    const shared = await watchParty.createParty({ hostId: BASIC, ratingKey: '201', userIds: [TUBE, OWNER] })
    expect(shared.skipped).toEqual([])
    expect(memberIds(shared.party)).toEqual([BASIC, OWNER, TUBE].sort())
  })

  it('reports skipped invitees in the route response', async () => {
    const express = h.nodeRequire('../../server/node_modules/express')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.session = { plexUser: { id: req.get('x-test-user'), username: 'x', token: null } }; next() })
    app.use(libraryAccess.middleware)
    app.use('/wp', h.nodeRequire('../../server/routes/watchParty.js'))
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const call = async (user, path, body) => {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body),
      })
      return { status: res.status, data: await res.json() }
    }
    try {
      expect((await call(BASIC, '/wp', { ratingKey: '1001', userIds: [] })).status).toBe(403)
      const created = await call(TUBE, '/wp', { ratingKey: '1001', userIds: [BASIC] })
      expect(created.status).toBe(201)
      expect(created.data.skipped).toEqual([{ userId: BASIC, username: 'basic' }])
      const invited = await call(TUBE, `/wp/${created.data.party.id}/invite`, { userIds: [BASIC, OWNER] })
      expect(invited.data.skipped.map(s => s.userId)).toEqual([BASIC])
      expect(invited.data.party.members.map(m => m.userId).sort()).toEqual([OWNER, TUBE].sort())
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  describe('keys and members that the library cannot place', () => {
    let app
    beforeAll(async () => { app = await miniApp() })
    afterAll(async () => { await app.close() })
    const invited = (user) => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'watch_party_invite' AND user_id = ?").get(user).n

    it('a key that is not a library row: restricted hosts refused, restricted invitees skipped', async () => {
      // '5555' is an episode key: no section to check against
      await expect(watchParty.createParty({ hostId: TUBE, ratingKey: '5555', userIds: [] })).rejects.toMatchObject({ status: 403 })
      const { party, skipped } = await watchParty.createParty({ hostId: OWNER, ratingKey: '5555', userIds: [BASIC, TUBE] })
      expect([party.library_key, party.section_id]).toEqual(['5555', null])
      expect(skipped.map(s => s.userId).sort()).toEqual([BASIC, TUBE].sort())
      expect(memberIds(party)).toEqual([OWNER])
      expect(invited(BASIC) + invited(TUBE)).toBe(0)

      // Someone on the roster anyway can't pick a TV
      db.addWatchPartyMember(party.id, BASIC)
      const device = await app.call(BASIC, `/wp/${party.id}/device`, { clientId: 'tv-1' })
      expect([device.status, device.data.error]).toEqual([403, expect.stringMatching(/library you don't have access to/)])

      expect((await app.call(OWNER, '/wp', { ratingKey: '../5555', userIds: [] })).data).toEqual({ error: 'Invalid ratingKey' })
      enforce(false)
      expect(watchParty.invite(party, [TUBE]).skipped).toEqual([])
    })

    describe('starting and joining', () => {
      const real = {}
      let started
      beforeAll(() => {
        for (const k of ['playerFor', 'pollTimeline', 'sendCommand', 'load']) real[k] = plexDriver[k]
        plexDriver.playerFor = async (m) => { started.push(m.user_id); return { clientId: m.client_id } }
        plexDriver.pollTimeline = async () => ({ ratingKey: 'ep-1001', state: 'playing', time: 0 })
        plexDriver.sendCommand = async () => true
        plexDriver.load = async () => {}
      })
      afterAll(() => { Object.assign(plexDriver, real) })
      beforeEach(() => { started = [] })
      const ready = (party, ...users) => {
        for (const u of users) db.setWatchPartyMemberDevice(party.id, u, { clientId: `tv-${u}`, clientName: 'TV', controlBase: 'http://tv' })
      }
      const cut = (user) => { libraryAccess.saveSnapshot(user, 'plex', { role: 'shared', sectionIds: ['1'] }); libraryAccess.invalidate() }

      it('startParty leaves out a ready member who lost access, and join refuses them', async () => {
        const { party } = await watchParty.createParty({ hostId: OWNER, ratingKey: '1001', userIds: [TUBE] })
        ready(party, OWNER, TUBE)
        cut(TUBE)
        try {
          await watchParty.startParty(db.getWatchParty(party.id))
          expect(started).toEqual([OWNER])
          const join = await app.call(TUBE, `/wp/${party.id}/join`)
          expect([join.status, join.data.error]).toEqual([403, expect.stringMatching(/library you don't have access to/)])
          expect(started).toEqual([OWNER])
        } finally {
          watchParty.endParty(party.id)
        }
      })

      it('refuses to start for a host who lost access', async () => {
        const { party } = await watchParty.createParty({ hostId: TUBE, ratingKey: '1001', userIds: [OWNER] })
        ready(party, TUBE, OWNER)
        cut(TUBE)
        await expect(watchParty.startParty(db.getWatchParty(party.id))).rejects.toMatchObject({ status: 403 })
        expect([db.getWatchParty(party.id).status, started]).toEqual(['lobby', []])
      })
    })
  })
})

describe('monitor "available to request" alerts', () => {
  it('skip owners when the library holds the title only in a section they cannot access', async () => {
    const owners = {}
    for (const user of [BASIC, TUBE, OWNER]) {
      const id = db.createMonitor({ userId: user, name: `req-${user}`, enabled: true, matchMode: 'ANY', notifyPlex: false, notifyRequestable: true })
      db.createCriteria({ monitorId: id, type: 'genre', entityName: 'Documentary' })
      owners[id] = user
    }
    const alerted = async (id) => (await monitorMatcher.evaluateContent(
      monitorMatcher.buildContentFromTmdb({ id, media_type: 'tv', name: 'X', genres: ['Documentary'] }), 'tmdb',
    )).map(m => owners[m.monitor.id]).sort()
    expect(await alerted(31)).toEqual([OWNER, TUBE].sort()) // section 10 only
    expect(await alerted(99)).toEqual([BASIC, OWNER, TUBE].sort()) // also in section 2
    expect(await alerted(4242)).toEqual([BASIC, OWNER, TUBE].sort()) // not in the library
    enforce(false)
    expect(await alerted(31)).toEqual([BASIC, OWNER, TUBE].sort())
  })
})

describe('monitor "added to library" alerts', () => {
  it('only reach monitor owners who can access the section', async () => {
    const owners = {}
    for (const user of [BASIC, TUBE, OWNER]) {
      const id = db.createMonitor({ userId: user, name: `docs-${user}`, enabled: true, matchMode: 'ANY', notifyPlex: true, notifyRequestable: false })
      db.createCriteria({ monitorId: id, type: 'genre', entityName: 'Documentary' })
      owners[id] = user
    }
    const alerted = async (rk) => (await monitorMatcher.evaluateContent(
      monitorMatcher.buildContentFromLibrary(db.getLibraryItemByKey(rk)), 'plex',
    )).map(m => owners[m.monitor.id]).sort()
    expect(await alerted('1001')).toEqual([OWNER, TUBE].sort())
    expect(await alerted('101')).toEqual([BASIC, OWNER, TUBE].sort())
    enforce(false)
    expect(await alerted('1001')).toEqual([BASIC, OWNER, TUBE].sort())
  })
})
