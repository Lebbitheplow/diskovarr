import { describe, it, expect, afterAll } from 'vitest'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const { detectImageType, parseImageDataUri, imageJsonParser, jsonParserExcept, AVATAR_MAX_BYTES } = nodeRequire('../server/utils/imageUpload.js')

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const GIF_HEAD = Buffer.from('GIF89a', 'latin1')
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1')])

// A buffer of `size` bytes that starts with the given signature
const fileOf = (head, size) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 1)])
const dataUri = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`

describe('detectImageType', () => {
  it('recognises PNG, JPEG, GIF and WebP by their signatures', () => {
    expect(detectImageType(fileOf(PNG_HEAD, 64))).toBe('image/png')
    expect(detectImageType(fileOf(JPEG_HEAD, 64))).toBe('image/jpeg')
    expect(detectImageType(fileOf(GIF_HEAD, 64))).toBe('image/gif')
    expect(detectImageType(fileOf(WEBP_HEAD, 64))).toBe('image/webp')
  })

  it('rejects anything else, including truncated signatures', () => {
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(detectImageType(PNG_HEAD.subarray(0, 4))).toBeNull()
    expect(detectImageType(Buffer.alloc(0))).toBeNull()
    expect(detectImageType('not a buffer')).toBeNull()
  })
})

describe('parseImageDataUri', () => {
  it('accepts an image at exactly the size cap', () => {
    const res = parseImageDataUri(dataUri(fileOf(PNG_HEAD, AVATAR_MAX_BYTES)))
    expect(res.ok).toBe(true)
    expect(res.mime).toBe('image/png')
    expect(res.bytes).toBe(AVATAR_MAX_BYTES)
  })

  it('rejects an image one byte over the cap with 413', () => {
    const res = parseImageDataUri(dataUri(fileOf(PNG_HEAD, AVATAR_MAX_BYTES + 1)))
    expect(res).toMatchObject({ ok: false, status: 413 })
    expect(res.error).toMatch(/2 MB/)
  })

  it('re-labels the URI with the detected type when the declared one is wrong or generic', () => {
    const res = parseImageDataUri(dataUri(fileOf(PNG_HEAD, 100), 'image/jpeg'))
    expect(res.ok).toBe(true)
    expect(res.dataUri.startsWith('data:image/png;base64,')).toBe(true)
    const untyped = parseImageDataUri(dataUri(fileOf(GIF_HEAD, 100), 'application/octet-stream'))
    expect(untyped.ok).toBe(true)
    expect(untyped.dataUri.startsWith('data:image/gif;base64,')).toBe(true)
  })

  it('rejects bytes that are not an allowed image even when labelled as one', () => {
    expect(parseImageDataUri(dataUri(Buffer.from('#!/bin/sh\necho hi\n')))).toMatchObject({ ok: false, status: 400 })
    // WebP is a real image but not one the bot avatar accepts by default
    expect(parseImageDataUri(dataUri(fileOf(WEBP_HEAD, 100), 'image/webp'))).toMatchObject({ ok: false, status: 400 })
    expect(parseImageDataUri(dataUri(fileOf(WEBP_HEAD, 100), 'image/webp'), { allowed: ['image/webp'] }).ok).toBe(true)
  })

  it('rejects invalid base64 instead of decoding garbage', () => {
    const good = fileOf(PNG_HEAD, 30).toString('base64')
    expect(parseImageDataUri('data:image/png;base64,' + good.slice(0, -1) + '!')).toMatchObject({ ok: false, status: 400 })
    expect(parseImageDataUri('data:image/png;base64,' + good.slice(1))).toMatchObject({ ok: false, status: 400 })
    expect(parseImageDataUri('data:image/png;base64,')).toMatchObject({ ok: false, status: 400 })
  })

  it('rejects missing values and non-image data URIs', () => {
    expect(parseImageDataUri(undefined)).toMatchObject({ ok: false, status: 400 })
    expect(parseImageDataUri(42)).toMatchObject({ ok: false, status: 400 })
    expect(parseImageDataUri('data:text/plain;base64,aGVsbG8=')).toMatchObject({ ok: false, status: 400 })
    expect(parseImageDataUri('https://example.com/a.png')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('imageJsonParser', () => {
  // Mirrors server.js: the global parser leaves the upload route unread, and
  // that route parses its own (larger) body only after the admin check
  const app = express()
  app.use(jsonParserExcept('/upload'))
  let guardSawBody = null
  const requireAdmin = (req, res, next) => {
    guardSawBody = req.body !== undefined
    if (req.get('X-Test-Admin') === '1') return next()
    res.status(401).json({ error: 'Admin session required' })
  }
  app.post('/upload', requireAdmin, imageJsonParser())
  app.post('/upload', (req, res) => {
    const image = parseImageDataUri(req.body?.imageDataUri)
    if (!image.ok) return res.status(image.status).json({ error: image.error })
    res.json({ bytes: image.bytes })
  })
  app.post('/other', (req, res) => res.json({ ok: true }))

  const server = app.listen(0, '127.0.0.1')
  afterAll(() => new Promise(resolve => server.close(resolve)))
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`
  const post = (p, body, { admin = true } = {}) => fetch(url(p), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Test-Admin': '1' } : {}) },
    body,
  })
  const fullSize = () => JSON.stringify({ imageDataUri: dataUri(fileOf(PNG_HEAD, AVATAR_MAX_BYTES)) })

  it('lets a full-size avatar through the global 100 KB limit', async () => {
    const res = await post('/upload', fullSize())
    expect(res.status).toBe(200)
    expect((await res.json()).bytes).toBe(AVATAR_MAX_BYTES)
    expect(guardSawBody).toBe(false)
  })

  it('answers an oversized body with a JSON 413 the UI can show', async () => {
    const res = await post('/upload', JSON.stringify({ imageDataUri: dataUri(fileOf(PNG_HEAD, AVATAR_MAX_BYTES * 2)) }))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/2 MB/)
  })

  it('refuses an unauthenticated upload before reading the body', async () => {
    // Malformed JSON would be a 400 had it been parsed ahead of the check
    const malformed = await post('/upload', '{' + 'x'.repeat(2.7 * 1024 * 1024), { admin: false })
    expect(malformed.status).toBe(401)
    const valid = await post('/upload', fullSize(), { admin: false })
    expect(valid.status).toBe(401)
    expect(guardSawBody).toBe(false)
  })

  it('treats case and trailing-slash variants of the route like Express does', async () => {
    expect((await post('/Upload/', fullSize())).status).toBe(200)
  })

  it('keeps the default limit on every other route', async () => {
    const res = await post('/other', JSON.stringify({ pad: 'x'.repeat(200 * 1024) }))
    expect(res.status).toBe(413)
  })
})
