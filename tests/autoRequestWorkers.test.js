import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequestHarness } from './helpers/requestApp.js'

const h = createRequestHarness()
const { db } = h
const automation = h.nodeRequire('../../server/db/automation.js')
const listSources = h.nodeRequire('../../server/services/listSources/index.js')
const autoRequest = h.nodeRequire('../../server/services/autoRequest.js')
const watchlistAutoRequest = h.nodeRequire('../../server/services/watchlistAutoRequest.js')

beforeAll(async () => {
  db.upsertKnownUser('boss', 'boss', null, null)
  db.setUserAdmin('boss', true)
  await h.start()
})
afterAll(() => h.stop())
beforeEach(() => {
  h.reset()
  h.enableRadarr()
  vi.spyOn(h.tmdb, 'getItemDetails').mockImplementation(async (id, type) => ({
    tmdbId: Number(id), mediaType: type, title: `Title ${id}`, posterUrl: null,
    ...(type === 'tv' ? { numberOfSeasons: 2, seasonDetails: [{ number: 1, episodeCount: 6 }, { number: 2, episodeCount: 6 }] } : {}),
  }))
})
afterEach(() => vi.restoreAllMocks())

// ── F16: monitored-list retries ───────────────────────────────────────────────

describe('monitored-list auto-request retries (F16)', () => {
  function makeList(name) {
    const id = automation.createListSource({ name, sourceType: 'imdb', url: 'https://www.imdb.com/chart/top/', approvalMode: 'auto', mediaType: 'movie', collectionEnabled: false })
    vi.spyOn(listSources, 'fetchList').mockResolvedValue([{ tmdbId: 885533, mediaType: 'movie', title: 'Auto Request Failure' }])
    vi.spyOn(listSources, 'resolveEntries').mockImplementation(async entries => ({ items: entries, unresolved: [] }))
    return id
  }

  it('re-submits the same request row on the next sync after a failure', async () => {
    const listId = makeList('Retry list')
    const submit = vi.spyOn(h.api, 'submitRequestToService').mockRejectedValueOnce(new Error('download service unavailable'))
    const first = await autoRequest.syncList(automation.getListSource(listId))
    expect(first.failed).toBe(1)
    const row = db.prepare('SELECT * FROM discover_requests WHERE tmdb_id = 885533').get()
    expect(row.submit_error).toMatch(/unavailable/)

    submit.mockResolvedValue(undefined)
    const second = await autoRequest.syncList(automation.getListSource(listId))
    expect(second).toMatchObject({ requested: 1, failed: 0 })
    expect(submit).toHaveBeenCalledTimes(2)
    const rows = db.prepare('SELECT * FROM discover_requests WHERE tmdb_id = 885533').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'approved', submit_error: null })
    expect(automation.getListItems(listId)[0]).toMatchObject({ status: 'requested', requestId: rows[0].id })

    // Settled: a third sync submits nothing
    await autoRequest.syncList(automation.getListSource(listId))
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('recovers rows stranded by the old behaviour (failed item, no request link)', async () => {
    const listId = makeList('Legacy list')
    const stale = db.addDiscoverRequestWithStatus(autoRequest.SYSTEM_USER_ID, 885533, 'movie', 'Auto Request Failure', 'radarr', 1, 'approved')
    db.setRequestOriginList(stale, listId)
    automation.upsertListItem({ listId, tmdbId: 885533, mediaType: 'movie', title: 'Auto Request Failure', status: 'failed' })
    const submit = vi.spyOn(h.api, 'submitRequestToService').mockResolvedValue(undefined)
    const summary = await autoRequest.syncList(automation.getListSource(listId))
    expect(summary.requested).toBe(1)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM discover_requests WHERE tmdb_id = 885533').get().c).toBe(1)
  })

  it('settles a failed item the Queue already resent instead of posting it again', async () => {
    const listId = makeList('Resent list')
    let radarrUp = false
    let alreadyAdded = false
    h.setResponder(async (url, opts = {}) => {
      if (url.endsWith('/qualityprofile')) return Response.json([{ id: 1 }])
      if (url.endsWith('/rootfolder')) return Response.json([{ path: '/media' }])
      if (url.endsWith('/api/v3/movie') && opts.method === 'POST') {
        if (!radarrUp) return new Response('radarr down', { status: 503 })
        if (alreadyAdded) return Response.json([{ errorMessage: 'This movie has already been added' }], { status: 400 })
        alreadyAdded = true
        return Response.json({ id: 1 }, { status: 201 })
      }
      return Response.json({})
    })
    const posts = () => h.outbound.filter(o => o.method === 'POST' && o.url.endsWith('/api/v3/movie')).length

    expect((await autoRequest.syncList(automation.getListSource(listId))).failed).toBe(1)
    const row = db.prepare('SELECT * FROM discover_requests WHERE tmdb_id = 885533').get()
    expect(row.submit_error).toBeTruthy()

    // The admin re-saves the 'Not sent' row from the Queue
    radarrUp = true
    expect((await h.call('PUT', `/api/queue/${row.id}`, { user: 'boss', role: 'admin', body: { service: 'radarr' } })).status).toBe(200)
    expect(db.getRequestById(row.id).submit_error).toBeNull()
    const sent = posts()

    const next = await autoRequest.syncList(automation.getListSource(listId))
    expect(next.failed).toBe(0)
    expect(posts()).toBe(sent)
    expect(db.getRequestById(row.id).submit_error).toBeNull()
    expect(automation.getListItems(listId)[0]).toMatchObject({ status: 'requested', requestId: row.id })
  })
})

