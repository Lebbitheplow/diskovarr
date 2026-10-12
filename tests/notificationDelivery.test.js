import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Point the db at a throwaway directory BEFORE loading (it migrates on import).
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-notif-delivery-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const { manager, enqueueForUser } = nodeRequire('../server/services/notificationAgents/index.js')
const service = nodeRequire('../server/services/notificationService.js')
const { runTargets, httpError, resolveAudience } = nodeRequire('../server/services/notificationAgents/delivery.js')
const webpushAgent = nodeRequire('../server/services/webpushAgent.js')
// Same module instance webpushAgent resolved (symlinked node_modules resolve to one real path).
const webpush = createRequire(nodeRequire.resolve('../server/services/webpushAgent.js'))('web-push')

const testAgents = []
function registerAgent(key, agent) {
  manager.register(key, { shouldSend: () => true, shouldSendType: () => true, ...agent })
  testAgents.push(key)
}

function queueRows(agent) {
  return db.prepare('SELECT * FROM notification_queue WHERE agent = ? ORDER BY id').all(agent)
}

// Lets a scheduled retry come due without waiting out the backoff.
function makeDue(agent) {
  db.prepare("UPDATE notification_queue SET next_attempt_at = 0 WHERE agent = ? AND status = 'pending'").run(agent)
}

let n = 0
const uid = (p) => `${p}-${++n}`

beforeEach(() => {
  db.prepare('DELETE FROM notification_queue').run()
  db.prepare('DELETE FROM notifications').run()
})

afterEach(() => {
  for (const key of testAgents.splice(0)) manager.agents.delete(key)
  vi.restoreAllMocks()
})

describe('F01 — recipient-aware delivery', () => {
  it('delivers to the queue row user even when the payload has no userId', async () => {
    const captured = []
    registerAgent('cap-recipient', { send: async (type, payload, ctx) => { captured.push({ type, payload, ctx }) } })
    const user = uid('requester')
    const notificationId = db.createOrBundleNotification({ userId: user, type: 'request_available', title: 'Dune is available', data: { requestId: 7 } })
    db.enqueueNotification({ notificationId, agent: 'cap-recipient', userId: user, payload: { type: 'request_available', title: 'Dune is available' }, sendAfter: 1 })

    await service.processPendingNotifications()

    expect(captured).toHaveLength(1)
    expect(captured[0].ctx.recipientId).toBe(user)
    expect(captured[0].payload.userId).toBe(user)
    expect(queueRows('cap-recipient')[0]).toMatchObject({ status: 'sent', sent: 1 })
  })

  it('direct (non-queue) calls keep payload.userId as the recipient', () => {
    expect(resolveAudience({ userId: 'u1' })).toEqual({ recipientId: 'u1', feed: true })
    expect(resolveAudience({ userId: 'someone-else' }, { recipientId: 'row-user', feed: false })).toEqual({ recipientId: 'row-user', feed: false })
  })

  it('browser push for a user-addressed event reaches only that user, never the admins', async () => {
    db.setSetting('webpush_agent', JSON.stringify({ enabled: true }))
    const requester = uid('requester')
    const admin = uid('admin')
    db.upsertKnownUser(admin, 'Admin', null, null)
    db.setUserAdmin(admin, true)
    for (const [user, tag] of [[requester, 'req'], [admin, 'adm']]) {
      expect(webpushAgent.saveSubscription(user, {
        endpoint: `https://fcm.googleapis.com/fcm/send/${tag}-device`,
        keys: { auth: 'authKey_12345', p256dh: 'p256dhKey_12345' },
      })).toBe(true)
      db.setUserNotificationPrefs(user, { webpush_enabled: true })
    }
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 })

    const notificationId = db.createOrBundleNotification({ userId: requester, type: 'request_approved', title: '"Dune" approved' })
    enqueueForUser({ notificationId, userId: requester, payload: { type: 'request_approved', title: '"Dune" approved' }, sendAfter: 1 })
    await service.processPendingNotifications()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].endpoint).toBe('https://fcm.googleapis.com/fcm/send/req-device')
    db.setSetting('webpush_agent', JSON.stringify({ enabled: false }))
  })

  it('an unaddressed push is not fanned out to privileged users', async () => {
    db.setSetting('webpush_agent', JSON.stringify({ enabled: true }))
    const send = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 })
    const result = await webpushAgent.send('request_pending', { title: 'x' }, { recipientId: null, feed: true })
    expect(result.status).toBe('skipped')
    expect(send).not.toHaveBeenCalled()
    db.setSetting('webpush_agent', JSON.stringify({ enabled: false }))
  })
})

