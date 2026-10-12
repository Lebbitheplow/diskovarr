import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Overseerr shim (/api/v1) authorization matrix: app keys, service-user keys
// with various permission masks, foreign/disabled apps and bad keys against the
// request, user, media, settings and issue routes.

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-shim-auth-'))

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const logger = nodeRequire('../server/services/logger.js')
const shim = nodeRequire('../server/routes/overseerrShim.js')
const { Permission } = nodeRequire('../server/services/shimPolicy.js')

vi.spyOn(logger, 'info').mockImplementation(() => {})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const appA = db.createApiApp('Compat', 'compat')
const appB = db.createApiApp('Other app', 'generic')
const appOff = db.createApiApp('Disabled app', 'generic')
db.updateApiApp(appOff.id, { enabled: false })

const svc = {
  zero: db.createServiceUser(appA.id, { username: 'Zero', permissions: 0 }),
  requester: db.createServiceUser(appA.id, { username: 'Requester', permissions: Permission.REQUEST }),
  manager: db.createServiceUser(appA.id, { username: 'Manager', permissions: Permission.MANAGE_REQUESTS }),
  userAdmin: db.createServiceUser(appA.id, { username: 'User admin', permissions: Permission.MANAGE_USERS | Permission.REQUEST }),
  reporter: db.createServiceUser(appA.id, { username: 'Reporter', permissions: Permission.CREATE_ISSUES }),
  target: db.createServiceUser(appA.id, { username: 'Target', permissions: 0 }),
  foreign: db.createServiceUser(appB.id, { username: 'Foreign', permissions: Permission.REQUEST }),
  disabled: db.createServiceUser(appOff.id, { username: 'Disabled', permissions: Permission.ADMIN }),
}
db.upsertKnownUser('plex-victim', 'Victim', null, null)

const KEYS = {
  appAdmin: appA.api_key,
  zero: svc.zero.api_key,
  requester: svc.requester.api_key,
  manager: svc.manager.api_key,
  foreignApp: appB.api_key,
  foreignSvc: svc.foreign.api_key,
  disabledApp: appOff.api_key,
  disabledSvc: svc.disabled.api_key,
  invalid: 'not-a-real-key',
  missing: undefined,
}

let nextTmdb = 10000
function seedRequest(userId, { status = 'pending', mediaType = 'movie', seasonsCount = 1 } = {}) {
  const tmdbId = nextTmdb++
  const id = db.addDiscoverRequestWithStatus(userId, tmdbId, mediaType, `Title ${tmdbId}`, 'none', seasonsCount, status)
  return { id, tmdbId }
}
const requestRow = id => db.prepare('SELECT * FROM discover_requests WHERE id = ?').get(id)
const permissionsOf = user => db.prepare('SELECT permissions FROM app_service_users WHERE id = ?').get(user.id).permissions
const setPermissions = (user, mask) => db.prepare('UPDATE app_service_users SET permissions = ? WHERE id = ?').run(mask, user.id)
function seedIssue(userId) {
  return Number(db.createIssue({ userId, ratingKey: '555', title: 'Broken film', mediaType: 'movie', scope: 'video', description: 'no audio' }))
}

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

