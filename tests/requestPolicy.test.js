import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequestHarness } from './helpers/requestApp.js'

const h = createRequestHarness()
const { db } = h

const TWELVE_SEASONS = {
  tmdbId: 123, mediaType: 'tv', title: 'Twelve Seasons', numberOfSeasons: 12,
  seasonDetails: Array.from({ length: 12 }, (_, i) => ({ number: i + 1, episodeCount: 10 })),
}

beforeAll(async () => {
  db.upsertKnownUser('alice', 'alice', null, null)
  db.upsertKnownUser('bob', 'bob', null, null)
  db.upsertKnownUser('boss', 'boss', null, null)
  db.setUserAdmin('boss', true)
  await h.start()
})
afterAll(() => h.stop())
beforeEach(() => {
  h.reset()
  vi.spyOn(h.tmdb, 'getItemDetails').mockImplementation(async (id, type) => (type === 'tv' ? { ...TWELVE_SEASONS, tmdbId: Number(id) } : null))
})
afterEach(() => vi.restoreAllMocks())

const movie = (tmdbId, extra = {}) => ({ tmdbId, mediaType: 'movie', title: `Movie ${tmdbId}`, service: 'none', ...extra })
const show = (tmdbId, extra = {}) => ({ tmdbId, mediaType: 'tv', title: `Show ${tmdbId}`, service: 'none', ...extra })

// ── S06: direct request access ────────────────────────────────────────────────