describe('F02 — delivery results, retries and failures', () => {
  it('retries a transient failure with backoff and never re-sends a target that already succeeded', async () => {
    const feedSend = vi.fn(async () => {})
    let userAttempts = 0
    const userSend = vi.fn(async () => {
      userAttempts++
      if (userAttempts === 1) throw httpError('Upstream', 503, 'unavailable')
    })
    registerAgent('two-targets', {
      send: (type, payload, ctx) => runTargets([{ id: 'feed', send: feedSend }, { id: 'user', send: userSend }], ctx),
    })
    db.enqueueNotification({ agent: 'two-targets', userId: 'u1', payload: { type: 'request_approved', title: 'A' }, sendAfter: 1 })

    const before = Math.floor(Date.now() / 1000)
    await service.processPendingNotifications()
    let row = queueRows('two-targets')[0]
    expect(row).toMatchObject({ status: 'pending', sent: 0, attempts: 1 })
    expect(row.next_attempt_at).toBeGreaterThanOrEqual(before + 30)
    expect(row.last_error).toMatch(/503/)
    expect(JSON.parse(row.delivered)).toEqual(['feed'])

    // Not due yet: nothing happens.
    await service.processPendingNotifications()
    expect(userSend).toHaveBeenCalledTimes(1)

    makeDue('two-targets')
    await service.processPendingNotifications()
    row = queueRows('two-targets')[0]
    expect(row).toMatchObject({ status: 'sent', sent: 1, attempts: 2 })
    expect(feedSend).toHaveBeenCalledTimes(1)
    expect(userSend).toHaveBeenCalledTimes(2)
  })

  it('marks a permanent (4xx) failure as failed and lists it for the admin', async () => {
    registerAgent('perm-fail', { send: async () => { throw httpError('Provider', 400, 'bad request') } })
    db.enqueueNotification({ agent: 'perm-fail', userId: 'u1', payload: { type: 'request_denied', title: 'Denied' }, sendAfter: 1 })
    await service.processPendingNotifications()
    const row = queueRows('perm-fail')[0]
    expect(row).toMatchObject({ status: 'failed', sent: 0, attempts: 1 })
    const failures = db.getFailedQueuedNotifications()
    expect(failures.some(f => f.id === row.id && /400/.test(f.last_error))).toBe(true)
  })

  it('a thrown outage is retried, bounded by the attempt cap, then failed', async () => {
    const send = vi.fn(async () => { throw new Error('simulated upstream outage') })
    registerAgent('outage', { send })
    db.enqueueNotification({ agent: 'outage', userId: 'u1', payload: { type: 'request_available', title: 'Should retry' }, sendAfter: 1 })
    for (let i = 0; i < db.QUEUE_MAX_ATTEMPTS + 2; i++) {
      await service.processPendingNotifications()
      makeDue('outage')
    }
    expect(send).toHaveBeenCalledTimes(db.QUEUE_MAX_ATTEMPTS)
    expect(queueRows('outage')[0]).toMatchObject({ status: 'failed', sent: 0, attempts: db.QUEUE_MAX_ATTEMPTS })
  })

  it('honours a provider Retry-After on 429', async () => {
    registerAgent('rate-limited', { send: async () => { throw httpError('Provider', 429, 'slow down', '900') } })
    db.enqueueNotification({ agent: 'rate-limited', userId: 'u1', payload: { type: 'issue_new', title: 'Issue' }, sendAfter: 1 })
    const before = Math.floor(Date.now() / 1000)
    await service.processPendingNotifications()
    const row = queueRows('rate-limited')[0]
    expect(row.status).toBe('pending')
    expect(row.next_attempt_at).toBeGreaterThanOrEqual(before + 900)
  })

  it('overlapping worker ticks send a slow batch once', async () => {
    let release
    const gate = new Promise(r => { release = r })
    const send = vi.fn(async () => { await gate })
    registerAgent('slow', { send })
    db.enqueueNotification({ agent: 'slow', userId: 'u1', payload: { type: 'request_pending', title: 'Slow' }, sendAfter: 1 })

    const first = service.processPendingNotifications()
    const second = await service.processPendingNotifications()
    expect(second).toEqual({ busy: true })
    // A second worker (no shared flag) finds nothing to claim either.
    expect(db.claimDueQueuedNotifications().filter(r => r.agent === 'slow')).toEqual([])
    release()
    await first
    await service.processPendingNotifications()
    expect(send).toHaveBeenCalledTimes(1)
    expect(queueRows('slow')[0].status).toBe('sent')
  })

  it('a failed bundle keeps every row for retry, then sends it once', async () => {
    let calls = 0
    registerAgent('bundle-retry', { send: async () => { if (++calls === 1) throw httpError('Provider', 502, '') } })
    const user = uid('bundle-user')
    const notificationId = db.createOrBundleNotification({ userId: user, type: 'request_available', title: 'A is available', data: { requestId: 1 } })
    db.createOrBundleNotification({ userId: user, type: 'request_available', title: 'B is available', data: { requestId: 2 } })
    for (const title of ['A is available', 'B is available']) {
      db.enqueueNotification({ notificationId, agent: 'bundle-retry', userId: user, payload: { type: 'request_available', title }, sendAfter: 1 })
    }
    await service.processPendingNotifications()
    expect(queueRows('bundle-retry').map(r => r.status)).toEqual(['pending', 'pending'])
    makeDue('bundle-retry')
    await service.processPendingNotifications()
    expect(calls).toBe(2)
    expect(queueRows('bundle-retry').map(r => r.status)).toEqual(['sent', 'sent'])
  })

  it('a bell notification read before sending is skipped, not reported as sent', async () => {
    const userSend = vi.fn()
    // Personal-only provider (like email): the read row may only go out feed-only, which reaches nobody here.
    registerAgent('read-skip', { send: (type, payload, ctx) => runTargets(ctx.recipientId ? [{ id: 'user', send: userSend }] : [], ctx) })
    const user = uid('reader')
    const notificationId = db.createOrBundleNotification({ userId: user, type: 'request_approved', title: 'Seen' })
    db.enqueueNotification({ notificationId, agent: 'read-skip', userId: user, payload: { type: 'request_approved', title: 'Seen' }, sendAfter: 1 })
    db.markNotificationsRead(user, [notificationId])
    await service.processPendingNotifications()
    expect(userSend).not.toHaveBeenCalled()
    expect(queueRows('read-skip')[0]).toMatchObject({ status: 'skipped', sent: 0 })
  })
})

