import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'

// /api/poster end to end against a mocked media server: only allowed image
// paths are fetched, only image bodies are relayed, and the response is
// bounded. Never talks to a real Plex/Jellyfin — global fetch is mocked.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-poster-proxy-'))
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const { fetchImage, ImageFetchError } = nodeRequire('../server/services/imageFetch.js')

const PLEX = 'http://plex.test:32400'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

let server, base, outbound, upstream
const realFetch = global.fetch

function get(urlPath, { user } = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers: user ? { 'x-test-user': user } : {} }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

const image = (body = PNG, type = 'image/png') => new Response(body, { headers: { 'Content-Type': type } })

// Every outbound request is recorded and answered by the current `upstream`
function mockUpstream() {
  global.fetch = vi.fn(async (url, opts = {}) => {
    outbound.push({ url: String(url), redirect: opts.redirect })
    return upstream(String(url), opts)
  })
}

beforeAll(async () => {
  db.setSetting('plex_url', PLEX)
  db.setSetting('plex_token', 'SERVER_TOKEN')
  mockUpstream()
  const api = nodeRequire('../server/routes/api.js')
  const app = express()
  app.use((req, res, next) => {
    const id = req.get('x-test-user') || 'u1'
    req.session = { plexUser: { id, username: 'user' } }
    next()
  })
  app.use('/api', api)
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server?.close()
  global.fetch = realFetch
})

afterEach(() => { outbound = []; mockUpstream() })
outbound = []

const poster = (p, w) => `/api/poster?path=${encodeURIComponent(p)}${w ? `&w=${w}` : ''}`

describe('/api/poster', () => {
  it('serves allowed art', async () => {
    upstream = () => image()
    const res = await get(poster('/library/metadata/12/thumb/1699999999', 300))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.body.equals(PNG)).toBe(true)
    const url = new URL(outbound[0].url)
    expect(url.origin).toBe(PLEX)
    expect(url.pathname).toBe('/photo/:/transcode')
    expect(url.searchParams.get('url')).toBe('/library/metadata/12/thumb/1699999999')
  })

  it('returns 400 without contacting Plex for encoded traversal and non-image endpoints', async () => {
    upstream = () => new Response('{"MediaContainer":{}}', { headers: { 'Content-Type': 'application/json' } })
    for (const p of ['/library/%2e%2e/identity', '/library/%252e%252e/identity', '/library/sections', '/library/sections/1/refresh', '/library/metadata/12']) {
      const res = await get(poster(p))
      expect(res.status, p).toBe(400)
    }
    expect(outbound).toEqual([])
  })

  it('never relays upstream JSON or HTML as a poster', async () => {
    for (const type of ['application/json', 'text/html; charset=utf-8', 'image/svg+xml', '']) {
      upstream = () => new Response('<html>not an image</html>', { headers: type ? { 'Content-Type': type } : {} })
      const res = await get(poster('/library/metadata/12/thumb/1'))
      expect(res.status, type).toBe(502)
      expect(res.body.toString()).not.toMatch(/not an image<\/html>/)
    }
  })

  it('passes a missing image through as 404', async () => {
    upstream = () => new Response('', { status: 404 })
    expect((await get(poster('/library/metadata/12/thumb/1'))).status).toBe(404)
  })

  it('refuses redirects off the media server, follows same-origin ones', async () => {
    upstream = (url) => url.startsWith(PLEX + '/library/metadata/12/thumb/1?')
      ? new Response(null, { status: 302, headers: { Location: 'http://elsewhere.test/x.png' } })
      : image()
    expect((await get(poster('/library/metadata/12/thumb/1'))).status).toBe(502)
    expect(outbound.map(o => new URL(o.url).host)).toEqual(['plex.test:32400'])
    expect(outbound[0].redirect).toBe('manual')

    outbound = []
    upstream = (url) => url.includes('/thumb/1?')
      ? new Response(null, { status: 302, headers: { Location: '/library/metadata/12/thumb/2' } })
      : image()
    expect((await get(poster('/library/metadata/12/thumb/1'))).status).toBe(200)
    expect(outbound).toHaveLength(2)
  })
})

