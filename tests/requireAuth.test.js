import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

// Load both modules through Node's own CommonJS loader. Vitest's ESM `import`
// would create a second, transformed copy of the db module, so a spy on it
// would never be seen by the middleware's native require() of the same file.
const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const requireAuth = nodeRequire('../server/middleware/requireAuth.js')
const getSetting = vi.spyOn(db, 'getSetting')

function makeReq(overrides = {}) {
  return {
    session: {},
    headers: {},
    path: '/api/test',
    baseUrl: '/api',
    ...overrides,
  }
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    redirected: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    redirect(url) { this.redirected = url },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('requireAuth', () => {
  it('passes through an existing session user', () => {
    const req = makeReq({ session: { plexUser: { username: 'kaleb' } } })
    const next = vi.fn()
    requireAuth(req, makeRes(), next)
    expect(next).toHaveBeenCalled()
  })

  it('rejects API requests with 401 when unauthenticated', () => {
    const req = makeReq()
    const res = makeRes()
    requireAuth(req, res, vi.fn())
    expect(res.statusCode).toBe(401)
  })

  it('redirects non-API requests to /login when unauthenticated', () => {
    const req = makeReq({ path: '/queue', baseUrl: '' })
    const res = makeRes()
    requireAuth(req, res, vi.fn())
    expect(res.redirected).toBe('/login')
  })

  it('accepts a valid API key and grants admin for the request', () => {
    getSetting.mockReturnValue('valid-key')
    const req = makeReq({ headers: { 'x-api-key': 'valid-key' } })
    const next = vi.fn()
    requireAuth(req, makeRes(), next)
    expect(next).toHaveBeenCalled()
    expect(req.session.plexUser.isAdmin).toBe(true)
  })

  it('rejects an invalid API key', () => {
    getSetting.mockReturnValue('valid-key')
    const req = makeReq({ headers: { 'x-api-key': 'wrong-key' } })
    const res = makeRes()
    requireAuth(req, res, vi.fn())
    expect(res.statusCode).toBe(401)
  })

  it('does not let API-key auth leak into the persisted session', () => {
    // Regression test: the synthetic admin user must be invisible to
    // express-session's JSON-based persistence, or every API-key request
    // would mint a 30-day admin session cookie.
    getSetting.mockReturnValue('valid-key')
    const req = makeReq({ headers: { authorization: 'Bearer valid-key' } })
    requireAuth(req, makeRes(), vi.fn())
    expect(req.session.plexUser).toBeDefined()
    expect(JSON.stringify(req.session)).not.toContain('plexUser')
    expect(Object.keys(req.session)).not.toContain('plexUser')
  })
})