// A provider with an admin feed and a personal target (shaped like Discord,
// Pushover, Telegram). `failUser` lists recipients whose next personal send gets a 503.
function registerDualAgent(key, log, failUser = new Set()) {
  registerAgent(key, {
    send: (type, payload, ctx) => runTargets([
      ...(ctx.feed ? [{ id: 'feed', send: async () => { log.push(['feed', payload.title]) } }] : []),
      ...(ctx.recipientId ? [{ id: 'user', send: async () => {
        if (failUser.delete(ctx.recipientId)) throw httpError('Upstream', 503, 'unavailable')
        log.push([`user:${ctx.recipientId}`, payload.title])
      } }] : []),
    ], ctx),
  })
}

describe('bundles that are retrying when a new event joins', () => {
  function addEvent(agent, user, title, sendAfter = 1) {
    const notificationId = db.createOrBundleNotification({ userId: user, type: 'request_pending', title })
    db.enqueueNotification({ notificationId, agent, userId: user, payload: { type: 'request_pending', title }, sendAfter })
    return notificationId
  }

  it('the new event still reaches the feed and the user, and gets its own attempt count', async () => {
    const log = []
    const admin = uid('admin')
    registerDualAgent('bundle-join', log, new Set([admin]))
    const n1 = addEvent('bundle-join', admin, 'New request: "Dune"')
    await service.processPendingNotifications()
    expect(queueRows('bundle-join')[0]).toMatchObject({ status: 'pending', attempts: 1, delivered: '["feed"]' })

    // "Alien" joins the bell bundle while "Dune" waits out its backoff: nothing goes out early.
    expect(addEvent('bundle-join', admin, 'New request: "Alien"')).toBe(n1)
    await service.processPendingNotifications()
    expect(log).toEqual([['feed', 'New request: "Dune"']])
    expect(queueRows('bundle-join').map(r => [r.status, r.attempts])).toEqual([['pending', 1], ['pending', 0]])

    makeDue('bundle-join')
    await service.processPendingNotifications()
    expect(log.slice(1).map(([target]) => target)).toEqual(['feed', `user:${admin}`])
    expect(log.slice(1).every(([, title]) => title.includes('Alien'))).toBe(true)
    expect(queueRows('bundle-join').map(r => [r.status, r.attempts])).toEqual([['sent', 2], ['sent', 1]])
  })

  it('an event joining a bundle near its attempt cap is not failed after one try', async () => {
    const send = vi.fn(async () => { throw httpError('Provider', 503, '') })
    registerAgent('bundle-cap', { send })
    const user = uid('capped')
    addEvent('bundle-cap', user, 'Old')
    const now = Math.floor(Date.now() / 1000)
    db.prepare("UPDATE notification_queue SET attempts = 4, next_attempt_at = ? WHERE agent = 'bundle-cap'").run(now + 1800)
    addEvent('bundle-cap', user, 'New')

    await service.processPendingNotifications()
    expect(send).not.toHaveBeenCalled()

    makeDue('bundle-cap')
    await service.processPendingNotifications()
    expect(send).toHaveBeenCalledTimes(1)
    expect(queueRows('bundle-cap').map(r => [r.status, r.attempts])).toEqual([['failed', 5], ['pending', 1]])
  })
})

