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
    const req = makeReq({ method: 'POST', path: '/queue/5/approve', headers: { 'x-api-key': 'valid-key' } })
    const next = vi.fn()
    requireAuth(req, makeRes(), next)
    expect(next).toHaveBeenCalled()
    expect(req.session.plexUser.isAdmin).toBe(true)
  })

  it('gives the API key a consistent identity that passes privileged guards', () => {
    // Regression (audit F22): the synthetic user had no id and no session-level
    // admin flag, so requirePrivileged answered 403 to the admin integration key.
    getSetting.mockReturnValue('valid-key')
    const req = makeReq({ method: 'POST', path: '/queue/5/approve', headers: { 'x-api-key': 'valid-key' } })
    requireAuth(req, makeRes(), vi.fn())
    expect(req.session.plexUser.id).toBe(requireAuth.API_KEY_USER_ID)
    expect(req.session.isAdmin).toBe(true)
    expect(requireAuth.isPrivilegedRequest(req)).toBe(true)
    expect(JSON.stringify(req.session)).toBe('{}')
  })

  it('does not drop an existing persisted admin flag when the API key is also sent', () => {
    getSetting.mockReturnValue('valid-key')
    const req = makeReq({ method: 'GET', path: '/queue', session: { isAdmin: true }, headers: { 'x-api-key': 'valid-key' } })
    requireAuth(req, makeRes(), vi.fn())
    expect(JSON.parse(JSON.stringify(req.session))).toEqual({ isAdmin: true })
  })

  it.each([
    ['GET', '/api', '/queue'],
    ['PUT', '/api', '/queue/7'],
    ['DELETE', '/api', '/queue/7'],
    ['POST', '/api', '/issues/3/resolve'],
    ['POST', '/api', '/issues/bulk-delete'],
    ['GET', '/api', '/issues/3/comments'],
    ['DELETE', '/api', '/issues/3/comments/9'],
    ['GET', '/api', '/history/users'],
    ['POST', '/api', '/admin/rebuild-pool'],
    ['POST', '/api/riven', '/reset'],
  ])('lets the API key reach the privileged endpoint %s %s%s', (method, baseUrl, path) => {
    getSetting.mockReturnValue('valid-key')
    const next = vi.fn()
    requireAuth(makeReq({ method, baseUrl, path, headers: { 'x-api-key': 'valid-key' } }), makeRes(), next)
    expect(next).toHaveBeenCalled()
  })

  it.each([
    ['POST', '/api', '/watchlist/add'],
    ['GET', '/api', '/recommendations'],
    ['GET', '/api', '/explore/recommendations'],
    ['POST', '/api', '/request'],
    ['POST', '/api', '/issues'],
    ['POST', '/api', '/issues/3/comments'],
    ['POST', '/api', '/user/settings'],
    ['GET', '/api/wrapped', '/years'],
    ['POST', '/api/watch-party', '/'],
    ['POST', '/admin', '/webpush/subscribe'],
  ])('rejects the API key on the user-scoped endpoint %s %s%s', (method, baseUrl, path) => {
    getSetting.mockReturnValue('valid-key')
    const req = makeReq({ method, baseUrl, path, headers: { 'x-api-key': 'valid-key' } })
    const res = makeRes()
    const next = vi.fn()
    requireAuth(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(req.session.plexUser).toBeUndefined()
  })

  it('re-reads the admin role from the database on every request', () => {
    // Regression (audit S10): isPlexAdminUser was a login-time snapshot.
    db.upsertKnownUser('role-user', 'Role User', null, null)
    db.setUserAdmin('role-user', true)
    const session = { plexUser: { id: 'role-user' }, isPlexAdminUser: true }
    requireAuth(makeReq({ session }), makeRes(), vi.fn())
    expect(session.isPlexAdminUser).toBe(true)
    db.setUserAdmin('role-user', false)
    requireAuth(makeReq({ session }), makeRes(), vi.fn())
    expect(session.isPlexAdminUser).toBe(false)
    expect(requireAuth.isPrivilegedRequest({ session })).toBe(false)
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
    const req = makeReq({ method: 'GET', path: '/queue', headers: { authorization: 'Bearer valid-key' } })
    requireAuth(req, makeRes(), vi.fn())
    expect(req.session.plexUser).toBeDefined()
    expect(JSON.stringify(req.session)).not.toContain('plexUser')
    expect(Object.keys(req.session)).not.toContain('plexUser')
  })
})