async function call(method, route, { key, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers }
  if (key) h['X-Api-Key'] = key
  const res = await realFetch(base + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

// ── Matrix: acting on another user's request / media ─────────────────────────

// App keys (any enabled app) are the Overseerr API-key equivalent and manage
// every request; service users need MANAGE_REQUESTS.
const MANAGE = {
  appAdmin: 200, zero: 403, requester: 403, manager: 200, foreignApp: 200,
  foreignSvc: 403, disabledApp: 401, disabledSvc: 401, invalid: 401, missing: 401,
}

const REQUEST_ROUTES = [
  { name: 'DELETE /request/:id', method: 'DELETE', route: r => `/request/${r.id}`, changed: r => !requestRow(r.id) },
  { name: 'PUT /request/:id', method: 'PUT', route: r => `/request/${r.id}`, body: { seasons: [1, 2] }, changed: r => requestRow(r.id).seasons_json === '[1,2]' },
  { name: 'POST /request/:id/approve', method: 'POST', route: r => `/request/${r.id}/approve`, changed: r => requestRow(r.id).status === 'approved' },
  { name: 'POST /request/:id/decline', method: 'POST', route: r => `/request/${r.id}/decline`, changed: r => requestRow(r.id).status === 'denied' },
  { name: 'POST /request/:id/pending (generic)', method: 'POST', route: r => `/request/${r.id}/pending`, seed: 'approved', changed: r => requestRow(r.id).status === 'pending' },
  { name: 'POST /request/:id/retry', method: 'POST', route: r => `/request/${r.id}/retry`, changed: () => true },
  { name: 'GET /request/:id', method: 'GET', route: r => `/request/${r.id}`, changed: () => true },
  { name: 'PUT /media/:id/available', method: 'PUT', route: r => `/media/${r.tmdbId}/available`, seed: 'approved', changed: r => !!requestRow(r.id).notified_available_at },
  { name: 'POST /media/:id/available', method: 'POST', route: r => `/media/${r.tmdbId}/available`, seed: 'approved', changed: r => !!requestRow(r.id).notified_available_at },
  { name: 'DELETE /media/:id', method: 'DELETE', route: r => `/media/${r.tmdbId}`, changed: r => !requestRow(r.id) },
]

const MATRIX = REQUEST_ROUTES.flatMap(rt => Object.keys(KEYS).map(who => ({ ...rt, who, expected: MANAGE[who] })))

describe('shim authorization matrix (another user\'s request)', () => {
  it.each(MATRIX)('$name as $who → $expected', async ({ method, route, body, seed, changed, who, expected }) => {
    const victim = seedRequest('plex-victim', { status: seed || 'pending' })
    const before = requestRow(victim.id)
    const res = await call(method, route(victim), { key: KEYS[who], body })
    expect(res.status).toBe(expected)
    if (expected === 200) expect(changed(victim)).toBe(true)
    else expect(requestRow(victim.id)).toEqual(before)
  })
})

// ── Own requests ──────────────────────────────────────────────────────────────

describe('requester acting on its own requests', () => {
  it('may read and withdraw its own pending request', async () => {
    const own = seedRequest(svc.requester.user_id)
    expect((await call('GET', `/request/${own.id}`, { key: KEYS.requester })).status).toBe(200)
    expect((await call('DELETE', `/request/${own.id}`, { key: KEYS.requester })).status).toBe(200)
    expect(requestRow(own.id)).toBeUndefined()
  })

  it('may not delete its request once approved, nor approve its own', async () => {
    const approved = seedRequest(svc.requester.user_id, { status: 'approved' })
    expect((await call('DELETE', `/request/${approved.id}`, { key: KEYS.requester })).status).toBe(403)
    const pending = seedRequest(svc.requester.user_id)
    expect((await call('POST', `/request/${pending.id}/approve`, { key: KEYS.requester })).status).toBe(403)
    expect(requestRow(pending.id).status).toBe('pending')
  })

  it('editing its own seasons cannot shrink the rate-limit charge', async () => {
    const own = seedRequest(svc.requester.user_id, { mediaType: 'tv', seasonsCount: 8 })
    const res = await call('PUT', `/request/${own.id}`, { key: KEYS.requester, body: { seasons: [1] } })
    expect(res.status).toBe(200)
    expect(requestRow(own.id)).toMatchObject({ seasons_json: '[1]', seasons_count: 8 })
  })

  it('lists only its own requests unless it holds MANAGE_REQUESTS/REQUEST_VIEW', async () => {
    const own = seedRequest(svc.requester.user_id)
    const other = seedRequest('plex-victim')
    const ids = async key => (await call('GET', '/request?take=1000', { key })).data.results.map(r => r.id)
    const mine = await ids(KEYS.requester)
    expect(mine).toContain(own.id)
    expect(mine).not.toContain(other.id)
    expect(await ids(KEYS.zero)).toEqual([])
    expect(await ids(KEYS.manager)).toEqual(expect.arrayContaining([own.id, other.id]))
    expect(await ids(KEYS.appAdmin)).toEqual(expect.arrayContaining([own.id, other.id]))
  })

  it('cannot list another service user\'s requests', async () => {
    expect((await call('GET', `/user/${svc.manager.overseerr_user_id}/requests`, { key: KEYS.requester })).status).toBe(403)
    expect((await call('GET', `/user/${svc.requester.overseerr_user_id}/requests`, { key: KEYS.requester })).status).toBe(200)
    expect((await call('GET', `/user/${svc.requester.overseerr_user_id}/requests`, { key: KEYS.manager })).status).toBe(200)
  })

  it('refuses requests from a zero-permission service user, as Overseerr does', async () => {
    db.setTmdbCache(4242, 'movie', { title: 'Cached Movie', posterUrl: null })
    const res = await call('POST', '/request', { key: KEYS.zero, body: { mediaId: 4242, mediaType: 'movie' } })
    expect(res.status).toBe(403)
    expect(res.data).toEqual({ message: 'You do not have permission to make movie requests.' })
    expect(db.prepare('SELECT 1 FROM discover_requests WHERE tmdb_id = 4242').get()).toBeUndefined()
  })
})

// ── Creating requests ─────────────────────────────────────────────────────────

describe('POST /request permission', () => {
  const masked = {
    movieOnly: db.createServiceUser(appA.id, { username: 'Movies only', permissions: Permission.REQUEST_MOVIE }),
    tvOnly: db.createServiceUser(appA.id, { username: 'Series only', permissions: Permission.REQUEST_TV }),
    admin: db.createServiceUser(appA.id, { username: 'Admin', permissions: Permission.ADMIN }),
    autoApprove: db.createServiceUser(appA.id, { username: 'Auto approve', permissions: Permission.AUTO_APPROVE | Permission.AUTO_APPROVE_MOVIE | Permission.AUTO_APPROVE_TV }),
    only4k: db.createServiceUser(appA.id, { username: '4K only', permissions: Permission.REQUEST_4K | Permission.REQUEST_4K_MOVIE | Permission.REQUEST_4K_TV }),
  }
  const DENIED = {
    movie: { message: 'You do not have permission to make movie requests.' },
    tv: { message: 'You do not have permission to make series requests.' },
  }

  let nextTitle = 50000
  // A fresh TMDB-cached title, so an allowed request is really filed (201 + row)
  function title(mediaType) {
    const tmdbId = nextTitle++
    db.setTmdbCache(tmdbId, mediaType, { title: `Request ${tmdbId}`, numberOfSeasons: mediaType === 'tv' ? 1 : undefined })
    return tmdbId
  }
  const filedBy = tmdbId => db.prepare('SELECT user_id FROM discover_requests WHERE tmdb_id = ?').get(tmdbId)?.user_id

  const CASES = [
    { who: 'requester', user: () => svc.requester, mediaType: 'movie', expected: 201 },
    { who: 'requester', user: () => svc.requester, mediaType: 'tv', expected: 201 },
    { who: 'REQUEST_MOVIE only', user: () => masked.movieOnly, mediaType: 'movie', expected: 201 },
    { who: 'REQUEST_MOVIE only', user: () => masked.movieOnly, mediaType: 'tv', expected: 403 },
    { who: 'REQUEST_TV only', user: () => masked.tvOnly, mediaType: 'tv', expected: 201 },
    { who: 'REQUEST_TV only', user: () => masked.tvOnly, mediaType: 'movie', expected: 403 },
    { who: 'ADMIN', user: () => masked.admin, mediaType: 'tv', expected: 201 },
    { who: 'MANAGE_REQUESTS only', user: () => svc.manager, mediaType: 'movie', expected: 403 },
    { who: 'AUTO_APPROVE bits only', user: () => masked.autoApprove, mediaType: 'movie', expected: 403 },
    { who: '4K request bits only', user: () => masked.only4k, mediaType: 'tv', expected: 403 },
    { who: 'zero', user: () => svc.zero, mediaType: 'tv', expected: 403 },
  ]

  it.each(CASES)('$who → $mediaType $expected (own key)', async ({ user, mediaType, expected }) => {
    const tmdbId = title(mediaType)
    const res = await call('POST', '/request', { key: user().api_key, body: { mediaId: tmdbId, mediaType } })
    expect(res.status).toBe(expected)
    if (expected === 201) expect(filedBy(tmdbId)).toBe(user().user_id)
    else {
      expect(res.data).toEqual(DENIED[mediaType])
      expect(filedBy(tmdbId)).toBeUndefined()
    }
  })

  it.each(CASES)('$who → $mediaType $expected (app key + X-API-User)', async ({ user, mediaType, expected }) => {
    const tmdbId = title(mediaType)
    const res = await call('POST', '/request', {
      key: KEYS.appAdmin, body: { mediaId: tmdbId, mediaType }, headers: { 'X-API-User': String(user().overseerr_user_id) },
    })
    expect(res.status).toBe(expected)
    if (expected === 201) expect(filedBy(tmdbId)).toBe(user().user_id)
    else expect(res.data).toEqual(DENIED[mediaType])
  })

  it('lets an app key without X-API-User request as admin', async () => {
    const tmdbId = title('movie')
    expect((await call('POST', '/request', { key: KEYS.appAdmin, body: { mediaId: tmdbId, mediaType: 'movie' } })).status).toBe(201)
    expect(filedBy(tmdbId)).toBe(`__app_${appA.id}__`)
  })

  it('refuses before any side effect: no TMDB lookup or request row', async () => {
    const appC = db.createApiApp('Fresh app', 'generic')
    const bot = db.createServiceUser(appC.id, { username: 'Muted bot', permissions: 0 })
    // With a key set, an uncached title is looked up through services/tmdb.js;
    // the spy stands in for it, so nothing leaves the machine
    const tmdb = nodeRequire('../server/services/tmdb.js')
    const lookup = vi.spyOn(tmdb, 'getItemDetails').mockResolvedValue(null)
    db.setSetting('tmdb_api_key', 'test-key')
    try {
      for (const headers of [{ 'X-API-User': String(bot.overseerr_user_id) }, {}]) {
        const key = headers['X-API-User'] ? appC.api_key : bot.api_key
        const res = await call('POST', '/request', { key, body: { mediaId: 59999, mediaType: 'movie' }, headers })
        expect(res.status).toBe(403)
      }
      expect(lookup).not.toHaveBeenCalled()
      expect(filedBy(59999)).toBeUndefined()
      // Control: an allowed request for the same uncached title does reach the lookup
      const allowed = await call('POST', '/request', { key: appC.api_key, body: { mediaId: 59999, mediaType: 'movie' } })
      expect(allowed.status).toBe(201)
      expect(lookup).toHaveBeenCalledWith(59999, 'movie')
    } finally {
      lookup.mockRestore()
      db.setSetting('tmdb_api_key', '')
    }
  })

  it('creates service users with REQUEST unless the app names a mask', async () => {
    const plain = await call('POST', '/user', { key: KEYS.appAdmin, body: { username: 'Default bot' } })
    expect(plain.status).toBe(201)
    expect(plain.data.permissions).toBe(Permission.REQUEST)
    expect(permissionsOf({ id: db.getServiceUserById(appA.id, plain.data.id).id })).toBe(Permission.REQUEST)
    const zero = await call('POST', '/user', { key: KEYS.appAdmin, body: { username: 'Zero bot', permissions: 0 } })
    expect(zero.data.permissions).toBe(0)
    expect(db.createServiceUser(appA.id, { username: 'Direct' }).permissions).toBe(Permission.REQUEST)
    expect((await call('GET', '/settings/main', { key: KEYS.appAdmin })).data.defaultPermissions).toBe(Permission.REQUEST)
  })
})

// ── Permission changes ────────────────────────────────────────────────────────

describe('service-user permission updates', () => {
  const permsRoute = u => `/user/${u.overseerr_user_id}/settings/permissions`

  it('rejects the audit probe: a zero-permission key promoting itself', async () => {
    const res = await call('POST', permsRoute(svc.zero), { key: KEYS.zero, body: { permissions: 2097151 } })
    expect(res.status).toBe(403)
    expect((await call('PUT', `/user/${svc.zero.overseerr_user_id}`, { key: KEYS.zero, body: { permissions: 2 } })).status).toBe(403)
    expect(permissionsOf(svc.zero)).toBe(0)
  })

  it('lets the app key set any mask on its own users, validating the value', async () => {
    expect((await call('POST', permsRoute(svc.target), { key: KEYS.appAdmin, body: { permissions: Permission.REQUEST } })).status).toBe(200)
    expect(permissionsOf(svc.target)).toBe(Permission.REQUEST)
    expect((await call('POST', permsRoute(svc.target), { key: KEYS.appAdmin, body: { permissions: -1 } })).status).toBe(400)
    expect((await call('PUT', `/user/${svc.target.overseerr_user_id}`, { key: KEYS.appAdmin, body: { permissions: 'abc' } })).status).toBe(400)
    expect(permissionsOf(svc.target)).toBe(Permission.REQUEST)
    setPermissions(svc.target, 0)
  })

  it('lets MANAGE_USERS grant only bits it holds, never ADMIN', async () => {
    const as = body => call('POST', permsRoute(svc.target), { key: svc.userAdmin.api_key, body })
    expect((await as({ permissions: Permission.REQUEST })).status).toBe(200)
    expect(permissionsOf(svc.target)).toBe(Permission.REQUEST)
    expect((await as({ permissions: Permission.MANAGE_REQUESTS })).status).toBe(403)
    expect((await as({ permissions: Permission.ADMIN })).status).toBe(403)
    expect(permissionsOf(svc.target)).toBe(Permission.REQUEST)
    // Its own ceiling stays put, and it can't touch a user holding bits it lacks
    const self = await call('POST', permsRoute(svc.userAdmin), { key: svc.userAdmin.api_key, body: { permissions: Permission.ADMIN | Permission.MANAGE_USERS } })
    expect(self.status).toBe(403)
    expect((await call('POST', permsRoute(svc.manager), { key: svc.userAdmin.api_key, body: { permissions: 0 } })).status).toBe(403)
    expect(permissionsOf(svc.manager)).toBe(Permission.MANAGE_REQUESTS)
    setPermissions(svc.target, 0)
  })

  it('keeps app keys inside their own app', async () => {
    // App B has only overseerr id 100; app A's "target" lives at a higher id
    expect(svc.target.overseerr_user_id).not.toBe(svc.foreign.overseerr_user_id)
    const res = await call('POST', permsRoute(svc.target), { key: KEYS.foreignApp, body: { permissions: 2097151 } })
    expect(res.status).toBe(404)
    expect(permissionsOf(svc.target)).toBe(0)
  })

  it('reserves user creation/deletion for app keys and refuses disabled or bad keys', async () => {
    expect((await call('POST', '/user', { key: KEYS.manager, body: { username: 'x' } })).status).toBe(403)
    expect((await call('DELETE', `/user/${svc.target.overseerr_user_id}`, { key: KEYS.manager })).status).toBe(403)
    for (const who of ['disabledApp', 'disabledSvc', 'invalid', 'missing']) {
      expect((await call('POST', permsRoute(svc.target), { key: KEYS[who], body: { permissions: 2 } })).status).toBe(401)
    }
    expect(permissionsOf(svc.target)).toBe(0)
  })

  it('limits no-op settings writes to the user itself or MANAGE_USERS', async () => {
    const route = `/user/${svc.target.overseerr_user_id}/settings/main`
    expect((await call('POST', route, { key: KEYS.zero, body: {} })).status).toBe(403)
    expect((await call('POST', route, { key: svc.target.api_key, body: {} })).status).toBe(200)
    expect((await call('POST', route, { key: svc.userAdmin.api_key, body: {} })).status).toBe(200)
  })
})

// ── Settings ──────────────────────────────────────────────────────────────────

describe('settings routes', () => {
  it('need MANAGE_SETTINGS except /settings/main', async () => {
    expect((await call('GET', '/settings/radarr', { key: KEYS.zero })).status).toBe(403)
    expect((await call('GET', '/settings/radarr', { key: KEYS.manager })).status).toBe(403)
    expect((await call('POST', '/settings/plex/sync', { key: KEYS.zero })).status).toBe(403)
    expect((await call('GET', '/settings/radarr', { key: KEYS.appAdmin })).status).toBe(200)
    expect((await call('GET', '/settings/main', { key: KEYS.zero })).status).toBe(200)
    expect((await call('GET', '/settings/public')).status).toBe(200)
  })
})

// ── Issues ────────────────────────────────────────────────────────────────────

describe('issue routes', () => {
  it('hide and protect other users\' issues from keys without issue permissions', async () => {
    const issueId = seedIssue('plex-victim')
    expect((await call('GET', '/issue', { key: KEYS.zero })).status).toBe(403)
    expect((await call('GET', '/issue/count', { key: KEYS.zero })).status).toBe(403)
    expect((await call('GET', `/issue/${issueId}`, { key: KEYS.zero })).status).toBe(403)
    expect((await call('POST', `/issue/${issueId}/resolved`, { key: KEYS.zero })).status).toBe(403)
    expect((await call('POST', `/issue/${issueId}/comment`, { key: KEYS.zero, body: { message: 'hi' } })).status).toBe(403)
    expect((await call('DELETE', `/issue/${issueId}`, { key: KEYS.zero })).status).toBe(403)
    expect(db.getIssueById(issueId).status).toBe('open')
    expect((await call('POST', '/issue', { key: KEYS.zero, body: { mediaId: 1, message: 'x' } })).status).toBe(403)
  })

  it('let the app key manage any issue, with a validated status', async () => {
    const issueId = seedIssue('plex-victim')
    const list = await call('GET', '/issue?take=200', { key: KEYS.appAdmin })
    expect(list.data.results.map(i => i.id)).toContain(issueId)
    expect((await call('POST', `/issue/${issueId}/bogus`, { key: KEYS.appAdmin })).status).toBe(400)
    expect((await call('POST', `/issue/${issueId}/resolved`, { key: KEYS.appAdmin })).status).toBe(200)
    expect(db.getIssueById(issueId).status).toBe('resolved')
    expect((await call('DELETE', `/issue/${issueId}`, { key: KEYS.appAdmin })).status).toBe(200)
    expect(db.getIssueById(issueId)).toBeUndefined()
  })

  it('let a CREATE_ISSUES key work on its own issues only', async () => {
    const victimIssue = seedIssue('plex-victim')
    const created = await call('POST', '/issue', { key: svc.reporter.api_key, body: { mediaId: 77, message: 'stutters' } })
    expect(created.status).toBe(201)
    const own = created.data.id
    const list = await call('GET', '/issue?take=200', { key: svc.reporter.api_key })
    expect(list.data.results.map(i => i.id)).toEqual([own])
    expect((await call('GET', `/issue/${victimIssue}`, { key: svc.reporter.api_key })).status).toBe(403)
    expect((await call('POST', `/issue/${own}/comment`, { key: svc.reporter.api_key, body: { message: 'still' } })).status).toBe(201)
    expect((await call('POST', `/issue/${own}/resolved`, { key: svc.reporter.api_key })).status).toBe(200)
  })

  it('let only the author (or MANAGE_ISSUES/app key) edit or delete a comment', async () => {
    const issueId = seedIssue(svc.reporter.user_id)
    const commentId = Number(db.addIssueComment(issueId, 'plex-victim', 'from the victim', false))
    expect((await call('PUT', `/issueComment/${commentId}`, { key: svc.reporter.api_key, body: { message: 'edited' } })).status).toBe(403)
    expect((await call('DELETE', `/issueComment/${commentId}`, { key: svc.reporter.api_key })).status).toBe(403)
    expect(db.prepare('SELECT comment FROM issue_comments WHERE id = ?').get(commentId).comment).toBe('from the victim')
    expect((await call('DELETE', `/issueComment/${commentId}`, { key: KEYS.appAdmin })).status).toBe(200)
    expect(db.prepare('SELECT 1 FROM issue_comments WHERE id = ?').get(commentId)).toBeUndefined()
  })
})