describe('admin feeds get each event once', () => {
  let fetchMock
  beforeEach(() => {
    db.setSetting('slack_agent', JSON.stringify({ enabled: true, webhookUrl: 'https://hooks.slack.invalid/T000/B000/x', notificationTypes: ['request_pending'] }))
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
  })
  afterEach(() => db.setSetting('slack_agent', JSON.stringify({ enabled: false })))

  function fanOutToAdmins(admins, title) {
    for (const adminId of admins) {
      const notificationId = db.createOrBundleNotification({ userId: adminId, type: 'request_pending', title, body: 'alice requested a movie.' })
      enqueueForUser({ notificationId, userId: adminId, payload: { type: 'request_pending', title, body: 'alice requested a movie.' }, sendAfter: 1 })
    }
  }

  it('one event fanned out to two admins posts to Slack once', async () => {
    fanOutToAdmins([uid('admin'), uid('admin')], 'New request: "Dune"')
    await service.processPendingNotifications()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(queueRows('slack').map(r => r.status).sort()).toEqual(['sent', 'skipped'])
  })

  it('the feed still gets the event once when the carrier admin read it first', async () => {
    const [a, b] = [uid('admin'), uid('admin')]
    fanOutToAdmins([a, b], 'New request: "Arrival"')
    db.markAllNotificationsRead(a)
    await service.processPendingNotifications()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a single admin who reads the bell before sending does not drop the feed post', async () => {
    const a = uid('admin')
    fanOutToAdmins([a], 'New request: "Solaris"')
    db.markAllNotificationsRead(a)
    await service.processPendingNotifications()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(queueRows('slack')[0]).toMatchObject({ status: 'sent', feed: 1 })
  })

  it('a carrier that failed transiently and was then read still posts the feed once', async () => {
    const [a, b] = [uid('admin'), uid('admin')]
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    fanOutToAdmins([a, b], 'New request: "Stalker"')
    await service.processPendingNotifications()
    expect(queueRows('slack').map(r => r.status)).toEqual(['pending', 'skipped'])

    db.markAllNotificationsRead(a)
    makeDue('slack')
    await service.processPendingNotifications()
    makeDue('slack')
    await service.processPendingNotifications()
    expect(fetchMock).toHaveBeenCalledTimes(2) // the 503, then one post
    expect(queueRows('slack').map(r => r.status)).toEqual(['sent', 'skipped'])
  })

  it('a carrier that already posted the feed and is read while retrying does not post it again', async () => {
    const log = []
    const [a, b] = [uid('admin'), uid('admin')]
    registerDualAgent('dual-feed', log, new Set([a, b]))
    for (const adminId of [a, b]) {
      const notificationId = db.createOrBundleNotification({ userId: adminId, type: 'request_pending', title: 'New request: "Heat"' })
      db.enqueueNotification({ notificationId, agent: 'dual-feed', userId: adminId, payload: { type: 'request_pending', title: 'New request: "Heat"' }, sendAfter: 1 })
    }
    await service.processPendingNotifications()
    expect(queueRows('dual-feed').map(r => r.status)).toEqual(['pending', 'pending'])

    db.markAllNotificationsRead(a)
    makeDue('dual-feed')
    await service.processPendingNotifications()
    expect(log.filter(([target]) => target === 'feed')).toHaveLength(1)
    expect(log.map(([target]) => target)).toEqual(['feed', `user:${b}`])
    expect(queueRows('dual-feed').map(r => r.status)).toEqual(['skipped', 'sent'])
  })
})

