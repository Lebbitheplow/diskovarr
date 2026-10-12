import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Point the db at a throwaway directory BEFORE loading (it migrates on import).
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-notif-routes-'))
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-only-secret'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const api = nodeRequire('../server/routes/api.js')
const admin = nodeRequire('../server/routes/admin.js')

const USER = 'route-user'
let server
let base

beforeAll(async () => {
  db.upsertKnownUser(USER, 'Route User', null, null)
  const app = express()
  app.use(express.json())
  // Stand-in for express-session: a signed-in ordinary user.
  app.use((req, _res, next) => { req.session = { plexUser: { id: USER, username: 'Route User' } }; next() })
  app.use('/api', api)
  app.use('/admin', admin)
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

async function call(route, body, method = 'POST') {
  const res = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

describe('F11 — POST /api/user/settings is a validated partial update', () => {
  beforeEach(() => {
    db.setUserPreferences(USER, { auto_request_movies: true, auto_request_tv: true, landing_page: 'explore', show_mature: false, region: 'US' })
    db.setUserNotificationPrefs(USER, { notify_approved: true, email_enabled: false, email_address: null, discord_webhook: null })
  })

  it('saving email settings keeps the auto-request flags and other preferences', async () => {
    const res = await call('/api/user/settings', { email_address: 'me@example.invalid', email_enabled: true })
    expect(res.status).toBe(200)
    const prefs = db.getUserPreferences(USER)
    expect(prefs).toMatchObject({ auto_request_movies: true, auto_request_tv: true, landing_page: 'explore', region: 'US' })
    expect(db.getUserNotificationPrefs(USER)).toMatchObject({ email_enabled: true, email_address: 'me@example.invalid', notify_approved: true })
  })

  it('saving one preference leaves the rest alone', async () => {
    expect((await call('/api/user/settings', { show_mature: true })).status).toBe(200)
    expect(db.getUserPreferences(USER)).toMatchObject({ show_mature: true, auto_request_movies: true, landing_page: 'explore', region: 'US' })
  })

  it('an invalid email rejects the whole request with no writes', async () => {
    const res = await call('/api/user/settings', { show_mature: true, notify_approved: false, email_address: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(db.getUserPreferences(USER).show_mature).toBe(false)
    expect(db.getUserNotificationPrefs(USER).notify_approved).toBe(true)
  })

  it('S05: rejects a personal webhook that is not a Discord webhook, with no writes', async () => {
    const res = await call('/api/user/settings', { discord_enabled: true, region: 'GB', discord_webhook: 'http://127.0.0.1:9999/internal' })
    expect(res.status).toBe(400)
    expect(db.getUserNotificationPrefs(USER)).toMatchObject({ discord_webhook: null, discord_enabled: false })
    expect(db.getUserPreferences(USER).region).toBe('US')

    const ok = await call('/api/user/settings', { discord_webhook: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123' })
    expect(ok.status).toBe(200)
    expect(db.getUserNotificationPrefs(USER).discord_webhook).toMatch(/^https:\/\/discord\.com\/api\/webhooks\//)
  })

  it('ignores admin-only toggles from non-privileged users', async () => {
    db.setUserNotificationPrefs(USER, { notify_pending: true })
    expect((await call('/api/user/settings', { notify_pending: false })).status).toBe(200)
    expect(db.getUserNotificationPrefs(USER).notify_pending).toBe(true)
  })
})

describe('F09 — mark-read is explicit and returns the server count', () => {
  let ids
  beforeEach(() => {
    db.prepare('DELETE FROM notifications').run()
    // Distinct bundle keys so each is its own bell row.
    ids = ['One', 'Two', 'Three'].map((t) => db.createOrBundleNotification({ userId: USER, type: 'monitor_match', title: t, bundleKey: `k-${t}` }))
  })

  it('an empty or missing id list marks nothing', async () => {
    expect(new Set(ids).size).toBe(3)
    expect((await call('/api/notifications/read', { ids: [] })).data).toMatchObject({ ok: true, unreadCount: 3 })
    expect((await call('/api/notifications/read', {})).data.unreadCount).toBe(3)
    expect(db.getUnreadNotificationCount(USER)).toBe(3)
  })

  it('marks given ids once; re-marking a read row changes nothing', async () => {
    expect((await call('/api/notifications/read', { ids: [ids[0]] })).data.unreadCount).toBe(2)
    expect((await call('/api/notifications/read', { ids: [ids[0]] })).data.unreadCount).toBe(2)
  })

  it('clears everything only with an explicit all flag', async () => {
    expect((await call('/api/notifications/read', { all: true })).data.unreadCount).toBe(0)
  })

  it('reports the true unread count beyond the 20-row list cap', async () => {
    for (let i = 0; i < 25; i++) db.createOrBundleNotification({ userId: USER, type: 'monitor_match', title: `T${i}`, bundleKey: `cap-${i}` })
    const res = await call('/api/notifications', undefined, 'GET')
    expect(res.data.notifications).toHaveLength(20)
    expect(res.data.unreadCount).toBe(28)
  })
})

describe('Movie Night picks are queued under their real event type', () => {
  it('a new pick notifies other members as movie_night_added with the group id', async () => {
    db.upsertKnownUser('mn-friend', 'Friend', null, null)
    const group = db.createMovieNightGroup({ name: 'Friday', mode: 'rolling', createdBy: USER })
    db.addMovieNightMember(group.id, 'mn-friend')
    const res = await call(`/api/movie-night/groups/${group.id}/entries`, { mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999 })
    expect(res.status).toBe(201)
    const row = db.prepare("SELECT * FROM notifications WHERE user_id = 'mn-friend' ORDER BY id DESC").get()
    expect(row.type).toBe('movie_night_added')
    expect(JSON.parse(row.data).groupId).toBe(group.id)
    const queued = db.prepare("SELECT payload FROM notification_queue WHERE user_id = 'mn-friend'").all()
    for (const q of queued) expect(JSON.parse(q.payload).type).toBe('movie_night_added')
  })
})

describe('S05 — push subscription routes share one policy', () => {
  const sub = (endpoint) => ({ subscription: { endpoint, keys: { auth: 'authKey_12345', p256dh: 'p256dhKey_12345' } } })

  it('rejects while the provider is disabled, on both routes', async () => {
    db.setSetting('webpush_agent', JSON.stringify({ enabled: false }))
    expect((await call('/api/user/webpush/subscribe', sub('https://fcm.googleapis.com/fcm/send/x'))).status).toBe(400)
    expect((await call('/admin/webpush/subscribe', sub('https://fcm.googleapis.com/fcm/send/x'))).status).toBe(400)
  })

  it('rejects internal endpoints (the legacy route included) and accepts a push service', async () => {
    db.setSetting('webpush_agent', JSON.stringify({ enabled: true }))
    expect((await call('/api/user/webpush/subscribe', sub('https://127.0.0.1:9443/private'))).status).toBe(400)
    expect((await call('/admin/webpush/subscribe', sub('http://127.0.0.1:9443/private'))).status).toBe(400)
    expect((await call('/api/user/webpush/subscribe', sub('https://fcm.googleapis.com/fcm/send/x'))).status).toBe(200)
    db.setSetting('webpush_agent', JSON.stringify({ enabled: false }))
  })
})