describe('direct_request_access (S06)', () => {
  // Legacy 'admin'/'all' keep what they did in practice: the old client only
  // restricted on '1', and the admin toggle showed a stored 'admin' as off
  it('normalizes the stored 0/1 and legacy all/admin values', () => {
    for (const [stored, expected] of [['1', '1'], ['true', '1'], ['admin', '0'], ['0', '0'], ['all', '0'], ['', '0']]) {
      db.setSetting('direct_request_access', stored)
      expect(db.getDirectRequestAccess()).toBe(expected)
    }
  })

  it('shows a legacy stored admin as it behaved (everyone) and saves canonical values', async () => {
    vi.spyOn(h.nodeRequire('../../server/services/tuberrProcess.js'), 'sync').mockImplementation(() => {})
    db.setSetting('direct_request_access', 'admin')
    const got = await h.call('GET', '/admin/connections/settings', { role: 'panel' })
    expect(got.status).toBe(200)
    expect(got.data.direct_request_access).toBe('0')
    expect((await h.call('POST', '/admin/connections/save', { role: 'panel', body: { direct_request_access: '1' } })).status).toBe(200)
    expect(db.getSetting('direct_request_access')).toBe('1')
    expect((await h.call('GET', '/admin/connections/settings', { role: 'panel' })).data.direct_request_access).toBe('1')
    expect((await h.call('POST', '/admin/connections/save', { role: 'panel', body: { direct_request_access: '0' } })).status).toBe(200)
    expect((await h.call('GET', '/admin/connections/settings', { role: 'panel' })).data.direct_request_access).toBe('0')
  })

  it('refuses an alternate Radarr pick from a regular user when admin-only', async () => {
    h.enableRadarr(); h.enableOverseerr()
    db.setSetting('direct_request_access', '1')
    h.setResponder(h.radarrResponder())
    const res = await h.call('POST', '/api/request', { body: movie(501, { service: 'radarr' }) })
    expect(res.status).toBe(403)
    expect(h.outbound.some(o => o.url.includes('radarr'))).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS c FROM discover_requests').get().c).toBe(0)
    const services = await h.call('GET', '/api/explore/services')
    expect(services.data.directAllowed).toBe(false)
  })

  it('still lets admins pick it, and everyone use it when it is the default app', async () => {
    h.enableRadarr(); h.enableOverseerr()
    db.setSetting('direct_request_access', '1')
    h.setResponder(h.radarrResponder())
    expect((await h.call('POST', '/api/request', { body: movie(502, { service: 'radarr' }), user: 'boss', role: 'admin' })).status).toBe(200)
    // Elevated (privileged, not Plex admin) users count as admins here
    expect((await h.call('POST', '/api/request', { body: movie(503, { service: 'radarr' }), user: 'boss' })).status).toBe(200)
    db.setSetting('default_request_service', 'direct')
    expect((await h.call('POST', '/api/request', { body: movie(504, { service: 'radarr' }) })).status).toBe(200)
  })

  it('blocks switching an existing request to the direct app on edit', async () => {
    h.enableRadarr(); h.enableOverseerr()
    db.setSetting('direct_request_access', '1')
    const id = db.addDiscoverRequestWithStatus('alice', 505, 'movie', 'Pending', 'overseerr', 1, 'pending')
    const res = await h.call('PUT', `/api/queue/${id}`, { body: { service: 'radarr' } })
    expect(res.status).toBe(403)
    expect(db.getRequestById(id).service).toBe('overseerr')
  })

  it('rejects a service that cannot handle the media type', async () => {
    h.enableRadarr()
    expect((await h.call('POST', '/api/request', { body: show(506, { service: 'radarr' }) })).status).toBe(400)
  })

  it('resolves "Default" on an approved edit to the default app, not the direct one', async () => {
    h.enableRadarr(); h.enableOverseerr()
    db.setSetting('direct_request_access', '1')
    h.setResponder(() => Response.json({ id: 1 }))
    const id = db.addDiscoverRequestWithStatus('alice', 507, 'movie', 'Approved', 'overseerr', 1, 'approved')
    for (const service of ['', 'none']) {
      expect((await h.call('PUT', `/api/queue/${id}`, { body: { service } })).status).toBe(200)
      expect(db.getRequestById(id).service).toBe('overseerr')
    }
    expect(h.outbound.some(o => o.url.includes('radarr'))).toBe(false)
    expect(h.outbound.filter(o => o.url.endsWith('/api/v1/request') && o.method === 'POST')).toHaveLength(2)
  })

  it('checks a TVDB-only claim against TMDB before letting it reach Sonarr', async () => {
    h.enableSonarr(); h.enableOverseerr()
    db.setSetting('direct_request_access', '1')
    db.setSetting('auto_approve_tv', '0')
    const find = vi.spyOn(h.tmdb, 'tmdbFetchPublic').mockResolvedValue({ tv_results: [{ id: 1396 }] })
    const body = { tvdbId: 81189, mediaType: 'tv', title: 'Known Show', service: 'sonarr' }
    // TMDB knows it: the ordinary direct-access gate applies
    expect((await h.call('POST', '/api/request', { body })).status).toBe(403)
    expect(find).toHaveBeenCalledWith('/find/81189?external_source=tvdb_id')
    // TMDB can't be asked: refused rather than trusted
    find.mockRejectedValue(new Error('TMDB down'))
    expect((await h.call('POST', '/api/request', { body })).status).toBe(503)
    expect(db.prepare('SELECT COUNT(*) AS c FROM discover_requests').get().c).toBe(0)
    // Really absent from TMDB: Sonarr is its only app, for everyone
    find.mockResolvedValue({ tv_results: [] })
    expect((await h.call('POST', '/api/request', { body })).status).toBe(200)
    // An admin's TVDB-only request for a TMDB show is stored under its TMDB id
    find.mockResolvedValue({ tv_results: [{ id: 1396 }] })
    expect((await h.call('POST', '/api/request', { body, user: 'boss' })).status).toBe(200)
    expect(db.prepare('SELECT user_id, tmdb_id FROM discover_requests ORDER BY id').all())
      .toEqual([{ user_id: 'alice', tmdb_id: 0 }, { user_id: 'boss', tmdb_id: 1396 }])
    expect(h.outbound.some(o => o.url.endsWith('/api/v3/series') && o.method === 'POST')).toBe(false)
  })

  it('accepts the YouTube downloader only while YouTube requests are enabled', async () => {
    h.enableSonarr(); h.enableOverseerr()
    db.setSetting('direct_request_access', '1')
    db.setSetting('auto_approve_tv', '0')
    const yt = show(1396, { service: 'sonarr', downloader: 'youtube', youtube: { channelId: 'UC1', channelTitle: 'Chan', playlistIds: [] } })
    try {
      const refused = await h.call('POST', '/api/request', { body: yt })
      expect(refused.status).toBe(400)
      expect(refused.data.error).toMatch(/YouTube requests are not enabled/)
      db.setSetting('youtube_enabled', '1'); db.setSetting('tuberr_url', 'http://tuberr.invalid'); db.setSetting('tuberr_api_key', 'k')
      expect((await h.call('POST', '/api/request', { body: yt })).status).toBe(200)
      // The flag doesn't open Sonarr to an ordinary pick
      expect((await h.call('POST', '/api/request', { body: show(1397, { service: 'sonarr' }) })).status).toBe(403)
    } finally {
      db.setSetting('youtube_enabled', '0'); db.setSetting('tuberr_url', ''); db.setSetting('tuberr_api_key', '')
    }
  })
})

// ── S07: quotas ───────────────────────────────────────────────────────────────