// ── F12: watchlist auto-request worker ────────────────────────────────────────

describe('watchlist auto-request worker (F12)', () => {
  // Plex.tv watchlist per token: [{ key, tmdbId, type, title }]
  const watchlists = {}
  function plexTv(url, opts = {}) {
    const token = opts.headers?.['X-Plex-Token']
    const list = watchlists[token] || []
    if (url.includes('/library/sections/watchlist/all')) {
      return Response.json({ MediaContainer: { Metadata: list.map(i => ({ ratingKey: i.key })) } })
    }
    if (url.includes('metadata.provider.plex.tv/library/metadata/')) {
      const keys = url.split('/library/metadata/')[1].split('?')[0].split(',')
      return Response.json({ MediaContainer: { Metadata: list.filter(i => keys.includes(i.key)).map(i => ({
        ratingKey: i.key, type: i.type || 'movie', title: i.title || `Title ${i.tmdbId}`, Guid: [{ id: `tmdb://${i.tmdbId}` }],
      })) } })
    }
    return Response.json({})
  }
  const item = (tmdbId, extra = {}) => ({ key: `k${tmdbId}`, tmdbId, ...extra })
  let submit

  beforeEach(() => {
    db.upsertKnownUser('wl', 'Watcher', null, 'TOKEN-WL')
    db.upsertKnownUser('other', 'Other', null, 'TOKEN-OTHER')
    db.setUserPreferences('wl', { auto_request_movies: false, auto_request_tv: false })
    db.setUserPreferences('other', { auto_request_movies: false, auto_request_tv: false })
    watchlists['TOKEN-WL'] = [item(1001), item(1002)]
    watchlists['TOKEN-OTHER'] = [item(2001)]
    h.setResponder(plexTv)
    submit = vi.spyOn(h.api, 'submitRequestToService').mockResolvedValue(undefined)
  })
  const requestsFor = (userId) => db.prepare('SELECT * FROM discover_requests WHERE user_id = ? ORDER BY id').all(userId)

  it('does nothing while the feature is off', async () => {
    await watchlistAutoRequest.run()
    expect(h.outbound.some(o => o.url.includes('plex.tv'))).toBe(false)
    expect(requestsFor('wl')).toHaveLength(0)
  })

  it('requests titles added after it was enabled, once, through the request policy', async () => {
    db.setSetting('auto_request_watchlist_movies', 'true')
    expect((await watchlistAutoRequest.run()).baselined).toBe(3) // both users' existing items
    expect(requestsFor('wl')).toHaveLength(0)

    h.addLibraryMovie({ ratingKey: 'lib1004', tmdbId: 1004 })
    db.addDiscoverRequestWithStatus('boss', 1005, 'movie', 'Already wanted', 'radarr', 1, 'approved')
    watchlists['TOKEN-WL'].push(item(1003), item(1004), item(1005), item(1006, { type: 'show' }))
    const summary = await watchlistAutoRequest.run()
    expect(summary.requested).toBe(1)
    const rows = requestsFor('wl')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tmdb_id: 1003, status: 'approved', service: 'radarr', media_type: 'movie' })
    expect(submit).toHaveBeenCalledTimes(1)
    // TV wasn't enabled, the library title and the already-requested one are skipped
    await watchlistAutoRequest.run()
    expect(requestsFor('wl')).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('honours the per-user flag on its own and re-baselines after being turned off', async () => {
    h.enableSonarr()
    db.setUserPreferences('wl', { auto_request_tv: true })
    watchlists['TOKEN-WL'] = [item(3001, { type: 'show' })]
    await watchlistAutoRequest.run()
    watchlists['TOKEN-WL'].push(item(3002, { type: 'show' }))
    watchlists['TOKEN-OTHER'].push(item(3003, { type: 'show' }))
    await watchlistAutoRequest.run()
    expect(requestsFor('wl').map(r => [r.tmdb_id, r.seasons_count])).toEqual([[3002, 2]])
    expect(requestsFor('other')).toHaveLength(0)

    db.setUserPreferences('wl', { auto_request_tv: false })
    await watchlistAutoRequest.run()
    watchlists['TOKEN-WL'].push(item(3004, { type: 'show' }))
    db.setUserPreferences('wl', { auto_request_tv: true })
    await watchlistAutoRequest.run() // fresh baseline includes 3004
    expect(requestsFor('wl')).toHaveLength(1)
  })

  it('stays idle while requests (Discover) are off and re-baselines when they return', async () => {
    db.setSetting('auto_request_watchlist_movies', 'true')
    await watchlistAutoRequest.run()
    db.setSetting('discover_enabled', '0')
    watchlists['TOKEN-WL'].push(item(1010))
    h.outbound.length = 0
    const off = await watchlistAutoRequest.run()
    expect(off).toMatchObject({ users: 0, requested: 0, pending: 0 })
    expect(h.outbound.some(o => o.url.includes('plex.tv'))).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(requestsFor('wl')).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS c FROM watchlist_auto_request_state').get().c).toBe(0)

    // Back on: what was watchlisted meanwhile is baseline, not a backlog
    db.setSetting('discover_enabled', '1')
    const back = await watchlistAutoRequest.run()
    expect(back).toMatchObject({ requested: 0, baselined: 4 })
    expect(requestsFor('wl')).toHaveLength(0)
  })

  it('waits out the quota and retries later', async () => {
    db.setSetting('auto_request_watchlist_movies', 'true')
    await watchlistAutoRequest.run()
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 1, movieWindowDays: 7, seasonLimit: 0, seasonWindowDays: 7 })
    db.addDiscoverRequestWithStatus('wl', 999, 'movie', 'Earlier', 'radarr', 1, 'approved')
    watchlists['TOKEN-WL'].push(item(1007))
    expect((await watchlistAutoRequest.run()).limited).toBe(1)
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 2, movieWindowDays: 7, seasonLimit: 0, seasonWindowDays: 7 })
    expect((await watchlistAutoRequest.run()).requested).toBe(1)
    expect(requestsFor('wl').map(r => r.tmdb_id)).toEqual([999, 1007])
  })
})

