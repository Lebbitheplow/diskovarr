import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Overseerr shim (/api/v1) media identity and status: movie and TV TMDB ids share
// a numeric namespace, availability means "in the library", hidden (YouTube /
// TVDB-only) rows are filtered before pagination, and media-centric endpoints
// return one entry per title however many users requested it.

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-shim-media-'))

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const logger = nodeRequire('../server/services/logger.js')
const shim = nodeRequire('../server/routes/overseerrShim.js')

vi.spyOn(logger, 'info').mockImplementation(() => {})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const KEY = db.createApiApp('Compat', 'compat').api_key
for (const [id, name] of [['u-alice', 'Alice'], ['u-bob', 'Bob'], ['u-carol', 'Carol']]) db.upsertKnownUser(id, name, null, null)

let clock = 1_700_000_000
const hidden = new Set()
function req(userId, tmdbId, mediaType, status, extra = {}) {
  const id = db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, `T${tmdbId}`, extra.downloader ? 'sonarr' : 'none', 1, status, null, null, extra)
  db.prepare('UPDATE discover_requests SET requested_at = ? WHERE id = ?').run(clock++, id)
  if (extra.downloader === 'youtube' || !tmdbId) hidden.add(id)
  return id
}
function inLibrary(tmdbId, type) {
  db.prepare('INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id) VALUES (?, ?, ?, ?, ?)')
    .run(`rk-${type}-${tmdbId}`, '1', `L${tmdbId}`, type, String(tmdbId))
}

// 1399 is both a movie (approved, not in the library) and a show (in the library)
const movie1399 = req('u-alice', 1399, 'movie', 'approved')
const tv1399 = req('u-bob', 1399, 'tv', 'approved')
inLibrary(1399, 'show')
// One title, two requesters
const alice603 = req('u-alice', 603, 'movie', 'approved')
const bob603 = req('u-bob', 603, 'movie', 'approved')
req('u-carol', 700, 'movie', 'pending')
req('u-carol', 800, 'movie', 'approved')
inLibrary(800, 'movie')
// A block of hidden rows bigger than a page, then more visible ones
for (let i = 0; i < 7; i++) req('u-carol', 900 + i, 'tv', 'approved', { downloader: 'youtube', tvdbId: 5000 + i })
for (let i = 0; i < 3; i++) req('u-carol', 0, 'tv', 'approved', { tvdbId: 6000 + i })
for (let i = 0; i < 4; i++) req('u-alice', 1000 + i, 'movie', 'pending')
// Ambiguous pairs reserved for the mutation tests
const movie2000 = req('u-alice', 2000, 'movie', 'approved')
const tv2000 = req('u-bob', 2000, 'tv', 'approved')
const movie2100 = req('u-alice', 2100, 'movie', 'pending')
const tv2100 = req('u-bob', 2100, 'tv', 'pending')

process.emit('diskovarr:checkFulfilled') // drop the shim's library-id cache

const row = id => db.prepare('SELECT * FROM discover_requests WHERE id = ?').get(id)
const visibleIds = () => db.prepare('SELECT id FROM discover_requests').all().map(r => r.id).filter(id => !hidden.has(id))

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
})

afterAll(() => {
  server?.close()
  globalThis.fetch = realFetch
})

async function call(method, route, body) {
  const res = await realFetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}
const key = m => `${m.tmdbId}:${m.mediaType}`

// ── GET /media ────────────────────────────────────────────────────────────────

describe('GET /media', () => {
  it('filter=available returns only titles that are in the library', async () => {
    const { data } = await call('GET', '/media?filter=available&take=200')
    expect(data.results.map(key).sort()).toEqual(['1399:tv', '800:movie'])
    expect(data.results.every(m => m.status === 5)).toBe(true)
    expect(data.pageInfo.results).toBe(2)
  })

  it('lists each title once with a per-title status, never hidden rows', async () => {
    const { data } = await call('GET', '/media?take=200')
    const keys = data.results.map(key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter(k => k === '603:movie')).toHaveLength(1)
    expect(keys.some(k => k.startsWith('0:') || /^90\d:/.test(k))).toBe(false)
    const byKey = Object.fromEntries(data.results.map(m => [key(m), m.status]))
    expect(byKey).toMatchObject({ '1399:movie': 3, '1399:tv': 5, '603:movie': 3, '700:movie': 2, '800:movie': 5 })
    expect(data.pageInfo.results).toBe(keys.length)
  })

  it('pages consistently over distinct titles', async () => {
    const all = (await call('GET', '/media?take=200')).data.results.map(key)
    const paged = []
    for (let skip = 0; skip < all.length; skip += 3) {
      const { data } = await call('GET', `/media?take=3&skip=${skip}`)
      expect(data.pageInfo.results).toBe(all.length)
      paged.push(...data.results.map(key))
    }
    expect(paged).toEqual(all)
  })

  it('processing / pending filters follow the title status', async () => {
    const processing = (await call('GET', '/media?filter=processing&take=200')).data.results.map(key)
    expect(processing).toEqual(expect.arrayContaining(['1399:movie', '603:movie']))
    expect(processing).not.toContain('1399:tv')
    const pending = (await call('GET', '/media?filter=pending&take=200')).data.results.map(key)
    expect(pending).toContain('700:movie')
    expect(pending).not.toContain('603:movie')
  })
})

