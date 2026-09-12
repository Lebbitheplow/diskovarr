import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Admin → Setup: DUMB Traktless guided installer. The db module runs
// migrations at require time — point it at a scratch dir first.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-dumb-setup-test-'))
process.env.DISKOVARR_DATA_DIR = DATA_DIR
process.env.TUBERR_MANAGED = '0'
process.env.DISKOVARR_DISABLE_DOCKER = '1'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const dumbClient = nodeRequire('../server/services/dumbClient.js')
const installer = nodeRequire('../server/services/dumbInstaller.js')
const plexLib = nodeRequire('../server/services/plexLibrarySetup.js')
const setup = nodeRequire('../server/services/dumbSetup.js')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; dumbClient._resetToken(); vi.restoreAllMocks() })

// Routes: [method, urlNeedle] → body | (url, opts) => body. Records every call.
function mockFetch(routes) {
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url)
    const method = (opts.method || 'GET').toUpperCase()
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} })
    for (const [key, body] of routes) {
      const [m, needle] = key.split(' ')
      if (m === method && u.includes(needle)) {
        const payload = typeof body === 'function' ? body(u, opts) : body
        const status = payload?.__status || 200
        return { ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) }
      }
    }
    return { ok: false, status: 404, json: async () => ({ detail: 'nope' }), text: async () => JSON.stringify({ detail: 'nope' }) }
  }
  return calls
}

beforeAll(() => {
  db.setSetting('plex_url', 'http://plex.test:32400')
  db.setSetting('plex_token', 'ptoken')
  db.setSetting('tmdb_api_key', 'tmdbkey')
})

describe('dumbClient', () => {
  it('probe logs in when DUMB auth is on and detects the Traktless provisioning API', async () => {
    dumbClient.saveConfig({ url: 'http://dumb.test:8000', username: 'admin', password: 'pw' })
    const calls = mockFetch([
      ['GET /health', { status: 'healthy' }],
      ['GET /auth/status', { enabled: true, has_users: true }],
      ['POST /auth/login', { access_token: 'tok', refresh_token: 'r' }],
      ['GET /process/capabilities', { diskovarr: true }],
      ['GET /diskovarr/provision/capabilities', { provision: true, services: [] }],
    ])
    const p = await dumbClient.probe()
    expect(p).toMatchObject({ reachable: true, authEnabled: true, loggedIn: true, traktless: true, provision: true })
    const login = calls.find(c => c.url.includes('/auth/login'))
    expect(login.body).toEqual({ username: 'admin', password: 'pw' })
    const caps = calls.find(c => c.url.includes('/process/capabilities'))
    expect(caps.headers.Authorization).toBe('Bearer tok')
  })

  it('probe reports stock DUMB without the provisioning API', async () => {
    dumbClient.saveConfig({ url: 'http://dumb.test:8000' })
    mockFetch([
      ['GET /health', { status: 'healthy' }],
      ['GET /auth/status', { enabled: false }],
      ['GET /process/capabilities', { seerr_sync: true }],
    ])
    const p = await dumbClient.probe()
    expect(p.loggedIn).toBe(true)
    expect(p.traktless).toBe(false)
    expect(p.provision).toBe(false)
  })

  it('probe does not mistake another service with a /health route for DUMB', async () => {
    dumbClient.saveConfig({ url: 'http://other.test:8000' })
    mockFetch([['GET /health', { ok: true }]])
    const p = await dumbClient.probe()
    expect(p.reachable).toBe(false)
    expect(p.error).toMatch(/not the DUMB API/)
  })

  it('probe surfaces unreachable hosts without throwing', async () => {
    dumbClient.saveConfig({ url: 'http://dumb.test:8000' })
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const p = await dumbClient.probe()
    expect(p.reachable).toBe(false)
    expect(p.error).toMatch(/ECONNREFUSED/)
  })
})

