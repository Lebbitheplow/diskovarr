import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createRequestHarness } from './helpers/requestApp.js'

const h = createRequestHarness()
const { db } = h
const fulfillment = h.nodeRequire('../../server/services/requestFulfillment.js')

beforeAll(async () => {
  db.upsertKnownUser('alice', 'alice', null, null)
  db.upsertKnownUser('boss', 'boss', null, null)
  db.setUserAdmin('boss', true)
  await h.start()
})
afterAll(() => h.stop())
beforeEach(() => h.reset())
afterEach(() => vi.restoreAllMocks())

// ── F13: missing-season requests ──────────────────────────────────────────────

describe('season-gated availability (F13)', () => {
  // Library show with seasons 1–3; TMDB lists five 10-episode seasons
  function setupShow(librarySeasons) {
    h.addLibraryShow({ ratingKey: 'show246', tmdbId: 246, title: 'Partial Show' })
    db.setTmdbCache(246, 'tv', {
      tmdbId: 246, mediaType: 'tv', title: 'Partial Show', numberOfSeasons: 5,
      seasonDetails: [1, 2, 3, 4, 5].map(n => ({ number: n, episodeCount: 10 })),
    })
    const state = { seasons: librarySeasons }
    vi.spyOn(h.plex, 'getShowSeasons').mockImplementation(async () =>
      Object.entries(state.seasons).map(([number, episodeCount]) => ({ number: Number(number), episodeCount })))
    return state
  }

  it('is not stamped available at creation and waits for the requested season', async () => {
    const library = setupShow({ 1: 10, 2: 10, 3: 10 })
    const res = await h.call('POST', '/api/request', { body: { tmdbId: 246, mediaType: 'tv', title: 'Partial Show', service: 'none', seasons: [4] } })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT * FROM discover_requests WHERE tmdb_id = 246').get()
    expect(row).toMatchObject({ season_gated: 1, notified_available_at: null })

    // The show-level check no longer fulfills it…
    fulfillment.checkAndNotifyFulfilled('test')
    expect(db.getRequestById(row.id).notified_available_at).toBeNull()
    const queue = await h.call('GET', '/api/queue')
    expect(queue.data.requests[0].displayStatus).toBe('requested')
    // …and it stays editable while the season is missing
    h.enableOverseerr()
    h.setResponder(() => Response.json({ id: 1 }))
    expect((await h.call('PUT', `/api/queue/${row.id}`, { body: { service: 'overseerr', seasons: [4] } })).status).toBe(200)
    expect(db.getRequestById(row.id)).toMatchObject({ season_gated: 1, notified_available_at: null })

    // Absent, then partial: still waiting
    expect(await fulfillment.checkSeasonGatedRequests('test')).toBe(0)
    library.seasons[4] = 6
    expect(await fulfillment.checkSeasonGatedRequests('test')).toBe(0)
    expect(db.getRequestById(row.id).notified_available_at).toBeNull()

    // Complete: exactly one availability event
    library.seasons[4] = 10
    expect(await fulfillment.checkSeasonGatedRequests('test')).toBe(1)
    expect(await fulfillment.checkSeasonGatedRequests('test')).toBe(0)
    expect(db.getRequestById(row.id).notified_available_at).toBeTruthy()
    expect(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'alice' AND type = 'request_available'").get().c).toBe(1)
    expect((await h.call('GET', '/api/queue')).data.requests[0].displayStatus).toBe('available')
  })

  it('needs every season of a multi-season request', async () => {
    const library = setupShow({ 1: 10, 2: 10, 3: 10 })
    await h.call('POST', '/api/request', { body: { tmdbId: 246, mediaType: 'tv', title: 'Partial Show', service: 'none', seasons: [4, 5] } })
    library.seasons[4] = 10
    expect(await fulfillment.checkSeasonGatedRequests('test')).toBe(0)
    library.seasons[5] = 10
    expect(await fulfillment.checkSeasonGatedRequests('test')).toBe(1)
  })

  it('leaves whole-show requests on show-level availability', async () => {
    db.setTmdbCache(300, 'tv', { tmdbId: 300, mediaType: 'tv', title: 'Whole', numberOfSeasons: 2, seasonDetails: [{ number: 1, episodeCount: 8 }, { number: 2, episodeCount: 8 }] })
    await h.call('POST', '/api/request', { body: { tmdbId: 300, mediaType: 'tv', title: 'Whole', service: 'none' } })
    // Naming every season of a show the library doesn't have yet is the whole show too
    await h.call('POST', '/api/request', { body: { tmdbId: 300, mediaType: 'tv', title: 'Whole', service: 'none', seasons: [1, 2] }, user: 'boss' })
    expect(db.prepare('SELECT season_gated FROM discover_requests WHERE tmdb_id = 300').all()).toEqual([{ season_gated: 0 }, { season_gated: 0 }])
    h.addLibraryShow({ ratingKey: 'show300', tmdbId: 300 })
    expect(fulfillment.checkAndNotifyFulfilled('test')).toBe(2)
  })

  it('gates an every-season list when the show is already in the library', async () => {
    setupShow({ 1: 10, 2: 4, 3: 10, 4: 1, 5: 2 })
    await h.call('POST', '/api/request', { body: { tmdbId: 246, mediaType: 'tv', title: 'Partial Show', service: 'none', seasons: [1, 2, 3, 4, 5] } })
    expect(db.prepare('SELECT season_gated FROM discover_requests WHERE tmdb_id = 246').get().season_gated).toBe(1)
    expect(fulfillment.checkAndNotifyFulfilled('test')).toBe(0)
  })

  it('pins a whole-show selection on an in-library show to its seasons, so it stays gated', async () => {
    setupShow({ 1: 10, 2: 10, 3: 10 })
    h.enableOverseerr()
    h.setResponder(() => Response.json({ id: 1 }))
    await h.call('POST', '/api/request', { body: { tmdbId: 246, mediaType: 'tv', title: 'Partial Show', service: 'none', seasons: [4] } })
    const id = db.prepare('SELECT id FROM discover_requests WHERE tmdb_id = 246').get().id
    // Edit → "Select all"
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { service: 'overseerr', seasons: 'all' } })).status).toBe(200)
    expect(db.getRequestById(id)).toMatchObject({ season_gated: 1, seasons_json: '[1,2,3,4,5]', seasons_count: 5 })
    expect(fulfillment.checkAndNotifyFulfilled('test')).toBe(0)
    expect(db.getRequestById(id).notified_available_at).toBeNull()
    // A whole-show request for a show the library already has is pinned the same way
    expect((await h.call('POST', '/api/request', { body: { tmdbId: 246, mediaType: 'tv', title: 'Partial Show', service: 'none' }, user: 'boss' })).status).toBe(200)
    expect(db.prepare("SELECT seasons_json, season_gated FROM discover_requests WHERE user_id = 'boss'").get())
      .toEqual({ seasons_json: '[1,2,3,4,5]', season_gated: 1 })
  })
})

