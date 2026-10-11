import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const compressJson = nodeRequire('../server/middleware/compressJson.js')
const builtAssets = nodeRequire('../server/middleware/builtAssets.js')

const BIG = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Title number ${i}` })) }
const JS = 'export const x = ' + JSON.stringify('y'.repeat(4000)) + '\n'

let server, base, assetsDir

// Raw request: Node's fetch would transparently decode, hiding what was sent
function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

beforeAll(async () => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-assets-'))
  fs.writeFileSync(path.join(assetsDir, 'app-abc123.js'), JS)
  fs.writeFileSync(path.join(assetsDir, 'app-abc123.js.br'), zlib.brotliCompressSync(JS))
  fs.writeFileSync(path.join(assetsDir, 'app-abc123.js.gz'), zlib.gzipSync(JS))
  fs.writeFileSync(path.join(assetsDir, 'plain-def456.css'), 'body{color:red}')

  const app = express()
  app.use(compressJson())
  app.get('/big', (req, res) => res.json(BIG))
  app.get('/small', (req, res) => res.json({ ok: true }))
  app.get('/status', (req, res) => res.status(201).json(BIG))
  app.get('/text', (req, res) => res.send('x'.repeat(5000)))
  app.use('/assets', builtAssets(assetsDir))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server?.close()
  fs.rmSync(assetsDir, { recursive: true, force: true })
})

describe('compressJson', () => {
  it('brotli-compresses large JSON for clients that accept it', async () => {
    const res = await get('/big', { 'Accept-Encoding': 'gzip, deflate, br' })
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers.vary).toMatch(/Accept-Encoding/)
    expect(JSON.parse(zlib.brotliDecompressSync(res.body))).toEqual(BIG)
    expect(res.body.length).toBeLessThan(JSON.stringify(BIG).length / 3)
  })

  it('falls back to gzip, and keeps the status code', async () => {
    const res = await get('/status', { 'Accept-Encoding': 'gzip' })
    expect(res.status).toBe(201)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(JSON.parse(zlib.gunzipSync(res.body))).toEqual(BIG)
  })

  it('leaves small bodies, non-JSON and clients without Accept-Encoding alone', async () => {
    const small = await get('/small', { 'Accept-Encoding': 'br' })
    expect(small.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(small.body)).toEqual({ ok: true })

    const text = await get('/text', { 'Accept-Encoding': 'br' })
    expect(text.headers['content-encoding']).toBeUndefined()

    const none = await get('/big')
    expect(none.headers['content-encoding']).toBeUndefined()
    expect(JSON.parse(none.body)).toEqual(BIG)

    const identity = await get('/big', { 'Accept-Encoding': 'identity' })
    expect(identity.headers['content-encoding']).toBeUndefined()
  })
})

describe('builtAssets', () => {
  it('serves the precompressed sibling with the original type and a long cache', async () => {
    const res = await get('/assets/app-abc123.js', { 'Accept-Encoding': 'gzip, br' })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('br')
    expect(res.headers['content-type']).toMatch(/javascript/)
    expect(res.headers['cache-control']).toMatch(/max-age=31536000/)
    expect(res.headers['cache-control']).toMatch(/immutable/)
    expect(zlib.brotliDecompressSync(res.body).toString()).toBe(JS)
  })

  it('picks gzip when brotli is not accepted', async () => {
    const res = await get('/assets/app-abc123.js', { 'Accept-Encoding': 'gzip' })
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(zlib.gunzipSync(res.body).toString()).toBe(JS)
  })

  it('serves the plain file, still cached long, when there is no sibling or no encoding', async () => {
    const css = await get('/assets/plain-def456.css', { 'Accept-Encoding': 'br' })
    expect(css.status).toBe(200)
    expect(css.headers['content-encoding']).toBeUndefined()
    expect(css.body.toString()).toBe('body{color:red}')
    expect(css.headers['cache-control']).toMatch(/immutable/)

    const js = await get('/assets/app-abc123.js')
    expect(js.headers['content-encoding']).toBeUndefined()
    expect(js.body.toString()).toBe(JS)
  })

  it('does not escape the assets directory', async () => {
    const res = await get('/assets/..%2f..%2fetc%2fpasswd', { 'Accept-Encoding': 'br' })
    expect(res.status).not.toBe(200)
  })
})
