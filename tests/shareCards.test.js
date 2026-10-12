import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

// Public share-card rendering budgets: review text caps on write, bounded
// full-review images, a global render limiter (503 when saturated), a per-IP
// rate limit on /og, and bounded image fetches. Media servers are mocked.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-share-cards-'))
process.env.DISKOVARR_DATA_DIR = DATA_DIR
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const cardKit = nodeRequire('../server/services/cardKit.js')
const reviewCard = nodeRequire('../server/services/reviewCard.js')
const reviewCardCache = nodeRequire('../server/services/reviewCardCache.js')

const realFetch = global.fetch
let server, base

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(base + urlPath, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) })

function insertReview(userId, text, extra = {}) {
  const r = db.prepare(`INSERT INTO reviews (user_id, media_type, tmdb_id, title, rating, review_text, watched_date)
    VALUES (?, 'movie', ?, ?, 4, ?, 1700000000)`)
    .run(userId, extra.tmdbId ?? Math.floor(Math.random() * 1e9), extra.title ?? 'Test Movie', text)
  return Number(r.lastInsertRowid)
}

beforeAll(async () => {
  global.fetch = vi.fn(async () => { throw new Error('no network in tests') })
  db.prepare("INSERT INTO known_users (user_id, username) VALUES ('u1', 'alice')").run()
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.session = { plexUser: { id: 'u1', username: 'alice' } }; next() })
  app.use('/api', nodeRequire('../server/routes/api.js'))
  app.use('/og', nodeRequire('../server/routes/og.js'))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server?.close()
  global.fetch = realFetch
})

describe('review text cap', () => {
  const body = (reviewText) => ({ mediaType: 'movie', tmdbId: 550, rating: 4, watchedDate: 1700000000, title: 'Fight Club', reviewText })

  it('rejects over-long or non-string text on create', async () => {
    expect((await request('POST', '/api/reviews', body('x'.repeat(2001)))).status).toBe(400)
    expect((await request('POST', '/api/reviews', body({ nested: 'object' }))).status).toBe(400)
    expect((await request('POST', '/api/reviews', { ...body('ok'), title: 't'.repeat(501) })).status).toBe(400)
  })

  it('rejects over-long text on update and accepts the 2000-character limit', async () => {
    const id = insertReview('u1', 'short')
    expect((await request('PUT', `/api/reviews/${id}`, { reviewText: 'x'.repeat(2001) })).status).toBe(400)
    expect(db.getReviewById(id).review_text).toBe('short')
    const ok = await request('PUT', `/api/reviews/${id}`, { reviewText: 'y'.repeat(2000) })
    expect(ok.status).toBe(200)
    expect(db.getReviewById(id).review_text).toHaveLength(2000)
  })
})

describe('review card rendering', () => {
  const card = (reviewText, extra = {}) => ({
    username: 'alice', avatar: null, title: 'Test Movie', year: 2020, rating: 4,
    reviewText, spoiler: false, dateTs: 1700000000, posterPath: null, ...extra,
  })

  it('keeps the og and square variants at their fixed sizes', async () => {
    expect(pngSize(await reviewCard.renderPng(card('Great film.'), 'og'))).toEqual({ width: 2400, height: 1260 })
    expect(pngSize(await reviewCard.renderPng(card('Great film.'), 'square'))).toEqual({ width: 2160, height: 2160 })
  })

  it('grows the full variant with the review but caps its height', async () => {
    const short = pngSize(await reviewCard.renderPng(card('Great film.'), 'full'))
    expect(short).toEqual({ width: 2400, height: 1260 }) // min height
    const long = pngSize(await reviewCard.renderPng(card('A sentence about the film. '.repeat(70)), 'full'))
    expect(long.height).toBeGreaterThan(1260)
    expect(long.height).toBeLessThanOrEqual(reviewCard.FULL_MAX_HEIGHT * 2)
    // Paragraph-break spam would otherwise be ~40 rows per 100 characters
    const spam = pngSize(await reviewCard.renderPng(card('a\n\n'.repeat(700)), 'full'))
    expect(spam.height).toBeLessThanOrEqual(reviewCard.FULL_MAX_HEIGHT * 2)
    // Even with a pathological title, the canvas never exceeds the cap
    const tall = pngSize(await reviewCard.renderPng(card('b\n\n'.repeat(700), { title: 'Long title '.repeat(60) }), 'full'))
    expect(tall.height).toBeLessThanOrEqual(reviewCard.FULL_MAX_HEIGHT * 2)
  })
})