// ── F14: Sonarr season selection ──────────────────────────────────────────────

describe('Sonarr season selection fails closed (F14)', () => {
  const submit = (extra = {}) => h.api.submitRequestToService({ tmdbId: 123, tvdbId: 456, mediaType: 'tv', title: 'Show', service: 'sonarr', seasons: [4], ...extra })

  function sonarr({ lookup = 'ok', existing = false, command = 201 } = {}) {
    return (url, opts = {}) => {
      const method = opts.method || 'GET'
      if (url.endsWith('/qualityprofile')) return Response.json([{ id: 1 }])
      if (url.endsWith('/rootfolder')) return Response.json([{ path: '/tv' }])
      if (url.endsWith('/languageprofile')) return Response.json([{ id: 1 }])
      if (url.includes('/series/lookup')) {
        return lookup === 'ok'
          ? Response.json([{ tvdbId: 456, seasons: [1, 2, 3, 4].map(n => ({ seasonNumber: n, monitored: true })) }])
          : new Response('unavailable', { status: 503 })
      }
      if (url.endsWith('/api/v3/series') && method === 'POST') {
        return existing ? new Response('already added', { status: 400 }) : Response.json({ id: 77 })
      }
      if (url.includes('/series?tvdbId=')) {
        return Response.json(existing ? [{ id: 77, tvdbId: 456, monitored: true, seasons: [1, 2, 3, 4].map(n => ({ seasonNumber: n, monitored: n < 4 })) }] : [])
      }
      if (url.includes('/series/77') && method === 'PUT') return Response.json(JSON.parse(opts.body))
      if (url.endsWith('/command')) return new Response(command < 300 ? '{}' : 'nope', { status: command })
      return Response.json([])
    }
  }
  beforeEach(() => h.enableSonarr())

  it('never adds a new series monitoring every season when the lookup fails', async () => {
    h.setResponder(sonarr({ lookup: 'fail' }))
    await expect(submit()).rejects.toThrow(/season lookup failed/)
    expect(h.outbound.some(o => o.url.endsWith('/api/v3/series') && o.method === 'POST')).toBe(false)
  })

  it('sends only the selected seasons as monitored when the lookup works', async () => {
    h.setResponder(sonarr())
    await submit()
    const post = h.outbound.find(o => o.url.endsWith('/api/v3/series') && o.method === 'POST')
    expect(JSON.parse(post.body).seasons.filter(s => s.monitored).map(s => s.seasonNumber)).toEqual([4])
  })

  it('still updates a series Sonarr already has when the lookup fails', async () => {
    h.setResponder(sonarr({ lookup: 'fail', existing: true }))
    await submit()
    const put = h.outbound.find(o => o.method === 'PUT')
    expect(JSON.parse(put.body).seasons.find(s => s.seasonNumber === 4).monitored).toBe(true)
  })

  it('fails when Sonarr rejects the season search command', async () => {
    h.setResponder(sonarr({ existing: true, command: 500 }))
    await expect(submit()).rejects.toThrow(/SeasonSearch failed.*HTTP 500/)
  })
})

