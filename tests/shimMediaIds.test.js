import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Overseerr shim (/api/v1) media ids: media.id is the TMDB id moved into a range
// of its own (movie 1e9 + tmdb, tv 1.5e9 + tmdb) so Riven 0.x, which stores it
// and may send it to DELETE /request/:id, can't hit an unrelated request. Bare
// TMDB ids keep working on the /media routes (Agregarr), and the DUMB bridge key
// can only delete requests its own app filed. Also covers GET /request's take cap.

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-shim-media-ids-'))

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const logger = nodeRequire('../server/services/logger.js')
const shim = nodeRequire('../server/routes/overseerrShim.js')
const ids = nodeRequire('../server/services/shimRequests.js')
const { Permission } = nodeRequire('../server/services/shimPolicy.js')

vi.spyOn(logger, 'info').mockImplementation(() => {})
const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const compat = db.createApiApp('Compat', 'compat')
const dumb = db.createApiApp('DUMB', 'dumb')
const dumbBot = db.createServiceUser(dumb.id, { username: 'Riven bot' })
const requester = db.createServiceUser(compat.id, { username: 'Requester', permissions: Permission.REQUEST })
const manager = db.createServiceUser(compat.id, { username: 'Manager', permissions: Permission.MANAGE_REQUESTS })
const limited = db.createServiceUser(compat.id, { username: 'Limited' })
for (const [id, name] of [['u-alice', 'Alice'], ['u-bob', 'Bob']]) db.upsertKnownUser(id, name, null, null)

const MOVIE = 1_000_000_000
const TV = 1_500_000_000

function req(userId, tmdbId, mediaType, status = 'approved', extra = {}) {
  return Number(db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, `T${tmdbId}`, 'none', 1, status, null, null, extra))
}
function inLibrary(tmdbId, type, ratingKey = `rk-${type}-${tmdbId}`) {
  db.prepare('INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id) VALUES (?, ?, ?, ?, ?)')
    .run(ratingKey, '1', `L${tmdbId}`, type, String(tmdbId))
}
const row = id => db.prepare('SELECT * FROM discover_requests WHERE id = ?').get(id)

// 3000 is both a movie and a show
const movie3000 = req('u-alice', 3000, 'movie')
const tv3000 = req('u-bob', 3000, 'tv')

// ── HTTP harness (ephemeral port, no outbound network) ────────────────────────

const realFetch = globalThis.fetch
let server, base

