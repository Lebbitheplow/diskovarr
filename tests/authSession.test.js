import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// End-to-end auth/session behaviour through the real routers, express-session
// and an ephemeral HTTP server. The db module migrates at require time, so
// point it at a scratch dir first; every plex.tv call is mocked.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-auth-session-test-'))
process.env.TUBERR_MANAGED = '0'
process.env.PLEX_SERVER_ID = 'test-server-id'
process.env.ADMIN_PASSWORD = 'test-admin-password'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const session = nodeRequire('../server/node_modules/express-session')
const db = nodeRequire('../server/db/database.js')
const jellyfinService = nodeRequire('../server/services/jellyfin')
const requireAuth = nodeRequire('../server/middleware/requireAuth.js')
const { trustProxySetting } = nodeRequire('../server/middleware/httpSecurity.js')
const authRouter = nodeRequire('../server/routes/auth.js')
const apiRouter = nodeRequire('../server/routes/api.js')
const adminRouter = nodeRequire('../server/routes/admin.js')

const API_KEY = 'test-diskovarr-api-key'
const realFetch = globalThis.fetch
let server, base

beforeAll(async () => {
  db.setSetting('diskovarr_api_key', API_KEY)
  const app = express()
  app.set('trust proxy', trustProxySetting(undefined))
  app.use(express.json())
  app.use(session({
    name: 'sid', secret: 'test-secret', resave: false, saveUninitialized: false,
    store: new session.MemoryStore(),
    cookie: { secure: 'auto', sameSite: 'lax', httpOnly: true },
  }))
  app.get('/test/session', (req, res) => res.json({ token: req.session.plexUser?.token || null }))
  app.use('/auth', authRouter)
  app.use('/api/riven', requireAuth, apiRouter.requirePrivileged, (req, res) => res.json({ ok: true }))
  app.use('/api', apiRouter)
  app.use('/admin', adminRouter)
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise(resolve => server.close(resolve)))
afterEach(async () => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
  // Jellyfin sign-ins and links share one per-IP attempt budget; each test gets its own
  await authRouter.jellyfinCredentialLimiter.resetKey('127.0.0.1')
})

// Requests to the test server go through the real fetch; anything else
// (plex.tv) is answered by `routes` [urlNeedle, body] or fails the test.
function mockPlexTv(routes) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url)
    if (u.startsWith(base)) return realFetch(url, opts)
    const hit = routes.find(([needle]) => u.includes(needle))
    if (!hit) throw new Error(`unexpected outbound request: ${u}`)
    return new Response(JSON.stringify(hit[1]), { headers: { 'Content-Type': 'application/json' } })
  }
}

async function call(route, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await realFetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = res.headers.get('set-cookie')
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null, setCookie }
}

function mockJellyfinAuth(userId, name) {
  vi.spyOn(jellyfinService, 'isEnabled').mockReturnValue(true)
  vi.spyOn(jellyfinService, 'authenticateByName').mockResolvedValue({
    userId, name, accessToken: `JF_TOKEN_${userId}`, primaryImageTag: null,
  })
}

// POST /auth/create-pin with plex.tv answering { id, code }: the PIN gets
// bound to the session in `cookie` (or a new one, returned as `cookie`)
async function createPin(id, code, { cookie, link, headers } = {}) {
  mockPlexTv([['plex.tv/api/v2/pins', { id, code }]])
  const res = await call('/auth/create-pin', { method: 'POST', body: link ? { link: true } : {}, cookie, headers })
  globalThis.fetch = realFetch
  expect(res.data).toEqual({ id, code })
  return { ...res, cookie: res.cookie || cookie }
}

async function jellyfinLogin(userId, name) {
  mockJellyfinAuth(userId, name)
  const res = await call('/auth/jellyfin/login', { method: 'POST', body: { username: name, password: 'pw' } })
  expect(res.data.status).toBe('authorized')
  return res.cookie
}