// ── F15: editing an approved request ──────────────────────────────────────────

describe('editing an approved request (F15)', () => {
  it('reports a failed re-submission, flags the row, and retries on the next save', async () => {
    h.enableRadarr()
    const id = db.addDiscoverRequestWithStatus('alice', 555, 'movie', 'Edited', 'none', 1, 'approved')
    h.setResponder(h.radarrResponder({ addStatus: 500 }))
    const failed = await h.call('PUT', `/api/queue/${id}`, { body: { service: '' } })
    expect(failed.status).toBe(502)
    expect(failed.data.error).toMatch(/Save again to retry/)
    // The routing actually attempted is what's stored, flagged as not sent
    expect(db.getRequestById(id)).toMatchObject({ service: 'radarr' })
    expect(db.getRequestById(id).submit_error).toMatch(/Radarr error/)
    expect(h.queued('request_process_failed')).toHaveLength(1)

    h.setResponder(h.radarrResponder())
    const retried = await h.call('PUT', `/api/queue/${id}`, { body: { service: 'radarr' } })
    expect(retried.status).toBe(200)
    expect(db.getRequestById(id)).toMatchObject({ service: 'radarr', submit_error: null })
    expect(h.outbound.filter(o => o.url.endsWith('/api/v3/movie')).length).toBe(2)
  })

  it('submits the seasons it stores', async () => {
    h.enableOverseerr()
    db.setTmdbCache(777, 'tv', { tmdbId: 777, mediaType: 'tv', title: 'S', numberOfSeasons: 3, seasonDetails: [1, 2, 3].map(n => ({ number: n, episodeCount: 5 })) })
    const id = db.addDiscoverRequestWithStatus('alice', 777, 'tv', 'S', 'overseerr', 1, 'approved', [1])
    h.setResponder(() => Response.json({ id: 1 }))
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { service: 'overseerr', seasons: 'all' } })).status).toBe(200)
    const sent = JSON.parse(h.outbound.find(o => o.url.endsWith('/api/v1/request')).body)
    expect(sent.seasons).toBe('all')
    expect(db.getRequestById(id)).toMatchObject({ seasons_json: null, seasons_count: 3, season_gated: 0 })
  })

  it('keeps the stored seasons when an edit sends none (YouTube / TVDB-only rows)', async () => {
    h.enableSonarr()
    const seasons = [2024, 2025, 2026]
    h.setResponder((url, opts = {}) => {
      const method = opts.method || 'GET'
      if (url.endsWith('/qualityprofile')) return Response.json([{ id: 1 }])
      if (url.endsWith('/rootfolder')) return Response.json([{ path: '/tv' }])
      if (url.endsWith('/languageprofile')) return Response.json([{ id: 1 }])
      if (url.endsWith('/tag')) return Response.json([{ id: 7, label: 'yt' }])
      if (url.includes('/series/lookup')) return Response.json([{ tvdbId: 998877, seasons: seasons.map(n => ({ seasonNumber: n, monitored: true })) }])
      if (url.endsWith('/api/v3/series') && method === 'POST') return new Response('already added', { status: 400 })
      if (url.includes('/series?tvdbId=')) return Response.json([{ id: 41, tvdbId: 998877, seasons: seasons.map(n => ({ seasonNumber: n, monitored: n === 2026 })) }])
      if (url.includes('/series/41') && method === 'PUT') return Response.json(JSON.parse(opts.body))
      if (url.endsWith('/command')) return Response.json({})
      return Response.json({})
    })
    const id = db.addDiscoverRequestWithStatus('alice', 0, 'tv', 'Channel', 'sonarr', 1, 'approved', [2026], null,
      { tvdbId: 998877, downloader: 'youtube', seasonGated: true })
    for (const body of [{ service: 'sonarr', seasons: [] }, { service: 'sonarr' }, { service: 'sonarr', seasons: null }]) {
      h.outbound.length = 0
      expect((await h.call('PUT', `/api/queue/${id}`, { body })).status).toBe(200)
      expect(db.getRequestById(id)).toMatchObject({ seasons_json: '[2026]', seasons_count: 1, season_gated: 1 })
      const commands = h.outbound.filter(o => o.url.endsWith('/command')).map(o => JSON.parse(o.body))
      expect(commands).toEqual([{ name: 'SeasonSearch', seriesId: 41, seasonNumber: 2026 }])
    }
  })
})
