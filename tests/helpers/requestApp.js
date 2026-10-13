// Shared harness for the request-policy suites: a throwaway database, the real
// API/admin/shim routers on an ephemeral port, a session faked from headers,
// and a scripted outbound fetch so no connector is ever contacted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export function createRequestHarness() {
  // The db module resolves its data dir at import time; point it at a
  // throwaway directory BEFORE loading so tests never open the live database.
  process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-secret'

  // Node's CommonJS loader so every module shares one db instance and spies
  // on module objects are seen by the code under test.
  const nodeRequire = createRequire(import.meta.url)
  const express = nodeRequire('../../server/node_modules/express')
  const db = nodeRequire('../../server/db/database.js')
  const tmdb = nodeRequire('../../server/services/tmdb.js')
  const plex = nodeRequire('../../server/services/plex.js')
  const agents = nodeRequire('../../server/services/notificationAgents/index.js')
  const api = nodeRequire('../../server/routes/api.js')
  const admin = nodeRequire('../../server/routes/admin.js')
  const shim = nodeRequire('../../server/routes/overseerrShim.js')

  // Capture provider deliveries: enqueueForUser writes one queue row per active agent
  agents.manager.register('test-capture', { shouldSend: () => true, shouldSendType: () => true, send: async () => {} })

  const realFetch = globalThis.fetch
  const outbound = []
  let responder = () => Response.json({})
  globalThis.fetch = async (url, opts = {}) => {
    outbound.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? String(opts.body) : null })
    return responder(String(url), opts)
  }

  const app = express()
  app.use(express.json())
  app.use((req, res, next) => {
    req.session = {}
    const user = req.get('x-test-user')
    if (user) req.session.plexUser = { id: user, username: user, provider: 'plex', token: null }
    const role = req.get('x-test-role')
    if (role === 'admin') req.session.isPlexAdminUser = true
    if (role === 'panel') req.session.isAdmin = true
    next()
  })
  app.use('/api/v1', shim)
  app.use('/api', api)
  app.use('/admin', admin)

  let server = null
  let base = ''
  async function start() {
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${server.address().port}`
  }
  async function stop() {
    if (server) await new Promise(resolve => server.close(resolve))
    globalThis.fetch = realFetch
  }
  async function call(method, route, { body, user = 'alice', role, headers = {} } = {}) {
    const res = await realFetch(base + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(user ? { 'x-test-user': user } : {}),
        ...(role ? { 'x-test-role': role } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data }
  }

  function reset() {
    for (const table of ['discover_requests', 'notifications', 'notification_queue', 'library_items',
      'watchlist_auto_requests', 'watchlist_auto_request_state', 'list_source_items']) {
      try { db.prepare(`DELETE FROM ${table}`).run() } catch { /* table absent */ }
    }
    db.setGlobalRequestLimits({ enabled: false, movieLimit: 0, movieWindowDays: 7, seasonLimit: 0, seasonWindowDays: 7 })
    for (const [k, v] of Object.entries(BASE_SETTINGS)) db.setSetting(k, v)
    outbound.length = 0
    responder = () => Response.json({})
  }

  const BASE_SETTINGS = {
    discover_enabled: '1', tmdb_api_key: 'test-key',
    auto_approve_movies: '1', auto_approve_tv: '1',
    radarr_enabled: '0', radarr_url: '', radarr_api_key: '',
    sonarr_enabled: '0', sonarr_url: '', sonarr_api_key: '',
    overseerr_enabled: '0', overseerr_url: '', overseerr_api_key: '',
    riven_enabled: '0', default_request_service: 'overseerr', direct_request_access: '0',
    auto_request_watchlist_movies: 'false', auto_request_watchlist_tv: 'false',
    // Harness users have no library-access snapshot (they would see no library);
    // suites that test per-user library access switch enforcement back on
    library_access_enforced: '0',
  }

  function enableRadarr() {
    db.setSetting('radarr_enabled', '1')
    db.setSetting('radarr_url', 'http://radarr.invalid')
    db.setSetting('radarr_api_key', 'k')
  }
  function enableSonarr() {
    db.setSetting('sonarr_enabled', '1')
    db.setSetting('sonarr_url', 'http://sonarr.invalid')
    db.setSetting('sonarr_api_key', 'k')
  }
  function enableOverseerr() {
    db.setSetting('overseerr_enabled', '1')
    db.setSetting('overseerr_url', 'http://overseerr.invalid')
    db.setSetting('overseerr_api_key', 'k')
  }

  // Minimal happy-path Radarr: profiles, root folders, add movie
  function radarrResponder({ addStatus = 201, delayMs = 0 } = {}) {
    return async (url) => {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
      if (url.endsWith('/qualityprofile')) return Response.json([{ id: 1 }])
      if (url.endsWith('/rootfolder')) return Response.json([{ path: '/media' }])
      if (url.endsWith('/api/v3/movie')) return new Response(addStatus < 300 ? '{"id":1}' : 'boom', { status: addStatus })
      return Response.json({})
    }
  }

  function addLibraryShow({ ratingKey, tmdbId, title = 'Show', source = 'plex' }) {
    db.prepare("INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id, source) VALUES (?, '2', ?, 'show', ?, ?)")
      .run(String(ratingKey), title, String(tmdbId), source)
  }
  function addLibraryMovie({ ratingKey, tmdbId, title = 'Movie' }) {
    db.prepare("INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id, source) VALUES (?, '1', ?, 'movie', ?, 'plex')")
      .run(String(ratingKey), title, String(tmdbId))
  }

  function queued(type) {
    return db.prepare("SELECT * FROM notification_queue WHERE agent = 'test-capture'").all()
      .map(r => ({ ...r, payload: JSON.parse(r.payload) }))
      .filter(r => !type || r.payload.type === type)
  }

  return {
    db, tmdb, plex, api, admin, shim, agents, nodeRequire,
    outbound, setResponder: (fn) => { responder = fn },
    start, stop, call, reset,
    enableRadarr, enableSonarr, enableOverseerr, radarrResponder,
    addLibraryShow, addLibraryMovie, queued,
  }
}