describe('request quotas (S07)', () => {
  it('charges a whole-show request every season TMDB lists', async () => {
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 0, movieWindowDays: 7, seasonLimit: 5, seasonWindowDays: 7 })
    const refused = await h.call('POST', '/api/request', { body: show(123) })
    expect(refused.status).toBe(429)
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 0, movieWindowDays: 7, seasonLimit: 20, seasonWindowDays: 7 })
    expect((await h.call('POST', '/api/request', { body: show(123) })).status).toBe(200)
    const row = db.prepare('SELECT seasons_count, seasons_json, season_gated FROM discover_requests WHERE tmdb_id = 123').get()
    expect(row).toEqual({ seasons_count: 12, seasons_json: null, season_gated: 0 })
    expect(db.countRecentSeasonRequests('alice', 7)).toBe(12)
  })

  it('refuses when the season count is unknown and a season limit applies', async () => {
    h.tmdb.getItemDetails.mockResolvedValue(null)
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 0, movieWindowDays: 7, seasonLimit: 50, seasonWindowDays: 7 })
    expect((await h.call('POST', '/api/request', { body: show(124) })).status).toBe(503)
    expect((await h.call('POST', '/api/request', { body: show(124, { seasons: [1, 2] }) })).status).toBe(200)
  })

  it('serializes concurrent requests so they cannot exceed the window', async () => {
    h.enableRadarr()
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 1, movieWindowDays: 7, seasonLimit: 0, seasonWindowDays: 7 })
    h.setResponder(h.radarrResponder({ delayMs: 25 }))
    const results = await Promise.all([
      h.call('POST', '/api/request', { body: movie(601, { service: 'radarr' }) }),
      h.call('POST', '/api/request', { body: movie(602, { service: 'radarr' }) }),
    ])
    expect(results.map(r => r.status).sort()).toEqual([200, 429])
    expect(db.countRecentMovieRequests('alice', 7)).toBe(1)
    expect(h.outbound.filter(o => o.url.endsWith('/api/v3/movie')).length).toBe(1)
  })

  it('refuses a duplicate of the same title by the same user', async () => {
    expect((await h.call('POST', '/api/request', { body: movie(701) })).status).toBe(200)
    const dup = await h.call('POST', '/api/request', { body: movie(701) })
    expect(dup.status).toBe(409)
    expect(dup.data.requestId).toBeTruthy()
    // Another user may still request it
    expect((await h.call('POST', '/api/request', { body: movie(701), user: 'bob' })).status).toBe(200)
    // TV: covered seasons are duplicates, new seasons are not
    expect((await h.call('POST', '/api/request', { body: show(702, { seasons: [1] }) })).status).toBe(200)
    expect((await h.call('POST', '/api/request', { body: show(702, { seasons: [1] }) })).status).toBe(409)
    expect((await h.call('POST', '/api/request', { body: show(702, { seasons: [2] }) })).status).toBe(200)
    expect(db.prepare("SELECT COUNT(*) AS c FROM discover_requests WHERE user_id = 'alice'").get().c).toBe(3)
  })

  it('re-prices an edited TV request against the quota', async () => {
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 0, movieWindowDays: 7, seasonLimit: 5, seasonWindowDays: 7 })
    db.setSetting('auto_approve_tv', '0')
    expect((await h.call('POST', '/api/request', { body: show(123, { seasons: [1] }) })).data.pending).toBe(true)
    const id = db.prepare('SELECT id FROM discover_requests WHERE tmdb_id = 123').get().id
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { seasons: 'all' } })).status).toBe(429)
    expect(db.getRequestById(id).seasons_count).toBe(1)
    // No season list keeps the stored selection rather than meaning the whole show
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { seasons: null } })).status).toBe(200)
    expect(db.getRequestById(id)).toMatchObject({ seasons_json: '[1]', seasons_count: 1 })
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { seasons: [1, 2, 3] } })).status).toBe(200)
    expect(db.getRequestById(id)).toMatchObject({ seasons_count: 3, season_gated: 1 })
  })

  it('charges a whole-show TVDB-only request the seasons Sonarr lists, never a flat 1', async () => {
    h.enableSonarr()
    db.setSetting('auto_approve_tv', '0')
    vi.spyOn(h.tmdb, 'tmdbFetchPublic').mockResolvedValue({ tv_results: [] })
    const lookup = (url) => url.includes('/series/lookup?term=tvdb:81189')
      ? Response.json([{ tvdbId: 81189, seasons: [0, 1, 2, 3].map(n => ({ seasonNumber: n })) }])
      : Response.json({})
    const body = { tvdbId: 81189, mediaType: 'tv', title: 'Web Series', service: 'sonarr' }
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 0, movieWindowDays: 7, seasonLimit: 2, seasonWindowDays: 7 })
    h.setResponder(lookup)
    expect((await h.call('POST', '/api/request', { body })).status).toBe(429)
    // Season count unknown while a limit applies: refused like a TMDB show
    h.setResponder(() => new Response('down', { status: 503 }))
    expect((await h.call('POST', '/api/request', { body })).status).toBe(503)
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 0, movieWindowDays: 7, seasonLimit: 5, seasonWindowDays: 7 })
    h.setResponder(lookup)
    expect((await h.call('POST', '/api/request', { body })).status).toBe(200)
    expect(db.prepare('SELECT seasons_count FROM discover_requests').get().seasons_count).toBe(3)
  })

  it('refuses to widen an approved request for a user who needs approval', async () => {
    h.enableOverseerr()
    db.setSetting('auto_approve_tv', '0')
    h.setResponder(() => Response.json({ id: 1 }))
    const id = db.addDiscoverRequestWithStatus('alice', 123, 'tv', 'Twelve Seasons', 'overseerr', 1, 'approved', [1], null, { seasonGated: true })
    for (const seasons of ['all', [1, 2]]) {
      expect((await h.call('PUT', `/api/queue/${id}`, { body: { service: 'overseerr', seasons } })).status).toBe(403)
    }
    expect(h.outbound).toHaveLength(0)
    expect(db.getRequestById(id)).toMatchObject({ status: 'approved', seasons_json: '[1]', seasons_count: 1 })
    // Re-sending what was approved still works, and admins may widen it
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { service: 'overseerr', seasons: [1] } })).status).toBe(200)
    expect((await h.call('PUT', `/api/queue/${id}`, { body: { service: 'overseerr', seasons: 'all' }, user: 'boss', role: 'admin' })).status).toBe(200)
    expect(db.getRequestById(id)).toMatchObject({ seasons_json: null, seasons_count: 12 })
  })

  it('admin per-user saves apply the override and leave the user\'s own preferences alone', async () => {
    db.upsertKnownUser('carol', 'carol', null, null)
    db.setUserPreferences('carol', { review_privacy: 'private', show_mature: true, ui_language: 'de', landing_page: 'explore', auto_request_movies: true, region: 'DE' })
    db.setPreferredSource('carol', 'jellyfin')
    db.setTasteQuizState('carol', 'done')
    const own = () => db.prepare('SELECT review_privacy, show_mature, ui_language, preferred_source, taste_quiz_state FROM user_request_limits WHERE user_id = ?').get('carol')
    const OWN = { review_privacy: 'private', show_mature: 1, ui_language: 'de', preferred_source: 'jellyfin', taste_quiz_state: 'done' }

    // The user settings modal's payload
    const modal = {
      movieLimit: 2, seasonLimit: 4, movieWindowDays: 7, tvWindowDays: 7, overrideGlobal: '1',
      auto_approve_movies: null, auto_approve_tv: null, is_admin: '0', region: 'DE', language: null,
      auto_request_movies: '1', auto_request_tv: '0', landing_page: 'explore',
    }
    expect((await h.call('POST', '/admin/users/carol/settings', { role: 'panel', body: modal })).status).toBe(200)
    expect(own()).toEqual(OWN)
    expect((await h.call('GET', '/admin/users/carol/settings', { role: 'panel' })).data.overrideGlobal).toBe(true)
    expect(db.getEffectiveLimits('carol')).toMatchObject({ movieLimit: 2, seasonLimit: 4 })

    // Older clients' spelling still works; omitted fields are untouched
    expect((await h.call('POST', '/admin/users/carol/settings', { role: 'panel', body: { override_global: '0' } })).status).toBe(200)
    expect(db.getUserSettings('carol')).toMatchObject({ overrideGlobal: false, movieLimit: 2, auto_request_movies: true, landing_page: 'explore' })

    // Bulk edit and the request-limits route keep landing page, region and auto-request too
    expect((await h.call('POST', '/admin/users/bulk-settings', { role: 'panel', body: { userIds: ['carol'], is_admin: 'revoke' } })).status).toBe(200)
    expect((await h.call('POST', '/admin/request-limits/user', { role: 'panel', body: { userId: 'carol', overrideEnabled: '1', movieLimit: 3 } })).status).toBe(200)
    expect(own()).toEqual(OWN)
    expect(db.getUserSettings('carol')).toMatchObject({ overrideGlobal: true, movieLimit: 3, region: 'DE', auto_request_movies: true, landing_page: 'explore' })
  })

  it('refuses a non-Discord personal webhook from the admin modal before writing anything', async () => {
    const before = db.getUserSettings('carol')
    const res = await h.call('POST', '/admin/users/carol/settings', { role: 'panel', body: {
      movieLimit: 9, notificationPrefs: { discord_webhook: 'http://127.0.0.1:9999/internal' },
    } })
    expect(res.status).toBe(400)
    expect(db.getUserSettings('carol').movieLimit).toBe(before.movieLimit)
    const ok = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123'
    expect((await h.call('POST', '/admin/users/carol/settings', { role: 'panel', body: { notificationPrefs: { discord_webhook: ` ${ok} ` } } })).status).toBe(200)
    expect(db.getUserNotificationPrefs('carol').discord_webhook).toBe(ok)
  })
})