describe('login rotates the session ID', () => {
  it('Plex PIN login issues a new session and invalidates the pre-login one', async () => {
    const pre = await createPin(42, 'abcd')
    expect(pre.cookie).toBeTruthy()
    mockPlexTv([
      ['/api/v2/pins/42', { id: 42, authToken: 'PLEX_USER_TOKEN' }],
      ['/api/v2/user', { id: 1001, username: 'plexuser', thumb: 'https://plex.tv/users/abc/avatar', uuid: 'uuid-1001' }],
      ['/api/v2/resources', [{ clientIdentifier: 'test-server-id', accessToken: 'PLEX_SERVER_TOKEN' }]],
    ])
    const login = await call('/auth/check-pin', { cookie: pre.cookie })
    expect(login.data.status).toBe('authorized')
    expect(login.cookie).toBeTruthy()
    expect(login.cookie).not.toBe(pre.cookie)

    expect((await call('/auth/check-auth', { cookie: pre.cookie })).data.authenticated).toBe(false)
    const auth = await call('/auth/check-auth', { cookie: login.cookie })
    expect(auth.data.authenticated).toBe(true)
    expect(auth.data.user.id).toBe('1001')
  })

  it('Jellyfin login issues a new session and invalidates the pre-login one', async () => {
    const pre = await createPin(7, 'zz')
    mockJellyfinAuth('jfrotate', 'Rotator')
    const login = await call('/auth/jellyfin/login', { method: 'POST', body: { username: 'Rotator', password: 'pw' }, cookie: pre.cookie })
    expect(login.data.status).toBe('authorized')
    expect(login.cookie).not.toBe(pre.cookie)
    expect((await call('/auth/check-auth', { cookie: pre.cookie })).data.authenticated).toBe(false)
    expect((await call('/auth/check-auth', { cookie: login.cookie })).data.user.id).toBe('jf_jfrotate')
  })

  it('password admin login rotates the session and keeps the signed-in user', async () => {
    const userCookie = await jellyfinLogin('jfadmin', 'Owner')
    const admin = await call('/admin/login', { method: 'POST', body: { password: 'test-admin-password' }, cookie: userCookie })
    expect(admin.status).toBe(200)
    expect(admin.cookie).not.toBe(userCookie)
    expect((await call('/auth/check-auth', { cookie: userCookie })).data.authenticated).toBe(false)
    const auth = await call('/auth/check-auth', { cookie: admin.cookie })
    expect(auth.data.user).toMatchObject({ id: 'jf_jfadmin', isAdmin: true })
    expect((await call('/admin/users', { cookie: admin.cookie })).status).toBe(200)
  })
})

describe('Plex PIN is bound to the session that created it', () => {
  // plex.tv approves `pinId` for `user` and grants access to this server
  const plexApproves = (pinId, user) => mockPlexTv([
    [`/api/v2/pins/${pinId}`, { id: pinId, authToken: `TOKEN_${user.id}` }],
    ['/api/v2/user', { ...user, thumb: null, uuid: `uuid-${user.id}` }],
    ['/api/v2/resources', [{ clientIdentifier: 'test-server-id', accessToken: 'SERVER_TOKEN' }]],
  ])

  it('ignores a PIN planted through /auth/callback (crafted ?link=1 link to a Jellyfin user)', async () => {
    const victim = await jellyfinLogin('victimguid', 'Victim')
    const planted = await call('/auth/callback', { method: 'POST', body: { pinId: '4242', pinCode: 'attackercode', link: true }, cookie: victim })
    expect(planted.data).toEqual({ ok: false })
    plexApproves(4242, { id: 2002, username: 'attacker' })
    expect((await call('/auth/check-pin', { cookie: victim })).data.status).toBe('expired')
    expect(db.resolveCanonicalUserId('jf_victimguid')).toBe('jf_victimguid')
    expect((await call('/auth/check-auth', { cookie: victim })).data.user.id).toBe('jf_victimguid')
  })

  it('keeps polling its own PIN when the callback reports a different one', async () => {
    const { cookie } = await createPin(50, 'own')
    expect((await call('/auth/callback', { method: 'POST', body: { pinId: '51', pinCode: 'x' }, cookie })).data.ok).toBe(false)
    expect((await call('/auth/callback', { method: 'POST', body: { pinId: '50', pinCode: 'own' }, cookie })).data.ok).toBe(true)
    mockPlexTv([['/api/v2/pins/50', { id: 50 }]]) // pins/51 would fail the poll with 'error'
    expect((await call('/auth/check-pin', { cookie })).data.status).toBe('pending')
  })

  it('links a Jellyfin account only for a PIN created with link: true', async () => {
    const linker = await jellyfinLogin('linkme', 'Linker')
    await createPin(60, 'lnk', { cookie: linker, link: true })
    plexApproves(60, { id: 3001, username: 'linkerplex' })
    expect((await call('/auth/check-pin', { cookie: linker })).data.status).toBe('authorized')
    expect(db.resolveCanonicalUserId('jf_linkme')).toBe('3001')

    // A plain sign-in PIN stays a sign-in even if the callback asks for link mode
    const other = await jellyfinLogin('nolink', 'NoLink')
    await createPin(61, 'nl', { cookie: other })
    await call('/auth/callback', { method: 'POST', body: { pinId: '61', pinCode: 'nl', link: true }, cookie: other })
    plexApproves(61, { id: 3002, username: 'nolinkplex' })
    const login = await call('/auth/check-pin', { cookie: other })
    expect(login.data.status).toBe('authorized')
    expect(db.resolveCanonicalUserId('jf_nolink')).toBe('jf_nolink')
    expect((await call('/auth/check-auth', { cookie: login.cookie })).data.user.id).toBe('3002')
  })
})