describe('F08 — bundles describe one consistent item', () => {
  it('title, body and data all follow the newest item; earlier items are listed', () => {
    const user = uid('monitor-user')
    const id = db.createOrBundleNotification({ userId: user, type: 'monitor_match', title: 'First Title', body: 'First Body', data: { tmdbId: 111, title: 'First Title' } })
    expect(db.createOrBundleNotification({ userId: user, type: 'monitor_match', title: 'Second Title', body: 'Second Body', data: { tmdbId: 222, title: 'Second Title' } })).toBe(id)
    let row = db.getNotificationById(id)
    expect(row.title).toBe('Second Title and 1 other')
    expect(row.body).toBe('Second Body')
    let data = JSON.parse(row.data)
    expect(data).toMatchObject({ tmdbId: 222, title: 'Second Title' })
    expect(data.bundle.map(b => b.tmdbId)).toEqual([111])

    db.createOrBundleNotification({ userId: user, type: 'monitor_match', title: 'Third Title', body: 'Third Body', data: { tmdbId: 333, title: 'Third Title' } })
    row = db.getNotificationById(id)
    data = JSON.parse(row.data)
    expect(row.title).toBe('Third Title and 2 others')
    expect(row.body).toBe('Third Body')
    expect(data.tmdbId).toBe(333)
    expect(data.bundle.map(b => b.tmdbId)).toEqual([111, 222])
  })

  it('does not merge items from different Movie Night groups', () => {
    const user = uid('member')
    const g1 = db.createOrBundleNotification({ userId: user, type: 'movie_night_added', title: 'Pick 1', data: { groupId: 1, entryId: 10 } })
    const g2 = db.createOrBundleNotification({ userId: user, type: 'movie_night_added', title: 'Pick 2', data: { groupId: 2, entryId: 20 } })
    const g1b = db.createOrBundleNotification({ userId: user, type: 'movie_night_added', title: 'Pick 3', data: { groupId: 1, entryId: 30 } })
    expect(g1).not.toBe(g2)
    expect(g1b).toBe(g1)
  })

  it('the external payload uses the bundle text, the newest poster and the newest target', async () => {
    db.setSetting('app_public_url', 'https://diskovarr.example')
    const captured = []
    registerAgent('cap-bundle', { send: async (type, payload) => { captured.push(payload) } })
    const user = uid('bundle-user')
    const id = db.createOrBundleNotification({ userId: user, type: 'request_available', title: '"A" is now available', body: 'Body A', data: { requestId: 1 } })
    db.enqueueNotification({ notificationId: id, agent: 'cap-bundle', userId: user, payload: { type: 'request_available', title: '"A" is now available', posterUrl: 'https://img.example/a.jpg' }, sendAfter: 1 })
    db.createOrBundleNotification({ userId: user, type: 'request_available', title: '"B" is now available', body: 'Body B', data: { requestId: 2 } })
    db.enqueueNotification({ notificationId: id, agent: 'cap-bundle', userId: user, payload: { type: 'request_available', title: '"B" is now available', posterUrl: 'https://img.example/b.jpg' } })

    await service.processPendingNotifications()
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      title: '"B" is now available and 1 other',
      body: 'Body B',
      posterUrl: 'https://img.example/b.jpg',
      url: 'https://diskovarr.example/queue?id=2',
    })
    // The not-yet-due sibling went out with its bundle instead of later on its own.
    expect(queueRows('cap-bundle').map(r => r.status)).toEqual(['sent', 'sent'])
    db.setSetting('app_public_url', '')
  })
})