// ── JF-11: collections quick sync change detection on dual-server installs ───

describe('collections quick sync change detection (JF-11)', () => {
  const plexCollections = h.nodeRequire('../../server/services/plexCollections.js')
  const row = (key, source, syncedAt) => db.prepare(
    "INSERT OR REPLACE INTO library_items (rating_key, section_id, title, type, tmdb_id, source, synced_at) VALUES (?, ?, ?, 'movie', ?, ?, ?)"
  ).run(key, source === 'plex' ? '1' : 'jf_f', key, key.replace(/\D/g, ''), source, syncedAt)

  afterEach(() => {
    for (const k of ['plex_url', 'plex_token', 'jellyfin_url', 'jellyfin_api_key', 'jellyfin_enabled']) db.setSetting(k, '')
  })

  it('a title imported only into Jellyfin triggers the next pass', async () => {
    db.setSetting('plex_url', 'http://plex.test:32400')
    db.setSetting('plex_token', 'token')
    db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
    db.setSetting('jellyfin_api_key', 'key')
    db.setSetting('jellyfin_enabled', '1')
    const now = Math.floor(Date.now() / 1000)
    row('p1', 'plex', now - 600)
    const listId = automation.createListSource({ name: 'Dual', sourceType: 'imdb', url: 'https://www.imdb.com/chart/top/', mediaType: 'movie', collectionEnabled: true })
    automation.upsertListItem({ listId, tmdbId: 1, mediaType: 'movie', title: 'P1', status: 'in_library', position: 1 })
    automation.updateListSource(listId, { lastSyncedAt: now - 60 })
    const mirror = vi.spyOn(plexCollections, 'syncListCollection').mockResolvedValue({})

    await autoRequest.runQuickSync({ force: true })
    mirror.mockClear()
    expect(await autoRequest.runQuickSync()).toEqual({ skipped: 'no new library items' })

    row('j2', 'jellyfin', now + 120) // Plex unchanged
    const result = await autoRequest.runQuickSync()
    expect(result.updated).toBeGreaterThanOrEqual(1)
    expect(mirror.mock.calls.map(([list]) => list.id)).toContain(listId)
  })
})