describe('library access refresh at Plex sign-in', () => {
  const realSetTimeout = globalThis.setTimeout
  const sleep = (ms) => new Promise(resolve => realSetTimeout(resolve, ms))
  async function until(cond, ms = 3000) {
    for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(5)
    expect(cond()).toBe(true)
  }
  // plex.tv approves the PIN for `user`; calls made with the admin token (the
  // library-access sharing lookup) never answer until the test lets them fail
  let hanging, pinPolls, adminCalls
  function plexTvWithHangingSharing(pinId, user) {
    hanging = []; pinPolls = 0; adminCalls = 0
    globalThis.fetch = async (url, opts) => {
      const u = String(url)
      if (u.startsWith(base)) return realFetch(url, opts)
      const respond = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
      if (opts?.headers?.['X-Plex-Token'] === 'ADMIN_TOKEN') {
        adminCalls++
        return new Promise((resolve, reject) => hanging.push(reject))
      }
      if (u.includes(`/api/v2/pins/${pinId}`)) { pinPolls++; return respond({ id: pinId, authToken: `TOKEN_${user.id}` }) }
      if (u.includes('/api/v2/user')) return respond({ ...user, thumb: null, uuid: `uuid-${user.id}` })
      if (u.includes('/api/v2/resources')) return respond([{ clientIdentifier: 'test-server-id', accessToken: 'SERVER_TOKEN' }])
      throw new Error(`unexpected outbound request: ${u}`)
    }
  }

  beforeAll(() => {
    db.setSetting('plex_url', 'http://plex.invalid:32400')
    db.setSetting('plex_token', 'ADMIN_TOKEN')
  })
  afterAll(() => {
    db.prepare("DELETE FROM settings WHERE key IN ('plex_url', 'plex_token', 'owner_plex_user_id')").run()
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const reject of hanging || []) reject(new Error('test over'))
  })

  it('waits at most the bound for a hanging refresh, and an overlapping poll still finds the PIN', async () => {
    const pre = await createPin(77, 'hang')
    plexTvWithHangingSharing(77, { id: 4001, username: 'hanger' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let done = 0
    const first = call('/auth/check-pin', { cookie: pre.cookie }).then(r => { done++; return r })
    await until(() => adminCalls > 0) // the sign-in is waiting on the refresh
    // The Callback page polls again 2 s later, with the pre-login cookie
    const second = call('/auth/check-pin', { cookie: pre.cookie }).then(r => { done++; return r })
    await until(() => pinPolls === 2 && vi.getTimerCount() >= 2)
    expect(done).toBe(0)
    await vi.advanceTimersByTimeAsync(8_000)
    const [a, b] = await Promise.all([first, second])
    expect(a.data.status).toBe('authorized')
    expect(b.data.status).toBe('authorized') // not 'expired'
    expect((await call('/auth/check-auth', { cookie: a.cookie })).data.user.id).toBe('4001')
  })

  it('skips the refresh for the server owner', async () => {
    db.setOwnerUserId('4002')
    const pre = await createPin(78, 'own')
    plexTvWithHangingSharing(78, { id: 4002, username: 'owner' })
    const login = await call('/auth/check-pin', { cookie: pre.cookie })
    expect(login.data.status).toBe('authorized')
    expect(adminCalls).toBe(0)
  })
})

describe('session cookie behind a TLS-terminating proxy', () => {
  it('is Secure when a trusted (loopback) proxy reports https, plain otherwise', async () => {
    const viaTls = await createPin(9, 'tls', { headers: { 'X-Forwarded-Proto': 'https' } })
    expect(viaTls.setCookie).toMatch(/;\s*Secure/i)
    const plain = await createPin(9, 'tls')
    expect(plain.setCookie).toBeTruthy()
    expect(plain.setCookie).not.toMatch(/;\s*Secure/i)
  })
})

describe('check-auth identity DTO', () => {
  it('exposes identity and role flags but no provider tokens', async () => {
    const pre = await createPin(43, 'efgh')
    mockPlexTv([
      ['/api/v2/pins/43', { id: 43, authToken: 'PLEX_USER_TOKEN_2' }],
      ['/api/v2/user', { id: 1002, username: 'tokenuser', thumb: null, uuid: 'uuid-1002' }],
      ['/api/v2/resources', [{ clientIdentifier: 'test-server-id', accessToken: 'PLEX_SERVER_TOKEN_2' }]],
    ])
    const { cookie } = await call('/auth/check-pin', { cookie: pre.cookie })
    const auth = await call('/auth/check-auth', { cookie })
    expect(Object.keys(auth.data.user).sort()).toEqual(
      ['hasJellyfin', 'id', 'isAdmin', 'isElevated', 'isPlexLinked', 'provider', 'thumb', 'username'])
    expect(JSON.stringify(auth.data)).not.toMatch(/PLEX_USER_TOKEN|PLEX_SERVER_TOKEN|uuid-1002/)
    // The tokens stay server-side for the routes that call Plex as the user
    expect((await call('/test/session', { cookie })).data.token).toBe('PLEX_USER_TOKEN_2')
  })
})

describe('revoking a role applies to existing sessions', () => {
  it('a demoted admin loses privileged access on the next request', async () => {
    db.upsertJellyfinUser('jf_jfdemote', 'Demoted', null, null)
    db.setUserAdmin('jf_jfdemote', true)
    const cookie = await jellyfinLogin('jfdemote', 'Demoted')

    // 404 = past the privilege guard (no such request)
    expect((await call('/api/queue/999999/approve', { method: 'POST', cookie })).status).toBe(404)
    expect((await call('/api/queue/users', { cookie })).status).toBe(200)
    expect((await call('/api/riven/anything', { cookie })).status).toBe(200)
    expect((await call('/auth/check-auth', { cookie })).data.user.isAdmin).toBe(true)

    db.setUserAdmin('jf_jfdemote', false)
    expect((await call('/api/queue/999999/approve', { method: 'POST', cookie })).status).toBe(403)
    expect((await call('/api/queue/users', { cookie })).status).toBe(403)
    expect((await call('/api/riven/anything', { cookie })).status).toBe(403)
    expect((await call('/auth/check-auth', { cookie })).data.user).toMatchObject({ isAdmin: false, isElevated: false })

    db.setUserAdmin('jf_jfdemote', true)
    expect((await call('/api/queue/999999/approve', { method: 'POST', cookie })).status).toBe(404)
  })
})

describe('Diskovarr API key principal', () => {
  const key = { 'X-Api-Key': API_KEY }

  it('passes privileged guards without persisting a session', async () => {
    const approve = await call('/api/queue/999999/approve', { method: 'POST', headers: key })
    expect(approve.status).toBe(404)
    expect(approve.setCookie).toBeNull()
    expect((await call('/api/riven/anything', { headers: key })).status).toBe(200)

    const id = db.addDiscoverRequestWithStatus('someone', 550, 'movie', 'Fight Club', 'radarr', 1, 'pending')
    const deny = await call(`/api/queue/${id}/deny`, { method: 'POST', body: { note: 'no' }, headers: { Authorization: `Bearer ${API_KEY}` } })
    expect(deny.status).toBe(200)
    expect(db.getRequestById(id).status).toBe('denied')
    expect(deny.setCookie).toBeNull()
  })

  it('is refused by user-scoped endpoints instead of acting as a user', async () => {
    const add = await call('/api/watchlist/add', { method: 'POST', body: { ratingKey: '123' }, headers: key })
    expect(add.status).toBe(403)
    expect((await call('/api/request', { method: 'POST', body: { tmdbId: 1, mediaType: 'movie' }, headers: key })).status).toBe(403)
    for (const id of ['api-key', 'undefined']) {
      expect(db.getWatchlistFromDb(id)).toEqual([])
      expect(db.getKnownUserById(id)).toBeFalsy()
    }
  })

  it('rejects a wrong key', async () => {
    expect((await call('/api/queue', { headers: { 'X-Api-Key': 'nope' } })).status).toBe(401)
  })
})

// Plex PIN sign-in as `user` (fresh browser); returns the session cookie
async function plexLogin(pinId, user) {
  const pre = await createPin(pinId, `pin${pinId}`)
  mockPlexTv([
    [`/api/v2/pins/${pinId}`, { id: pinId, authToken: `TOKEN_${user.id}` }],
    ['/api/v2/user', { ...user, thumb: null, uuid: `uuid-${user.id}` }],
    ['/api/v2/resources', [{ clientIdentifier: 'test-server-id', accessToken: 'SERVER_TOKEN' }]],
  ])
  const login = await call('/auth/check-pin', { cookie: pre.cookie })
  globalThis.fetch = realFetch
  expect(login.data.status).toBe('authorized')
  return login.cookie
}

const linkJellyfin = (cookie, name) =>
  call('/api/user/link/jellyfin', { method: 'POST', body: { username: name, password: 'pw' }, cookie })

describe('link changes reach sessions in other browsers', () => {
  it('unlinking drops the Plex identity and its admin role from a Jellyfin sign-in elsewhere', async () => {
    const plex = await plexLogin(80, { id: 7001, username: 'adminplex' })
    db.setUserAdmin('7001', true)
    mockJellyfinAuth('jfrevoke', 'Revoke')
    expect((await linkJellyfin(plex, 'Revoke')).status).toBe(200)
    const jf = await jellyfinLogin('jfrevoke', 'Revoke')
    expect((await call('/auth/check-auth', { cookie: jf })).data.user).toMatchObject({ id: '7001', isAdmin: true })
    expect((await call('/api/queue/users', { cookie: jf })).status).toBe(200)

    expect((await call('/api/user/link/jellyfin', { method: 'DELETE', cookie: plex })).status).toBe(200)

    expect((await call('/api/queue/users', { cookie: jf })).status).toBe(403)
    expect((await call('/auth/check-auth', { cookie: jf })).data.user)
      .toMatchObject({ id: 'jf_jfrevoke', provider: 'jellyfin', isAdmin: false, isPlexLinked: false, hasJellyfin: true })
    expect((await call('/test/session', { cookie: jf })).data.token).toBeNull() // no Plex token left behind
    // The Plex sign-in itself is untouched
    expect((await call('/auth/check-auth', { cookie: plex })).data.user).toMatchObject({ id: '7001', isAdmin: true, hasJellyfin: false })
  })

  it('a standalone Jellyfin sign-in follows a link made in another browser', async () => {
    const jf = await jellyfinLogin('jfupgrade', 'Upgrade')
    const plex = await plexLogin(81, { id: 7002, username: 'upgradeplex' })
    mockJellyfinAuth('jfupgrade', 'Upgrade')
    expect((await linkJellyfin(plex, 'Upgrade')).status).toBe(200)
    expect((await call('/auth/check-auth', { cookie: jf })).data.user)
      .toMatchObject({ id: '7002', provider: 'jellyfin', isPlexLinked: true, hasJellyfin: true })
  })

  it('a Plex sign-in loses its attached Jellyfin account once unlinked from the Jellyfin side', async () => {
    const plex = await plexLogin(82, { id: 7003, username: 'dropplex' })
    mockJellyfinAuth('jfdrop', 'Drop')
    expect((await linkJellyfin(plex, 'Drop')).status).toBe(200)
    expect((await call('/api/user/link', { cookie: plex })).data.jellyfin).toMatchObject({ linked: true })
    const jf = await jellyfinLogin('jfdrop', 'Drop')
    expect((await call('/api/user/link/plex', { method: 'DELETE', cookie: jf })).status).toBe(200)

    expect((await call('/api/user/link', { cookie: plex })).data.jellyfin).toBeNull()
    expect((await call('/auth/check-auth', { cookie: plex })).data.user).toMatchObject({ id: '7003', hasJellyfin: false })
  })
})

describe('one Jellyfin account per Plex user', () => {
  it('refuses a second Jellyfin account from Settings, and re-linking the same one is fine', async () => {
    const plex = await plexLogin(83, { id: 7004, username: 'oneplex' })
    mockJellyfinAuth('jfone', 'One')
    expect((await linkJellyfin(plex, 'One')).status).toBe(200)
    expect((await linkJellyfin(plex, 'One')).status).toBe(200)
    mockJellyfinAuth('jftwo', 'Two')
    const second = await linkJellyfin(plex, 'Two')
    expect(second.status).toBe(409)
    expect(second.data.error).toMatch(/already has a Jellyfin account/)
    expect(db.resolveCanonicalUserId('jf_jftwo')).toBe('jf_jftwo')
    expect(db.getLinkedJellyfinRow('7004').user_id).toBe('jf_jfone')
  })

  it('lets only one of two concurrent links win', async () => {
    const plex = await plexLogin(84, { id: 7005, username: 'raceplex' })
    vi.spyOn(jellyfinService, 'isEnabled').mockReturnValue(true)
    vi.spyOn(jellyfinService, 'authenticateByName').mockImplementation(async (username) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { userId: `race${username}`, name: username, accessToken: `T_${username}`, primaryImageTag: null }
    })
    const results = await Promise.all([linkJellyfin(plex, 'A'), linkJellyfin(plex, 'B')])
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(db.prepare("SELECT COUNT(*) AS n FROM known_users WHERE linked_user_id = '7005'").get().n).toBe(1)
  })

  it('refuses the Plex sign-in link when that Plex account already has a Jellyfin account', async () => {
    const plex = await plexLogin(85, { id: 7006, username: 'takenplex' })
    mockJellyfinAuth('jftaken', 'Taken')
    expect((await linkJellyfin(plex, 'Taken')).status).toBe(200)

    const other = await jellyfinLogin('jfother', 'Other')
    await createPin(86, 'lnk2', { cookie: other, link: true })
    mockPlexTv([
      ['/api/v2/pins/86', { id: 86, authToken: 'TOKEN_7006' }],
      ['/api/v2/user', { id: 7006, username: 'takenplex', thumb: null, uuid: 'uuid-7006' }],
      ['/api/v2/resources', [{ clientIdentifier: 'test-server-id', accessToken: 'SERVER_TOKEN' }]],
    ])
    const res = await call('/auth/check-pin', { cookie: other })
    globalThis.fetch = realFetch
    expect(res.data.status).toBe('link_conflict')
    expect(db.resolveCanonicalUserId('jf_jfother')).toBe('jf_jfother')
    expect(db.getLinkedJellyfinRow('7006').user_id).toBe('jf_jftaken')
    expect((await call('/auth/check-auth', { cookie: other })).data.user.id).toBe('jf_jfother')
    expect((await call('/auth/check-pin', { cookie: other })).data.status).toBe('expired') // PIN consumed
  })
})

describe('Jellyfin credential attempts', () => {
  it('account linking shares the login limiter, so guessing through it is throttled too', async () => {
    const plex = await plexLogin(87, { id: 7007, username: 'guesser' })
    vi.spyOn(jellyfinService, 'isEnabled').mockReturnValue(true)
    vi.spyOn(jellyfinService, 'authenticateByName').mockResolvedValue(null)
    const statuses = []
    for (let i = 0; i < 21; i++) statuses.push((await linkJellyfin(plex, `victim${i}`)).status)
    expect(statuses.slice(0, 20).every(s => s === 401)).toBe(true)
    expect(statuses[20]).toBe(429)
    // ...and the budget is shared with the sign-in form
    expect((await call('/auth/jellyfin/login', { method: 'POST', body: { username: 'x', password: 'y' } })).status).toBe(429)
  })
})