beforeAll(async () => {
  globalThis.fetch = vi.fn(async url => { throw new Error(`unexpected outbound fetch: ${url}`) })
  const app = express()
  app.use(express.json())
  app.use('/api/v1', shim)
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}/api/v1`
  process.emit('diskovarr:checkFulfilled') // drop the shim's library-id cache
})

afterAll(() => {
  server?.close()
  globalThis.fetch = realFetch
})

async function call(method, route, { key = compat.api_key, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', 'X-Api-Key': key, ...headers }
  const res = await realFetch(base + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, data }
}

// ── Encoding ──────────────────────────────────────────────────────────────────

describe('media id encoding', () => {
  it('round-trips movie and tv ids into disjoint ranges', () => {
    expect(ids.encodeMediaId(603, 'movie')).toBe(MOVIE + 603)
    expect(ids.encodeMediaId(603, 'tv')).toBe(TV + 603)
    expect(ids.encodeMediaId('1399', 'show')).toBe(TV + 1399)
    expect(ids.decodeMediaId(MOVIE + 603)).toEqual({ tmdbId: 603, mediaType: 'movie' })
    expect(ids.decodeMediaId(String(TV + 603))).toEqual({ tmdbId: 603, mediaType: 'tv' })
    expect(ids.decodeMediaId(ids.encodeMediaId(499_999_999, 'movie'))).toEqual({ tmdbId: 499_999_999, mediaType: 'movie' })
    expect(ids.decodeMediaId(ids.encodeMediaId(499_999_999, 'tv'))).toEqual({ tmdbId: 499_999_999, mediaType: 'tv' })
  })

  it('refuses TMDB ids outside 0 < tmdb < 500M and unknown types', () => {
    for (const bad of [0, -5, 500_000_000, 1.5, 'abc', null]) expect(ids.encodeMediaId(bad, 'movie')).toBeNull()
    expect(ids.encodeMediaId(603, 'person')).toBeNull()
  })

  it('decodes nothing below 1e9, at the zero points, or at/after 2e9', () => {
    for (const plain of [1, 603, 3461, 1_792_136, 999_999_999, MOVIE, TV, 2_000_000_000, 2_147_483_647, 1e12, '1000000603x', 'abc', -MOVIE]) {
      expect(ids.decodeMediaId(plain)).toBeNull()
    }
  })

  it('falls back to a non-decodable id when a TMDB id cannot be encoded', () => {
    expect(ids.mediaIdFor(603, 'movie')).toBe(MOVIE + 603)
    expect(ids.mediaIdFor(600_000_000, 'movie')).toBe(600_000_000)
    expect(ids.mediaIdFor(1_200_000_000, 'movie')).toBe(0)
    expect(ids.mediaIdFor('nope', 'tv')).toBe(0)
    for (const n of [1, 999_999_999, MOVIE, 1_700_000_000, 2_147_483_647]) {
      const folded = ids.foldMediaId(n)
      expect(folded).toBeGreaterThanOrEqual(1)
      expect(folded).toBeLessThan(MOVIE)
    }
    expect(ids.foldMediaId(0)).toBe(1)
  })
})

// ── Emitted ids ───────────────────────────────────────────────────────────────

describe('emitted media ids', () => {
  it('request DTOs carry the encoded media id and keep tmdbId', async () => {
    const { data } = await call('GET', `/request/${tv3000}`)
    expect(data.media).toMatchObject({ id: TV + 3000, tmdbId: 3000, mediaType: 'tv' })
    const list = (await call('GET', '/request?take=100')).data.results
    expect(list.find(r => r.id === movie3000).media.id).toBe(MOVIE + 3000)
  })

  it('GET /media lists one distinct id per title, even for a shared TMDB id', async () => {
    const { data } = await call('GET', '/media?take=200')
    const shared = data.results.filter(m => m.tmdbId === 3000)
    expect(shared.map(m => m.id).sort()).toEqual([MOVIE + 3000, TV + 3000])
  })

  it('POST /request answers with encoded ids, including the early exits', async () => {
    db.setTmdbCache(4100, 'movie', { title: 'Fresh' })
    const created = await call('POST', '/request', { body: { mediaId: 4100, mediaType: 'movie' } })
    expect(created.status).toBe(201)
    expect(created.data.media).toMatchObject({ id: MOVIE + 4100, tmdbId: 4100 })

    const duplicate = await call('POST', '/request', { body: { mediaId: 4100, mediaType: 'movie' } })
    expect(duplicate.status).toBe(409)
    expect(duplicate.data.media.id).toBe(MOVIE + 4100)

    // Unknown to TMDB (no cache, no key): skipped with a synthetic 201
    const unknown = await call('POST', '/request', { body: { mediaId: 4101, mediaType: 'tv' } })
    expect(unknown.data).toMatchObject({ id: 0, media: { id: TV + 4101, tmdbId: 4101 } })

    // Already in the library
    db.setTmdbCache(4102, 'movie', { title: 'Owned' })
    inLibrary(4102, 'movie')
    process.emit('diskovarr:checkFulfilled')
    const owned = await call('POST', '/request', { body: { mediaId: 4102, mediaType: 'movie' } })
    expect(owned.data).toMatchObject({ id: 0, status: 5, media: { id: MOVIE + 4102, status: 5 } })

    // Over the requester's movie limit
    db.setUserRequestLimitOverride(limited.user_id, { overrideEnabled: true, movieLimit: 1, movieWindowDays: 7 })
    req(limited.user_id, 4103, 'movie')
    db.setTmdbCache(4104, 'movie', { title: 'Over limit' })
    const dropped = await call('POST', '/request', { key: limited.api_key, body: { mediaId: 4104, mediaType: 'movie' } })
    expect(dropped.data).toMatchObject({ id: 0, media: { id: MOVIE + 4104, tmdbId: 4104 } })
  })
})

// ── /media/:id routes ─────────────────────────────────────────────────────────

describe('/media/:id with encoded and bare ids', () => {
  it('GET resolves an encoded id exactly, without a hint, even for a shared TMDB id', async () => {
    const asTv = await call('GET', `/media/${TV + 3000}`)
    expect(asTv.status).toBe(200)
    expect(asTv.data).toMatchObject({ id: TV + 3000, tmdbId: 3000, mediaType: 'tv' })
    expect(asTv.data.requests.map(r => r.id)).toEqual([tv3000])
    // The encoded type beats a contradicting hint
    expect((await call('GET', `/media/${MOVIE + 3000}?mediaType=tv`)).data.mediaType).toBe('movie')
    expect((await call('GET', `/media/${MOVIE + 987654}`)).status).toBe(404)
  })

  it('GET keeps accepting bare TMDB ids (Agregarr) and answers with the encoded id', async () => {
    const { status, data } = await call('GET', '/media/3000?mediaType=movie')
    expect(status).toBe(200)
    expect(data).toMatchObject({ id: MOVIE + 3000, tmdbId: 3000, mediaType: 'movie' })
    expect((await call('GET', '/media/4100')).data).toMatchObject({ id: MOVIE + 4100, tmdbId: 4100 })
  })

  it('rejects ids in the reserved range that do not decode', async () => {
    for (const bad of [MOVIE, TV, 2_000_000_000, 2_100_000_000]) {
      expect((await call('GET', `/media/${bad}`)).status).toBe(400)
      expect((await call('DELETE', `/media/${bad}`)).status).toBe(400)
    }
  })

  it('marks an encoded title available without a hint, leaving the other type alone', async () => {
    const movie = req('u-alice', 3100, 'movie')
    const tv = req('u-bob', 3100, 'tv')
    expect((await call('POST', '/media/3100/available')).status).toBe(409)
    const res = await call('POST', `/media/${TV + 3100}/available`)
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ id: TV + 3100, mediaType: 'tv', tmdbId: 3100, status: 5 })
    expect(row(tv).notified_available_at).not.toBeNull()
    expect(row(movie).notified_available_at).toBeNull()

    const put = await call('PUT', `/media/${MOVIE + 3100}/available`)
    expect(put.status).toBe(200)
    expect(put.data.media).toMatchObject({ id: MOVIE + 3100, mediaType: 'movie' })
    expect(row(movie).notified_available_at).not.toBeNull()
  })

  it('reports other statuses with the encoded id', async () => {
    const { data } = await call('POST', `/media/${MOVIE + 3000}/processing`)
    expect(data).toEqual({ id: MOVIE + 3000, mediaType: 'movie', tmdbId: 3000, status: 3 })
  })

  it('DELETE removes only the encoded type', async () => {
    const movie = req('u-alice', 3200, 'movie', 'pending')
    const tv = req('u-bob', 3200, 'tv', 'pending')
    expect((await call('DELETE', `/media/${MOVIE + 3200}`)).status).toBe(200)
    expect(row(movie)).toBeUndefined()
    expect(row(tv)).toBeDefined()
  })
})

// ── DELETE /request/:id ───────────────────────────────────────────────────────

describe('DELETE /request/:id', () => {
  it('reads an encoded media id as that title: every request and follower of that type goes', async () => {
    const alice = req('u-alice', 3300, 'movie')
    const bob = req('u-bob', 3300, 'movie', 'pending')
    const follower = req('u-bob', 3300, 'movie', 'approved', { isFollow: true })
    const otherType = req('u-alice', 3300, 'tv')
    const res = await call('DELETE', `/request/${MOVIE + 3300}`, { key: dumb.api_key })
    expect(res.status).toBe(204)
    expect([alice, bob, follower].map(row)).toEqual([undefined, undefined, undefined])
    expect(row(otherType)).toBeDefined()
    // Nothing left for that title
    expect((await call('DELETE', `/request/${MOVIE + 3300}`, { key: dumb.api_key })).status).toBe(404)
  })

  it('needs MANAGE_REQUESTS for an encoded media id', async () => {
    const own = req(requester.user_id, 3400, 'movie', 'pending')
    expect((await call('DELETE', `/request/${MOVIE + 3400}`, { key: requester.api_key })).status).toBe(403)
    expect(row(own)).toBeDefined()
    expect((await call('DELETE', `/request/${MOVIE + 3400}`, { key: manager.api_key })).status).toBe(204)
    expect(row(own)).toBeUndefined()
  })

  it('never lets the DUMB bridge delete a request filed by someone else (a bare TMDB id from Riven)', async () => {
    const victim = req('u-alice', 3500, 'movie')
    warn.mockClear()
    // Riven 0.x stored overseerr_id = TMDB id; this one happens to equal victim's request id
    const res = await call('DELETE', `/request/${victim}`, { key: dumb.api_key })
    expect(res.status).toBe(404)
    expect(row(victim)).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`ignored DELETE /request/${victim}`))
    expect((await call('DELETE', '/request/987654', { key: dumb.api_key })).status).toBe(404)
  })

  it('lets the DUMB bridge delete requests its own app filed', async () => {
    const viaApp = req(`__app_${dumb.id}__`, 3600, 'movie')
    const viaBot = req(dumbBot.user_id, 3601, 'movie')
    expect((await call('DELETE', `/request/${viaApp}`, { key: dumb.api_key })).status).toBe(200)
    expect((await call('DELETE', `/request/${viaBot}`, { key: dumb.api_key })).status).toBe(200)
    expect(row(viaApp)).toBeUndefined()
    expect(row(viaBot)).toBeUndefined()
    // The compat app's own virtual user is not the DUMB app's
    const compatOwned = req(`__app_${compat.id}__`, 3602, 'movie')
    expect((await call('DELETE', `/request/${compatOwned}`, { key: dumb.api_key })).status).toBe(404)
    expect(row(compatOwned)).toBeDefined()
  })

  it('keeps plain request-id semantics for other app keys', async () => {
    const victim = req('u-alice', 3700, 'movie')
    expect((await call('DELETE', `/request/${victim}`)).status).toBe(200)
    expect(row(victim)).toBeUndefined()
  })
})

// ── Issues ────────────────────────────────────────────────────────────────────

// The shim's issue hash, to pick a Jellyfin GUID whose raw hash lands at/after 1e9
function fnv(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h & 0x7fffffff
}

describe('issue media ids', () => {
  it('POST /issue with an encoded id files the library title and returns the same id', async () => {
    inLibrary(3800, 'movie', '98765')
    const res = await call('POST', '/issue', { body: { mediaId: MOVIE + 3800, issueType: 1, message: 'no audio' } })
    expect(res.status).toBe(201)
    expect(res.data.media.id).toBe(MOVIE + 3800)
    expect(db.getIssueById(res.data.id)).toMatchObject({ rating_key: '98765', media_type: 'movie', title: 'L3800' })
  })

  // A library movie whose Plex rating key equals the TMDB id of an unrelated show
  it('POST /issue with an encoded id for a title outside the library files and returns that id', async () => {
    inLibrary(777, 'movie', '3801')
    const res = await call('POST', '/issue', { body: { mediaId: TV + 3801, mediaType: 'movie', message: 'x' } })
    expect(res.status).toBe(201)
    expect(db.getIssueById(res.data.id)).toMatchObject({ rating_key: String(TV + 3801), media_type: 'tv' })
    expect(res.data.media).toMatchObject({ id: TV + 3801, mediaType: 'tv' })
    expect((await call('GET', `/issue/${res.data.id}`)).data.media.id).toBe(TV + 3801)
  })

  it('POST /issue with a bare TMDB id files the same way under the body\'s type', async () => {
    const outside = await call('POST', '/issue', { body: { mediaId: 3801, mediaType: 'tv', message: 'x' } })
    expect(db.getIssueById(outside.data.id)).toMatchObject({ rating_key: String(TV + 3801), media_type: 'tv' })
    expect(outside.data.media).toMatchObject({ id: TV + 3801, mediaType: 'tv' })
    const owned = await call('POST', '/issue', { body: { mediaId: 3800, mediaType: 'movie', message: 'x' } })
    expect(db.getIssueById(owned.data.id)).toMatchObject({ rating_key: '98765', media_type: 'movie' })
    expect(owned.data.media.id).toBe(MOVIE + 3800)
  })

  it('a legacy shim issue holding a bare TMDB id ignores a library item of the other type', async () => {
    // Filed before encoded ids: rating_key '3801' is the show's TMDB id, not the movie's key
    const legacy = Number(db.createIssue({ userId: 'u-alice', ratingKey: '3801', title: 'Old show issue', mediaType: 'tv', scope: 'video' }))
    const res = await call('GET', `/issue/${legacy}`)
    expect(res.data.media).toMatchObject({ id: 3801, mediaType: 'tv' })
    // The same key on a movie issue is that library movie
    const movie = Number(db.createIssue({ userId: 'u-alice', ratingKey: '3801', title: 'L777', mediaType: 'movie', scope: 'video' }))
    expect((await call('GET', `/issue/${movie}`)).data.media.id).toBe(MOVIE + 777)
  })

  it('issue ids that are not library titles stay below the encoded range', async () => {
    let guid = ''
    for (let i = 0; !guid; i++) if (fnv(`f00dfeed${i}`) >= MOVIE) guid = `f00dfeed${i}`
    const issueId = Number(db.createIssue({ userId: 'u-alice', ratingKey: guid, title: 'Jellyfin film', mediaType: 'movie', scope: 'video' }))
    const first = (await call('GET', `/issue/${issueId}`)).data.media.id
    expect(first).toBeGreaterThanOrEqual(1)
    expect(first).toBeLessThan(MOVIE)
    expect(ids.decodeMediaId(first)).toBeNull()
    expect((await call('GET', `/issue/${issueId}`)).data.media.id).toBe(first)
    const plex = Number(db.createIssue({ userId: 'u-alice', ratingKey: '55555', title: 'Plex film', mediaType: 'movie', scope: 'video' }))
    expect((await call('GET', `/issue/${plex}`)).data.media.id).toBe(55555)
  })
})

// ── GET /request page size ────────────────────────────────────────────────────

describe('GET /request take cap', () => {
  it('serves Riven\'s take=10000 in one page, filtered and counted in SQL', async () => {
    const insert = db.prepare("INSERT INTO discover_requests (user_id, tmdb_id, media_type, title, service, seasons_count, requested_at, status) VALUES ('u-bob', ?, 'movie', 'Bulk', 'none', 1, ?, ?)")
    for (let i = 0; i < 1400; i++) insert.run(100_000 + i, 1_600_000_000 + i, i % 10 === 0 ? 'pending' : 'approved')
    // Hidden YouTube rows never count
    for (let i = 0; i < 5; i++) req('u-bob', 200_000 + i, 'tv', 'approved', { downloader: 'youtube', tvdbId: 9000 + i })
    const approvedVisible = db.prepare(`SELECT COUNT(*) AS c FROM discover_requests dr WHERE dr.status = 'approved' AND ${ids.VISIBLE_SQL}`).get().c
    expect(approvedVisible).toBeGreaterThan(1000)

    const { data } = await call('GET', '/request?take=10000&filter=approved&sort=added')
    expect(data.results).toHaveLength(approvedVisible)
    expect(data.pageInfo).toMatchObject({ results: approvedVisible, pageSize: 10000, pages: 1, page: 1 })
    expect(data.results.every(r => r.status === 2)).toBe(true)
    expect(data.results.some(r => r.media.tmdbId === 100_001)).toBe(true)

    const capped = (await call('GET', '/request?take=50000')).data.pageInfo
    expect(capped.pageSize).toBe(10000)
  })
})