describe('plexLibrarySetup', () => {
  const sections = { MediaContainer: { Directory: [
    { key: 1, type: 'movie', title: 'Movies', agent: 'tv.plex.agents.movie', scanner: 'Plex Movie', language: 'en-US', Location: [{ path: '/NAS/Movies' }] },
    { key: 2, type: 'show', title: 'TV', agent: 'tv.plex.agents.series', scanner: 'Plex TV Series', language: 'en-US', Location: [{ path: '/NAS/TV' }] },
    { key: 4, type: 'artist', title: 'Music', Location: [] },
  ] } }

  it('lists only video libraries with their locations', async () => {
    mockFetch([['GET /library/sections', sections]])
    const libs = await plexLib.listLibraries()
    expect(libs.map(l => l.id)).toEqual(['1', '2'])
    expect(libs[0].locations).toEqual(['/NAS/Movies'])
  })

  it('addLocation resends the existing folders plus the new one and is idempotent', async () => {
    const calls = mockFetch([['GET /library/sections', sections], ['PUT /library/sections/1', {}]])
    const r = await plexLib.addLocation('1', '/mnt/debrid/library/movies')
    expect(r.added).toBe(true)
    const put = calls.find(c => c.method === 'PUT')
    const url = new URL(put.url)
    expect(url.searchParams.getAll('location')).toEqual(['/NAS/Movies', '/mnt/debrid/library/movies'])
    const again = await plexLib.addLocation('1', '/NAS/Movies')
    expect(again.added).toBe(false)
  })

  it('applyLibraryPrefs only sends settings the library exposes', async () => {
    const prefs = { MediaContainer: { Setting: [
      { id: 'enableBIFGeneration', value: 'true' }, { id: 'enableIntroMarkerGeneration', value: 'true' }, { id: 'collectionMode', value: '2' },
    ] } }
    const calls = mockFetch([['GET /library/sections/2/prefs', prefs], ['PUT /library/sections/2/prefs', {}]])
    const applied = await plexLib.applyLibraryPrefs('2', 'show')
    expect(applied).toEqual({ enableBIFGeneration: '0', enableIntroMarkerGeneration: '0', collectionMode: '2' })
    const put = new URL(calls.find(c => c.method === 'PUT').url)
    expect(put.searchParams.get('enableIntroMarkerGeneration')).toBe('0')
    expect(put.searchParams.has('enableCreditsMarkerGeneration')).toBe(false)
  })

  it('server prefs keep auto-empty-trash off and partial scans on', async () => {
    const calls = mockFetch([['PUT /:/prefs', {}]])
    await plexLib.applyServerPrefs()
    const put = new URL(calls[0].url)
    expect(put.searchParams.get('autoEmptyTrash')).toBe('0')
    expect(put.searchParams.get('FSEventLibraryPartialScanEnabled')).toBe('1')
    expect(put.searchParams.get('ScheduledLibraryUpdateInterval')).toBe('1800')
  })

  it('pathVisibleToPlex uses Plex’s browser and treats errors as not visible', async () => {
    mockFetch([['GET /services/browse', { MediaContainer: { Path: [] } }]])
    expect(await plexLib.pathVisibleToPlex('/mnt/debrid')).toBe(true)
    mockFetch([])
    expect(await plexLib.pathVisibleToPlex('/nope')).toBe(false)
  })

  it('setupLibrary creates a library when no section is given', async () => {
    const created = { MediaContainer: { Directory: [{ key: 9, type: 'movie', title: 'Movies', Location: [{ path: '/x/movies' }] }] } }
    const calls = mockFetch([
      ['POST /library/sections', {}],
      ['GET /library/sections/9/prefs', { MediaContainer: { Setting: [{ id: 'enableBIFGeneration', value: 'true' }] } }],
      ['PUT /library/sections/9/prefs', {}],
      ['GET /library/sections/9/refresh', {}],
      ['GET /library/sections', created],
    ])
    const r = await plexLib.setupLibrary({ type: 'movie', path: '/x/movies' })
    expect(r.sectionId).toBe('9')
    expect(r.steps.map(s => s.step)).toEqual(['create', 'prefs', 'scan'])
    const post = new URL(calls.find(c => c.method === 'POST').url)
    expect(post.searchParams.get('agent')).toBe('tv.plex.agents.movie')
    expect(post.searchParams.get('location')).toBe('/x/movies')
  })
})

describe('dumbInstaller', () => {
  it('composeYaml embeds the image, host networking and the debrid mount', () => {
    const yaml = installer.composeYaml({ image: 'example/dumb:1' })
    expect(yaml).toContain('image: example/dumb:1')
    expect(yaml).toContain('network_mode: host')
    expect(yaml).toContain('./mnt/debrid:/mnt/debrid:shared')
  })

  it('sanitizeDir rejects the filesystem root', () => {
    expect(() => installer.sanitizeDir('/')).toThrow()
    expect(installer.sanitizeDir('/tmp/x/../dumb')).toBe('/tmp/dumb')
  })

  it('install falls back to manual mode when docker is unavailable', async () => {
    const r = await installer.install({ dir: path.join(DATA_DIR, 'dumb') })
    expect(r.ok).toBe(false)
    expect(r.manual).toBe(true)
    expect(r.compose).toContain('container_name: DUMB')
  })
})