describe('fetchImage', () => {
  it('caps the body size, by header and by actual bytes', async () => {
    global.fetch = vi.fn(async () => new Response(Buffer.alloc(2048), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '2048' } }))
    await expect(fetchImage('http://img.test/a.jpg', { maxBytes: 1024 })).rejects.toBeInstanceOf(ImageFetchError)
    // No (or a lying) Content-Length: the stream itself is counted
    global.fetch = vi.fn(async () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(512)); c.close() },
    }), { headers: { 'Content-Type': 'image/jpeg' } }))
    await expect(fetchImage('http://img.test/a.jpg', { maxBytes: 1024 })).rejects.toThrow(/too large/)
    const ok = await fetchImage('http://img.test/a.jpg', { maxBytes: 4096 })
    expect(ok.body.length).toBe(2048)
    expect(ok.contentType).toBe('image/jpeg')
  })

  it('follows cross-origin redirects only when allowed (token-free URLs)', async () => {
    upstream = (url) => url.startsWith('https://plex.tv/')
      ? new Response(null, { status: 302, headers: { Location: 'https://cdn.test/avatar.png' } })
      : image()
    await expect(fetchImage('https://plex.tv/users/1/avatar')).rejects.toThrow(/another origin/)
    await expect(fetchImage('https://plex.tv/users/1/avatar', { crossOriginRedirects: true })).resolves.toMatchObject({ contentType: 'image/png' })
  })
})

// Per-user library access: a library row in a section the user can't reach on
// the media server gets no art; non-row ids (episodes, collections) still do.
describe('/api/poster library access', () => {
  const libraryAccess = nodeRequire('../server/services/libraryAccess/index.js')

  beforeAll(() => {
    const ins = db.prepare("INSERT INTO library_items (rating_key, section_id, title, type, source) VALUES (?, ?, 'T', ?, ?)")
    ins.run('501', '1', 'movie', 'plex')
    ins.run('510', '10', 'show', 'plex')
    ins.run('abcdef0123456789abcdef0123456789', 'jf_' + 'f1'.repeat(16), 'movie', 'jellyfin')
    libraryAccess.saveSnapshot('friend', 'plex', { role: 'shared', sectionIds: ['1', '2'] })
    libraryAccess.saveSnapshot('youtuber', 'plex', { role: 'shared', sectionIds: ['1', '2', '10'] })
    libraryAccess.invalidate()
  })
  afterEach(() => db.setSetting('library_access_enforced', '1'))

  it('404s art of a library title in a section the user cannot access, without contacting Plex', async () => {
    upstream = () => image()
    const res = await get(poster('/library/metadata/510/thumb/1700000000', 300), { user: 'friend' })
    expect(res.status).toBe(404)
    expect(outbound).toEqual([])
    expect((await get(poster('/library/metadata/510/thumb/1700000000'), { user: 'youtuber' })).status).toBe(200)
  })

  it('serves accessible rows and non-row ids with a private cache policy', async () => {
    upstream = () => image()
    const own = await get(poster('/library/metadata/501/thumb/1'), { user: 'friend' })
    expect(own.status).toBe(200)
    expect(own.headers['cache-control']).toMatch(/^private,/)
    // Episode / season art is not a library row
    expect((await get(poster('/library/metadata/999999/thumb/1'), { user: 'friend' })).status).toBe(200)
    expect((await get(poster('/library/collections/510/composite/1'), { user: 'friend' })).status).toBe(200)
    // A Plex-only user has no Jellyfin access
    expect((await get(poster('/Items/abcdef0123456789abcdef0123456789/Images/Primary'), { user: 'friend' })).status).toBe(404)
  })

  it('a user with no snapshot sees no library art (fail closed)', async () => {
    upstream = () => image()
    expect((await get(poster('/library/metadata/501/thumb/1'), { user: 'stranger' })).status).toBe(404)
    expect(outbound).toEqual([]) // Plex is not fully configured here, so no plex.tv lookup either
  })

  it('the kill switch restores the public cache policy and every poster', async () => {
    upstream = () => image()
    libraryAccess.setEnforced(false)
    const res = await get(poster('/library/metadata/510/thumb/1'), { user: 'friend' })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toMatch(/^public,/)
  })
})