// ── GET /media/:id ────────────────────────────────────────────────────────────

describe('GET /media/:id', () => {
  it('honours a media type hint for ids shared by a movie and a show', async () => {
    const asMovie = await call('GET', '/media/1399?mediaType=movie')
    expect(asMovie.data).toMatchObject({ mediaType: 'movie', status: 3 })
    expect(asMovie.data.requests.map(r => r.id)).toEqual([movie1399])
    const asTv = await call('GET', '/media/1399?mediaType=tv')
    expect(asTv.data).toMatchObject({ mediaType: 'tv', status: 5 })
    expect(asTv.data.requests.map(r => r.id)).toEqual([tv1399])
    expect((await call('GET', '/media/1399?mediaType=show')).data.mediaType).toBe('tv')
    expect((await call('GET', '/media/700?mediaType=tv')).status).toBe(404)
  })

  it('returns every request for the title, not just the newest', async () => {
    const { data } = await call('GET', '/media/603')
    expect(data.requests.map(r => r.id).sort()).toEqual([alice603, bob603].sort())
  })
})

// ── GET /request pagination ───────────────────────────────────────────────────

describe('GET /request', () => {
  it('filters hidden rows before paging so a DUMB-style walk sees every visible request', async () => {
    const expected = visibleIds()
    const seen = []
    let skip = 0
    // DUMB's seerr_sync loop: stop on an empty page or once skip+len reaches the total
    for (;;) {
      const { data } = await call('GET', `/request?take=3&skip=${skip}`)
      expect(data.pageInfo.results).toBe(expected.length)
      if (!data.results.length) break
      seen.push(...data.results.map(r => r.id))
      if (skip + data.results.length >= data.pageInfo.results) break
      skip += 3
    }
    expect(seen.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b))
    expect(seen.some(id => hidden.has(id))).toBe(false)
  })

  it('/request/count covers the same visible rows', async () => {
    const { data } = await call('GET', '/request/count')
    expect(data.total).toBe(visibleIds().length)
    // In the library: 1399 tv + 800 movie; approved but missing: 1399 movie, 603 ×2, 2000 ×2
    expect(data.available).toBe(2)
    expect(data.processing).toBe(5)
  })
})

// ── Mutations keyed by a bare TMDB id ─────────────────────────────────────────

describe('media mutations', () => {
  it('marking an ambiguous id available needs a type hint, then touches only that type', async () => {
    expect((await call('PUT', '/media/2000/available')).status).toBe(409)
    expect(row(movie2000).notified_available_at).toBeNull()
    expect(row(tv2000).notified_available_at).toBeNull()

    const res = await call('PUT', '/media/2000/available?mediaType=movie')
    expect(res.status).toBe(200)
    expect(res.data.media.mediaType).toBe('movie')
    expect(row(movie2000).notified_available_at).not.toBeNull()
    expect(row(tv2000).notified_available_at).toBeNull()

    expect((await call('POST', '/media/2000/available', { mediaType: 'tv' })).data).toMatchObject({ mediaType: 'tv', status: 5 })
    expect(row(tv2000).notified_available_at).not.toBeNull()
  })

  it('marking a title available notifies every requester, not just the newest', async () => {
    const res = await call('POST', '/media/603/available')
    expect(res.status).toBe(200)
    expect(row(alice603).notified_available_at).not.toBeNull()
    expect(row(bob603).notified_available_at).not.toBeNull()
  })

  it('DELETE /media/:id removes only the requested type', async () => {
    expect((await call('DELETE', '/media/2100')).status).toBe(409)
    expect(row(movie2100)).toBeDefined()
    expect((await call('DELETE', '/media/2100?mediaType=movie')).status).toBe(200)
    expect(row(movie2100)).toBeUndefined()
    expect(row(tv2100)).toBeDefined()
  })
})
