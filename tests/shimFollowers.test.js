import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Overseerr shim (/api/v1) view of two request kinds added by the request
// policy work: "Notify me" follower rows (is_follow) are subscriptions, never
// jobs a pull consumer could acquire, and season-gated requests (specific
// seasons of a show the library already has) stay processing until the
// season-aware fulfillment check stamps them.

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-shim-followers-'))

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const logger = nodeRequire('../server/services/logger.js')
const shim = nodeRequire('../server/routes/overseerrShim.js')

vi.spyOn(logger, 'info').mockImplementation(() => {})

const KEY = db.createApiApp('Compat', 'compat').api_key
for (const [id, name] of [['u-alice', 'Alice'], ['u-bob', 'Bob']]) db.upsertKnownUser(id, name, null, null)

function inLibrary(tmdbId, type) {
  db.prepare('INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id) VALUES (?, ?, ?, ?, ?)')
    .run(`rk-${type}-${tmdbId}`, '1', `L${tmdbId}`, type, String(tmdbId))
}

// Alice requested a movie; Bob follows it
const movieReq = db.addDiscoverRequestWithStatus('u-alice', 501, 'movie', 'Followed', 'radarr', 1, 'approved')
const follower = db.addDiscoverRequestWithStatus('u-bob', 501, 'movie', 'Followed', 'none', 1, 'approved', null, null, { isFollow: true })
// Show 77 is in the library; Alice asked for its missing season 4
inLibrary(77, 'show')
const gated = db.addDiscoverRequestWithStatus('u-alice', 77, 'tv', 'Gated', 'sonarr', 1, 'approved', [4], null, { seasonGated: true })

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

async function call(method, route, body) {
  const res = await realFetch(base + route, {
    method,
    headers: { 'X-Api-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}

describe('follower rows', () => {
  it('are not listed as requests and not counted', async () => {
    const { data } = await call('GET', '/request?take=100')
    const ids = data.results.map(r => r.id)
    expect(ids).toContain(movieReq)
    expect(ids).not.toContain(follower)
    expect(data.pageInfo.results).toBe(2)
    const counts = (await call('GET', '/request/count')).data
    expect(counts.approved).toBe(2)
  })

  it('are removed with the title they follow', async () => {
    const extra = db.addDiscoverRequestWithStatus('u-alice', 502, 'movie', 'Gone', 'radarr', 1, 'approved')
    const extraFollower = db.addDiscoverRequestWithStatus('u-bob', 502, 'movie', 'Gone', 'none', 1, 'approved', null, null, { isFollow: true })
    const { status } = await call('DELETE', '/media/502?mediaType=movie')
    expect(status).toBe(200)
    expect(db.getRequestById(extra)).toBeFalsy()
    expect(db.getRequestById(extraFollower)).toBeFalsy()
  })
})

describe('season-gated requests', () => {
  it('stay processing on the request while the requested season is missing', async () => {
    const { data } = await call('GET', `/request/${gated}`)
    expect(data.status).toBe(2) // approved
    expect(data.media.status).toBe(3) // processing — what DUMB pull mode acts on
  })

  it('make the title partially available, not available', async () => {
    const { data } = await call('GET', '/media?take=100')
    const show = data.results.find(m => m.tmdbId === 77 && m.mediaType === 'tv')
    expect(show.status).toBe(4)
    const available = (await call('GET', '/media?filter=available&take=100')).data.results
    expect(available.some(m => m.tmdbId === 77)).toBe(false)
    const partial = (await call('GET', '/media?filter=partial&take=100')).data.results
    expect(partial.some(m => m.tmdbId === 77)).toBe(true)
    expect((await call('GET', '/request/count')).data.available).toBe(0)
  })

  it('become available once the season check stamps them', async () => {
    db.markRequestsNotifiedAvailable([gated])
    expect((await call('GET', `/request/${gated}`)).data.media.status).toBe(5)
    expect((await call('GET', '/media/77?mediaType=tv')).data.status).toBe(5)
    expect((await call('GET', '/request/count')).data.available).toBe(1)
  })
})

describe('POST /request duplicate check', () => {
  it('ignores followers left on a title nobody is acquiring', async () => {
    // A follower whose followed request was denied before followers were cleaned up
    db.setTmdbCache(601, 'movie', { title: 'Orphaned' })
    db.addDiscoverRequestWithStatus('u-alice', 601, 'movie', 'Orphaned', 'radarr', 1, 'denied')
    const orphan = db.addDiscoverRequestWithStatus('u-bob', 601, 'movie', 'Orphaned', 'none', 1, 'approved', null, null, { isFollow: true })
    const { status, data } = await call('POST', '/request', { mediaId: 601, mediaType: 'movie' })
    expect(status).toBe(201)
    expect(data.id).toBeGreaterThan(orphan)
    expect(db.getRequestById(data.id).is_follow).toBe(0)
  })

  it('reports the live request, not a newer follower row', async () => {
    db.setTmdbCache(602, 'movie', { title: 'Live' })
    const live = db.addDiscoverRequestWithStatus('u-alice', 602, 'movie', 'Live', 'radarr', 1, 'pending')
    db.addDiscoverRequestWithStatus('u-bob', 602, 'movie', 'Live', 'none', 1, 'approved', null, null, { isFollow: true })
    const { status, data } = await call('POST', '/request', { mediaId: 602, mediaType: 'movie' })
    expect(status).toBe(409)
    expect(data).toMatchObject({ id: live, status: 1 })
  })
})