describe('F10 — deletion notices use the normal provider path', () => {
  it('queues a deletion notice for every active provider, which filters on the deletion type', async () => {
    const captured = []
    registerAgent('cap-deletion', { send: async (type, payload, ctx) => { captured.push({ type, ctx }) } })
    const admin = uid('del-admin')
    db.upsertKnownUser(admin, 'Admin', null, null)
    db.setUserAdmin(admin, true)
    const deletion = nodeRequire('../server/services/deletion/index.js')
    deletion.notifyAdmins('Auto-deletion: Old stuff', 'Deleted 2 item(s)')
    const rows = queueRows('cap-deletion')
    expect(rows.map(r => r.user_id)).toContain(admin)
    db.prepare("UPDATE notification_queue SET send_after = 1 WHERE agent = 'cap-deletion'").run()
    await service.processPendingNotifications()
    expect(captured.some(c => c.type === 'deletion' && c.ctx.recipientId === admin)).toBe(true)
    db.setUserAdmin(admin, false)
  })
})

describe('F07 — external links per event', () => {
  it('builds destinations for groups, entries, parties, issues and requests', () => {
    const { notificationUrl, notificationPath } = nodeRequire('../server/services/notificationAgents/links.js')
    const base = 'https://diskovarr.example/'
    expect(notificationUrl(base, 'movie_night_invite', { groupId: 4 })).toBe('https://diskovarr.example/movie-night/4')
    expect(notificationUrl(base, 'movie_night_comment', JSON.stringify({ groupId: 4, entryId: 9 }))).toBe('https://diskovarr.example/movie-night/4')
    expect(notificationUrl(base, 'movie_night_tonight', { groupId: 5 })).toBe('https://diskovarr.example/movie-night/5')
    expect(notificationUrl(base, 'watch_party_invite', { partyId: 12 })).toBe('https://diskovarr.example/watch-party/12')
    expect(notificationUrl(base, 'issue_comment_added_user', { issueId: 3 })).toBe('https://diskovarr.example/issues?id=3')
    expect(notificationUrl(base, 'request_available', { requestId: 8 })).toBe('https://diskovarr.example/queue?id=8')
    expect(notificationPath('deletion', {})).toBe('/admin#automation')
    expect(notificationPath('unknown_event', {})).toBeNull()
    expect(notificationUrl('', 'request_available', { requestId: 8 })).toBeNull()
  })
})