describe('render limiter', () => {
  it('runs at most RENDER_CONCURRENCY renders and rejects past the bounded queue', async () => {
    const { RENDER_CONCURRENCY, RENDER_QUEUE_MAX } = cardKit
    let running = 0, peak = 0
    let release
    const gate = new Promise(r => { release = r })
    const job = () => cardKit.withRenderSlot(async () => {
      running++; peak = Math.max(peak, running)
      await gate
      running--
      return 'ok'
    })
    const accepted = Array.from({ length: RENDER_CONCURRENCY + RENDER_QUEUE_MAX }, job)
    await new Promise(r => setImmediate(r))
    expect(cardKit.renderLoad()).toEqual({ active: RENDER_CONCURRENCY, queued: RENDER_QUEUE_MAX })
    await expect(job()).rejects.toMatchObject({ code: 'RENDER_BUSY' })
    release()
    expect(await Promise.all(accepted)).toHaveLength(RENDER_CONCURRENCY + RENDER_QUEUE_MAX)
    expect(peak).toBe(RENDER_CONCURRENCY)
    expect(cardKit.renderLoad()).toEqual({ active: 0, queued: 0 })
  })
})

describe('fetchAsDataUri', () => {
  afterEach(() => { global.fetch = vi.fn(async () => { throw new Error('no network in tests') }) })

  it('only fetches allowed art paths, pre-shrunk through the Plex transcoder', async () => {
    db.setSetting('plex_url', 'http://plex.test:32400')
    db.setSetting('plex_token', 'SERVER_TOKEN')
    const seen = []
    global.fetch = vi.fn(async (url) => {
      seen.push(String(url))
      return new Response(Buffer.from([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } })
    })
    expect(await cardKit.fetchAsDataUri('/library/sections/1/refresh')).toBeNull()
    expect(await cardKit.fetchAsDataUri('/library/%2e%2e/identity')).toBeNull()
    expect(seen).toEqual([])
    expect(await cardKit.fetchAsDataUri('/library/metadata/7/thumb/1')).toBe('data:image/jpeg;base64,AQID')
    const url = new URL(seen[0])
    expect(url.pathname).toBe('/photo/:/transcode')
    expect(url.searchParams.get('width')).toBe('720')
  })

  it('drops non-image and oversized responses', async () => {
    global.fetch = vi.fn(async () => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }))
    expect(await cardKit.fetchAsDataUri('https://img.test/a.jpg')).toBeNull()
    global.fetch = vi.fn(async () => new Response(Buffer.alloc(9 * 1024 * 1024), { headers: { 'Content-Type': 'image/png' } }))
    expect(await cardKit.fetchAsDataUri('https://img.test/big.png')).toBeNull()
  })
})

describe('/og routes', () => {
  it('serves cards from a cache under the configured data dir', async () => {
    const id = insertReview('u1', 'Loved it.')
    for (const variant of ['.png', '/square.png', '/full.png']) {
      const res = await request('GET', `/og/review/${id}${variant}`)
      expect(res.status, variant).toBe(200)
      expect(res.headers['content-type']).toBe('image/png')
      expect(res.headers['cache-control']).toBe('public, max-age=604800')
      expect(res.headers.etag).toBeTruthy()
    }
    expect(reviewCardCache.CACHE_DIR).toBe(path.join(DATA_DIR, 'og-cache'))
    expect(fs.readdirSync(reviewCardCache.CACHE_DIR).filter(f => f.startsWith(`${id}-`))).toHaveLength(3)
  })

  it('answers 503 (not cached) when the renderer is saturated', async () => {
    const id = insertReview('u1', 'Cold card.')
    let release
    const gate = new Promise(r => { release = r })
    const hold = Array.from({ length: cardKit.RENDER_CONCURRENCY + cardKit.RENDER_QUEUE_MAX },
      () => cardKit.withRenderSlot(() => gate))
    const res = await request('GET', `/og/review/${id}.png`)
    expect(res.status).toBe(503)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['retry-after']).toBe('5')
    expect(res.headers.etag ?? '').not.toMatch(/^"r\d/) // no card ETag on a failed render
    release()
    await Promise.all(hold)
    expect((await request('GET', `/og/review/${id}.png`)).status).toBe(200)
  })

  // Last: it spends this file's per-IP budget
  it('rate-limits per client', async () => {
    const statuses = []
    for (let i = 0; i < 125; i++) statuses.push((await request('GET', '/og/review/999999.png')).status)
    expect(statuses).toContain(404)
    expect(statuses.at(-1)).toBe(429)
  })
})