describe('dumbSetup', () => {
  it('validateDebrid accepts AllDebrid and rejects a bad key', async () => {
    mockFetch([['GET api.alldebrid.com', { status: 'success', data: { user: { username: 'kaleb', isPremium: true, premiumUntil: 1800000000 } } }]])
    const r = await setup.validateDebrid('alldebrid', 'k')
    expect(r).toMatchObject({ provider: 'alldebrid', username: 'kaleb', premium: true })
    mockFetch([['GET api.alldebrid.com', { status: 'error', error: { code: 'AUTH_BAD_APIKEY' } }]])
    await expect(setup.validateDebrid('alldebrid', 'bad')).rejects.toThrow(/rejected/)
    await expect(setup.validateDebrid('torbox', 'x')).rejects.toThrow(/Unknown/)
  })

  it('validateDebrid handles Real-Debrid', async () => {
    mockFetch([['GET api.real-debrid.com', { username: 'rd', type: 'premium', expiration: '2027-01-01T00:00:00Z' }]])
    const r = await setup.validateDebrid('realdebrid', 'tok')
    expect(r).toMatchObject({ provider: 'realdebrid', premium: true })
    mockFetch([['GET api.real-debrid.com', { __status: 401 }]])
    await expect(setup.validateDebrid('realdebrid', 'tok')).rejects.toThrow(/rejected/)
  })

  it('buildPlan validates input, generates the Diskovarr API key and carries TMDB + Plex', () => {
    db.setSetting('diskovarr_api_key', '')
    const plan = setup.buildPlan({ debrid: { provider: 'alldebrid', apiKey: ' ad ' }, services: ['zilean'], diskovarrUrl: 'http://127.0.0.1:3232/', libraryPath: '' })
    expect(plan.debrid).toEqual({ provider: 'alldebrid', api_key: 'ad' })
    expect(plan.diskovarr.url).toBe('http://127.0.0.1:3232')
    expect(plan.diskovarr.api_key).toHaveLength(64)
    expect(db.getSetting('diskovarr_api_key')).toBe(plan.diskovarr.api_key)
    expect(plan.tmdb_api_key).toBe('tmdbkey')
    expect(plan.plex).toEqual({ url: 'http://plex.test:32400', token: 'ptoken' })
    expect(plan.library_path).toBe('/mnt/debrid/library')
    expect(() => setup.buildPlan({ debrid: { provider: 'x', apiKey: 'k' }, diskovarrUrl: 'http://a' })).toThrow(/AllDebrid or Real-Debrid/)
    expect(() => setup.buildPlan({ debrid: { provider: 'alldebrid', apiKey: 'k' }, diskovarrUrl: 'nope' })).toThrow(/http/)
  })

  it('buildPlan adds Tautulli when Plex is connected without it, and leaves it alone otherwise', () => {
    db.setSetting('tautulli_url', '')
    expect(setup.tautulliRequired()).toBe(true)
    const plan = setup.buildPlan({ debrid: { provider: 'alldebrid', apiKey: 'k' }, services: ['zilean'], diskovarrUrl: 'http://127.0.0.1:3232' })
    expect(plan.services).toEqual(['zilean', 'tautulli'])
    db.setSetting('tautulli_url', 'http://tautulli.test:8181')
    expect(setup.tautulliRequired()).toBe(false)
    const plan2 = setup.buildPlan({ debrid: { provider: 'alldebrid', apiKey: 'k' }, services: ['zilean'], diskovarrUrl: 'http://127.0.0.1:3232' })
    expect(plan2.services).toEqual(['zilean'])
    db.setSetting('tautulli_url', '')
  })

  it('applyPlexStep in manual mode maps container paths to the Plex-side prefix', async () => {
    const r = await setup.applyPlexStep({ mode: 'manual', hostPathPrefix: '/home/me/docker/DUMB/mnt/debrid/' }, { movies: '/mnt/debrid/library/movies', shows: '/mnt/debrid/library/shows' })
    expect(r.mode).toBe('manual')
    expect(r.paths.movies).toBe('/home/me/docker/DUMB/mnt/debrid/library/movies')
    expect(r.instructions.folders[1].path).toBe('/home/me/docker/DUMB/mnt/debrid/library/shows')
  })

  it('applyPlexStep in auto mode refuses folders Plex cannot see and attaches the ones it can', async () => {
    vi.spyOn(plexLib, 'pathVisibleToPlex').mockImplementation(async (p) => p.endsWith('/movies'))
    vi.spyOn(plexLib, 'setupLibrary').mockResolvedValue({ sectionId: '1', steps: [] })
    vi.spyOn(plexLib, 'applyServerPrefs').mockResolvedValue({ autoEmptyTrash: '0' })
    const r = await setup.applyPlexStep({ mode: 'auto', hostPathPrefix: '', movieSectionId: '1', showSectionId: '2' }, { movies: '/mnt/debrid/library/movies', shows: '/mnt/debrid/library/shows' })
    expect(r.libraries.movie.ok).toBe(true)
    expect(r.libraries.show.ok).toBe(false)
    expect(r.libraries.show.error).toMatch(/cannot see/)
    expect(plexLib.setupLibrary).toHaveBeenCalledWith({ type: 'movie', path: '/mnt/debrid/library/movies', sectionId: '1' })
    expect(r.serverPrefs).toEqual({ autoEmptyTrash: '0' })
  })

  it('apply drives DUMB, then flips Diskovarr to DUMB pull mode and persists the job', async () => {
    setup.reset()
    vi.spyOn(dumbClient, 'provisionStart').mockResolvedValue({ running: true })
    vi.spyOn(dumbClient, 'provisionStatus').mockResolvedValue({
      running: false, ok: true, steps: [{ key: 'debrid', label: 'Start', status: 'done' }],
      result: { riven: { url: 'http://127.0.0.1:8082', has_api_key: true }, paths: { movies: '/mnt/debrid/library/movies', shows: '/mnt/debrid/library/shows' } },
    })
    const job = await setup.apply({ debrid: { provider: 'realdebrid', apiKey: 'rd' }, services: [], diskovarrUrl: 'http://127.0.0.1:3232', plex: { mode: 'manual', hostPathPrefix: '/host/debrid' } })
    expect(job.running).toBe(true)
    await vi.waitFor(() => { if (setup.status()?.running) throw new Error('still running') }, { timeout: 10000, interval: 50 })
    const final = setup.status()
    expect(final.ok).toBe(true)
    expect(final.steps.map(s => `${s.key}:${s.status}`)).toEqual(['dumb:done', 'provision:done', 'connections:done', 'plex:done'])
    expect(dumbClient.provisionStart.mock.calls[0][0].debrid).toEqual({ provider: 'realdebrid', api_key: 'rd' })
    expect(db.getSetting('riven_url')).toBe('http://127.0.0.1:8082')
    expect(db.getSetting('riven_enabled')).toBe('1')
    expect(db.getSetting('dumb_request_mode')).toBe('pull')
    expect(db.getSetting('default_request_service')).toBe('riven')
    expect(final.result.plex.paths.movies).toBe('/host/debrid/library/movies')
    expect(JSON.parse(db.getSetting('dumb_setup_state')).ok).toBe(true)
    await expect(setup.apply({ debrid: { provider: 'alldebrid', apiKey: 'x' }, diskovarrUrl: 'http://a' })).resolves.toBeTruthy()
  })

  it('apply records a failed DUMB run against the running step', async () => {
    setup.reset()
    vi.spyOn(dumbClient, 'provisionStart').mockResolvedValue({ running: true })
    vi.spyOn(dumbClient, 'provisionStatus').mockResolvedValue({ running: false, ok: false, errors: ['Zurg w/ Riven failed to start'] })
    await setup.apply({ debrid: { provider: 'realdebrid', apiKey: 'rd' }, diskovarrUrl: 'http://127.0.0.1:3232' })
    await vi.waitFor(() => { if (setup.status()?.running) throw new Error('still running') }, { timeout: 10000, interval: 50 })
    const final = setup.status()
    expect(final.ok).toBe(false)
    expect(final.errors[0]).toMatch(/Zurg/)
    expect(final.steps.find(s => s.key === 'provision').status).toBe('error')
  })
})