// ── S08: Notify me ────────────────────────────────────────────────────────────

describe('Notify me followers (S08)', () => {
  it('cannot create an approved request for an unrequested or denied title', async () => {
    expect((await h.call('POST', '/api/explore/follow', { body: { tmdbId: 801, mediaType: 'movie' } })).status).toBe(409)
    db.addDiscoverRequestWithStatus('bob', 802, 'movie', 'Denied', 'radarr', 1, 'denied')
    expect((await h.call('POST', '/api/explore/follow', { body: { tmdbId: 802, mediaType: 'movie' } })).status).toBe(409)
    expect(db.prepare("SELECT COUNT(*) AS c FROM discover_requests WHERE user_id = 'alice'").get().c).toBe(0)
  })

  it('attaches to a live request without quota, hidden from pull consumers, and still gets notified', async () => {
    const targetId = db.addDiscoverRequestWithStatus('bob', 803, 'movie', 'Wanted', 'none', 1, 'approved')
    db.setGlobalRequestLimits({ enabled: true, movieLimit: 1, movieWindowDays: 7, seasonLimit: 0, seasonWindowDays: 7 })
    expect((await h.call('POST', '/api/explore/follow', { body: { tmdbId: 803, mediaType: 'movie' } })).status).toBe(200)
    const follower = db.prepare("SELECT * FROM discover_requests WHERE user_id = 'alice' AND tmdb_id = 803").get()
    expect(follower).toMatchObject({ is_follow: 1, service: 'none', status: 'approved' })
    expect(db.countRecentMovieRequests('alice', 7)).toBe(0)
    expect((await h.call('POST', '/api/request', { body: movie(804) })).status).toBe(200)

    const shimApp = db.createApiApp('Pull consumer')
    const listed = await h.call('GET', '/api/v1/request?filter=approved', { user: null, headers: { 'x-api-key': shimApp.api_key } })
    const ids = listed.data.results.map(r => r.id)
    expect(ids).toContain(targetId)
    expect(ids).not.toContain(follower.id)

    // Followers can't be edited into an acquisition
    expect((await h.call('PUT', `/api/queue/${follower.id}`, { body: { service: 'radarr' } })).status).toBe(400)

    h.addLibraryMovie({ ratingKey: 'm803', tmdbId: 803 })
    h.nodeRequire('../../server/services/requestFulfillment.js').checkAndNotifyFulfilled('test')
    expect(db.getRequestById(follower.id).notified_available_at).toBeTruthy()
    expect(db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE user_id = 'alice' AND type = 'request_available'").get().c).toBe(1)
  })

  const follow = (tmdbId, user = 'alice', mediaType = 'movie') =>
    h.call('POST', '/api/explore/follow', { user, body: { tmdbId, mediaType } })
  const followersOf = (tmdbId) => db.prepare('SELECT * FROM discover_requests WHERE tmdb_id = ? AND is_follow = 1').all(tmdbId)

  it('only marks titles with a live, unfulfilled request as requested, so Notify Me can always follow', async () => {
    db.addDiscoverRequestWithStatus('bob', 811, 'movie', 'Denied', 'radarr', 1, 'denied')
    const done = db.addDiscoverRequestWithStatus('bob', 812, 'movie', 'Fulfilled, since removed', 'radarr', 1, 'approved')
    db.markRequestsNotifiedAvailable([done])
    db.addDiscoverRequestWithStatus('bob', 813, 'movie', 'Live', 'radarr', 1, 'pending')
    expect((await follow(813)).status).toBe(200)
    expect([...db.getAllRequestedTmdbIds()]).toEqual(['813:movie'])
    expect([...db.getRequestedTmdbIds('alice')]).toEqual(['813:movie'])
    expect([...db.getRequestedTmdbIds('bob')]).toEqual(['813:movie'])

    // A stale Notify Me tells the client to offer Request instead, which works
    for (const tmdbId of [811, 812]) {
      const res = await follow(tmdbId)
      expect(res.status).toBe(409)
      expect(res.data.requestable).toBe(true)
      expect((await h.call('POST', '/api/request', { body: movie(tmdbId) })).status).toBe(200)
    }
  })

  it('drops followers once nothing they follow is live (deny, withdraw, delete)', async () => {
    const denied = db.addDiscoverRequestWithStatus('bob', 821, 'movie', 'Denied', 'none', 1, 'pending')
    expect((await follow(821)).status).toBe(200)
    expect((await h.call('POST', `/api/queue/${denied}/deny`, { user: 'boss', role: 'admin', body: {} })).status).toBe(200)
    expect(followersOf(821)).toHaveLength(0)

    const withdrawn = db.addDiscoverRequestWithStatus('bob', 822, 'movie', 'Withdrawn', 'none', 1, 'pending')
    expect((await follow(822)).status).toBe(200)
    expect((await h.call('DELETE', `/api/queue/${withdrawn}`, { user: 'bob' })).status).toBe(200)
    expect(followersOf(822)).toHaveLength(0)

    // Kept while another live request for the title remains
    const first = db.addDiscoverRequestWithStatus('bob', 823, 'movie', 'Two asks', 'none', 1, 'pending')
    const second = db.addDiscoverRequestWithStatus('carol', 823, 'movie', 'Two asks', 'none', 1, 'pending')
    expect((await follow(823)).status).toBe(200)
    expect((await h.call('POST', `/api/queue/${first}/deny`, { user: 'boss', role: 'admin', body: {} })).status).toBe(200)
    expect(followersOf(823)).toHaveLength(1)
    expect((await h.call('POST', `/admin/requests/${second}/deny`, { role: 'panel', body: {} })).status).toBe(200)
    expect(followersOf(823)).toHaveLength(0)

    const bulk = db.addDiscoverRequestWithStatus('bob', 824, 'movie', 'Bulk', 'none', 1, 'approved')
    expect((await follow(824)).status).toBe(200)
    expect((await h.call('POST', '/api/queue/bulk-delete', { user: 'boss', role: 'admin', body: { ids: [bulk] } })).status).toBe(200)
    expect(followersOf(824)).toHaveLength(0)

    db.addDiscoverRequestWithStatus('bob', 825, 'movie', 'User purge', 'none', 1, 'approved')
    expect((await follow(825)).status).toBe(200)
    expect((await h.call('DELETE', '/admin/users/bob/requests', { role: 'panel' })).status).toBe(200)
    expect(followersOf(825)).toHaveLength(0)

    // The title reads as unrequested again, so Request is offered
    expect(db.getAllRequestedTmdbIds().size).toBe(0)
  })

  it('retires the follow when the follower requests the title themselves', async () => {
    db.addDiscoverRequestWithStatus('bob', 831, 'movie', 'Followed', 'none', 1, 'approved')
    expect((await follow(831)).status).toBe(200)
    expect((await h.call('POST', '/api/request', { body: movie(831) })).status).toBe(200)
    expect(db.prepare("SELECT is_follow FROM discover_requests WHERE user_id = 'alice' AND tmdb_id = 831").all())
      .toEqual([{ is_follow: 0 }])

    // TV: a follow for seasons the new request leaves out keeps its notice
    db.addDiscoverRequestWithStatus('bob', 832, 'tv', 'Show', 'none', 1, 'approved', [1])
    expect((await follow(832, 'alice', 'tv')).status).toBe(200)
    expect((await h.call('POST', '/api/request', { body: show(832, { seasons: [2] }) })).status).toBe(200)
    expect(followersOf(832)).toHaveLength(1)
    expect((await h.call('POST', '/api/request', { body: show(832) })).status).toBe(200)
    expect(followersOf(832)).toHaveLength(0)
  })
})

// ── F10: request notifications reach providers ────────────────────────────────

describe('request notifications (F10)', () => {
  it('emits request_auto_approved to admins (not the requester) for auto-approved requests', async () => {
    expect((await h.call('POST', '/api/request', { body: movie(901) })).status).toBe(200)
    const sent = h.queued('request_auto_approved')
    expect(sent.map(r => r.user_id)).toEqual(['boss'])
    expect((await h.call('POST', '/api/request', { body: movie(902), user: 'boss', role: 'admin' })).status).toBe(200)
    expect(h.queued('request_auto_approved')).toHaveLength(1)
  })

  it('enqueues request_process_failed when submission fails', async () => {
    h.enableRadarr()
    h.setResponder(h.radarrResponder({ addStatus: 500 }))
    const res = await h.call('POST', '/api/request', { body: movie(903, { service: 'radarr' }) })
    expect(res.status).toBe(500)
    expect(h.queued('request_process_failed').map(r => r.user_id)).toEqual(['boss'])
    expect(db.prepare('SELECT COUNT(*) AS c FROM discover_requests').get().c).toBe(0)
  })

  it('/admin/requests/:id/deny notifies the requester like the main API deny', async () => {
    const id = db.addDiscoverRequestWithStatus('alice', 904, 'movie', 'Nope', 'none', 1, 'pending')
    const res = await h.call('POST', `/admin/requests/${id}/deny`, { role: 'panel', body: { note: 'not now' } })
    expect(res.status).toBe(200)
    const denied = h.queued('request_denied')
    expect(denied).toHaveLength(1)
    expect(denied[0]).toMatchObject({ user_id: 'alice' })
    expect(denied[0].payload.body).toBe('Reason: not now')
  })

  it('submits and announces a request once when two approvals race', async () => {
    h.enableRadarr()
    h.setResponder(h.radarrResponder({ delayMs: 50 }))
    const id = db.addDiscoverRequestWithStatus('alice', 7272, 'movie', 'M', 'radarr', 1, 'pending')
    const results = await Promise.all([
      h.call('POST', `/api/queue/${id}/approve`, { user: 'boss' }),
      h.call('POST', `/admin/requests/${id}/approve`, { role: 'panel' }),
      h.call('POST', `/api/queue/${id}/approve`, { user: 'boss' }),
    ])
    expect(results.map(r => r.status).sort()).toEqual([200, 400, 400])
    expect(h.outbound.filter(o => o.url.endsWith('/api/v3/movie') && o.method === 'POST')).toHaveLength(1)
    expect(h.queued('request_approved')).toHaveLength(1)
    expect(db.getRequestById(id).status).toBe('approved')
  })

  it('serializes the shim approve and every deny with an approval that is still submitting', async () => {
    h.enableRadarr()
    h.setResponder(h.radarrResponder({ delayMs: 60 }))
    const key = db.createApiApp('Race widget').api_key
    const id = db.addDiscoverRequestWithStatus('alice', 7273, 'movie', 'M', 'radarr', 1, 'pending')
    const first = h.call('POST', `/api/queue/${id}/approve`, { user: 'boss' })
    await new Promise(r => setTimeout(r, 20)) // inside the lock, waiting on Radarr
    const [shimApprove, queueDeny, adminDeny, shimDecline] = await Promise.all([
      h.call('POST', `/api/v1/request/${id}/approve`, { user: null, headers: { 'x-api-key': key } }),
      h.call('POST', `/api/queue/${id}/deny`, { user: 'boss', body: {} }),
      h.call('POST', `/admin/requests/${id}/deny`, { role: 'panel', body: {} }),
      h.call('POST', `/api/v1/request/${id}/decline`, { user: null, headers: { 'x-api-key': key } }),
    ])
    expect((await first).status).toBe(200)
    expect(shimApprove.status).toBe(200) // already approved: a no-op, not a resubmission
    expect([queueDeny.status, adminDeny.status, shimDecline.status]).toEqual([409, 409, 409])
    expect(h.outbound.filter(o => o.url.endsWith('/api/v3/movie') && o.method === 'POST')).toHaveLength(1)
    expect(db.getRequestById(id).status).toBe('approved')
    expect(h.queued('request_approved')).toHaveLength(1)
    expect(h.queued('request_denied')).toHaveLength(0)
  })

  it('keeps no follower alive on an already fulfilled request when the live one is denied', async () => {
    const old = db.addDiscoverRequestWithStatus('carol', 7274, 'tv', 'Show', 'none', 1, 'approved', [1])
    db.markRequestsNotifiedAvailable([old])
    const pending = db.addDiscoverRequestWithStatus('bob', 7274, 'tv', 'Show', 'none', 1, 'pending', [2])
    expect((await h.call('POST', '/api/explore/follow', { body: { tmdbId: 7274, mediaType: 'tv' } })).status).toBe(200)
    expect((await h.call('POST', `/api/queue/${pending}/deny`, { user: 'boss', body: {} })).status).toBe(200)
    expect(db.prepare('SELECT COUNT(*) AS c FROM discover_requests WHERE tmdb_id = 7274 AND is_follow = 1').get().c).toBe(0)
  })

  describe('through the Overseerr shim', () => {
    const shimCall = (route, body) => h.call('POST', `/api/v1${route}`, { user: null, headers: { 'x-api-key': shimKey }, body })
    const radarrPosts = () => h.outbound.filter(o => o.method === 'POST' && o.url.endsWith('/api/v3/movie')).length
    let shimKey
    beforeAll(() => { shimKey = db.createApiApp('Homarr widget').api_key })

    it('approving a queued-only shim request (service none) picks an app like the Queue does', async () => {
      h.enableRadarr()
      h.setResponder(h.radarrResponder())
      const id = db.addDiscoverRequestWithStatus('alice', 915, 'movie', 'Queued only', 'none', 1, 'pending')
      expect((await shimCall(`/request/${id}/approve`)).status).toBe(200)
      expect(radarrPosts()).toBe(1)
      expect(db.getRequestById(id).status).toBe('approved')
    })

    it('approve and decline notify the requester like the Queue, and never resubmit', async () => {
      h.enableRadarr()
      h.setResponder(h.radarrResponder())
      const approve = db.addDiscoverRequestWithStatus('alice', 911, 'movie', 'Approve me', 'radarr', 1, 'pending')
      const decline = db.addDiscoverRequestWithStatus('alice', 912, 'movie', 'Decline me', 'radarr', 1, 'pending')
      db.setRequestSubmitError(approve, 'earlier failure')

      expect((await shimCall(`/request/${approve}/approve`)).status).toBe(200)
      expect(db.getRequestById(approve)).toMatchObject({ status: 'approved', submit_error: null })
      expect(h.queued('request_approved').map(r => r.user_id)).toEqual(['alice'])
      expect(radarrPosts()).toBe(1)
      // Approving again is a no-op, not a second submission
      expect((await shimCall(`/request/${approve}/approve`)).status).toBe(200)
      expect(radarrPosts()).toBe(1)
      expect(h.queued('request_approved')).toHaveLength(1)

      expect((await shimCall(`/request/${decline}/decline`, { reason: 'not now' })).status).toBe(200)
      const denied = h.queued('request_denied')
      expect(denied.map(r => r.user_id)).toEqual(['alice'])
      expect(denied[0].payload.body).toBe('Reason: not now')
      // A declined request is not approvable until reset to pending
      expect((await shimCall(`/request/${decline}/approve`)).status).toBe(400)
      expect(radarrPosts()).toBe(1)
    })

    it('a failed approval alerts admins and leaves the request pending', async () => {
      h.enableRadarr()
      h.setResponder(h.radarrResponder({ addStatus: 500 }))
      const id = db.addDiscoverRequestWithStatus('alice', 913, 'movie', 'Broken', 'radarr', 1, 'pending')
      expect((await shimCall(`/request/${id}/approve`)).status).toBe(500)
      expect(db.getRequestById(id).status).toBe('pending')
      expect(h.queued('request_process_failed').map(r => r.user_id)).toEqual(['boss'])
      expect(h.queued('request_approved')).toHaveLength(0)
    })

    it('decline drops followers left with nothing to follow', async () => {
      const id = db.addDiscoverRequestWithStatus('bob', 914, 'movie', 'Followed', 'none', 1, 'pending')
      expect((await h.call('POST', '/api/explore/follow', { body: { tmdbId: 914, mediaType: 'movie' } })).status).toBe(200)
      expect((await shimCall(`/request/${id}/decline`)).status).toBe(200)
      expect(db.prepare('SELECT COUNT(*) AS c FROM discover_requests WHERE tmdb_id = 914 AND is_follow = 1').get().c).toBe(0)
    })
  })
})

// ── Migration: legacy follow rows are recognized ─────────────────────────────

describe('request_policy_v1 migration', () => {
  it('flags legacy follow rows and nothing else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-legacy-'))
    const here = path.dirname(fileURLToPath(import.meta.url))
    const { DatabaseSync } = h.nodeRequire('node:sqlite')
    const legacy = new DatabaseSync(path.join(dir, 'diskovarr.db'))
    legacy.exec(`CREATE TABLE discover_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, tmdb_id INTEGER NOT NULL, media_type TEXT NOT NULL,
      title TEXT, service TEXT, requested_at INTEGER DEFAULT 0, seasons_count INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'approved', denial_note TEXT, seasons_json TEXT, poster_url TEXT DEFAULT NULL,
      notified_available_at INTEGER DEFAULT NULL)`)
    const ins = legacy.prepare('INSERT INTO discover_requests (user_id, tmdb_id, media_type, service, status, poster_url) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run('bob', 1, 'movie', 'radarr', 'approved', 'http://p')   // 1 real request
    ins.run('alice', 1, 'movie', 'none', 'approved', null)         // 2 legacy follow
    ins.run('carol', 2, 'movie', 'none', 'approved', null)         // 3 nothing to follow → real
    ins.run('dave', 1, 'movie', 'none', 'approved', 'http://p')    // 4 has poster → real
    legacy.close()
    const script = `const db = require(${JSON.stringify(path.join(here, '../server/db/database.js'))});
      process.stdout.write('@@' + JSON.stringify(db.prepare('SELECT id, is_follow FROM discover_requests ORDER BY id').all()));`
    const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, DISKOVARR_DATA_DIR: dir }, encoding: 'utf8' })
    expect(JSON.parse(out.slice(out.indexOf('@@') + 2))).toEqual([
      { id: 1, is_follow: 0 }, { id: 2, is_follow: 1 }, { id: 3, is_follow: 0 }, { id: 4, is_follow: 0 },
    ])
  })
})
