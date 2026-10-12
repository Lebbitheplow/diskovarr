import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Point the db at a throwaway directory BEFORE loading (it migrates on import).
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-notif-providers-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const types = nodeRequire('../server/services/notificationAgents/types.js')
const destinations = nodeRequire('../server/services/notificationAgents/destinations.js')
const { manager } = nodeRequire('../server/services/notificationAgents/index.js')
const discordAgent = nodeRequire('../server/services/discordAgent.js')
const pushoverAgent = nodeRequire('../server/services/pushoverAgent.js')
const telegramAgent = nodeRequire('../server/services/telegramAgent.js')
const emailAgent = nodeRequire('../server/services/emailAgent.js')
const slackAgent = nodeRequire('../server/services/slackAgent.js')
const webpushAgent = nodeRequire('../server/services/webpushAgent.js')
// The nodemailer instance emailAgent itself resolved.
const nodemailer = createRequire(nodeRequire.resolve('../server/services/emailAgent.js'))('nodemailer')

const VALID_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123'

let fetchMock
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ['discord_agent', 'pushover_agent', 'telegram_agent', 'email_agent', 'slack_agent', 'webpush_agent']) {
    db.setSetting(key, JSON.stringify({ enabled: false }))
  }
})

describe('F03 — grouped type selections match their member events', () => {
  it('expands stored comma-joined entries when matching', () => {
    const stored = ['issue_comment_added_admin,issue_comment_added_user', 'movie_night_added,movie_night_invite']
    for (const event of ['issue_comment_added_admin', 'issue_comment_added_user', 'movie_night_added', 'movie_night_invite']) {
      expect(types.hasNotificationType(stored, event)).toBe(true)
    }
    expect(types.hasNotificationType(stored, 'request_pending')).toBe(false)
  })

  it('normalizes selections to unique canonical ids at save time', () => {
    expect(types.normalizeNotificationTypes(['a_b,c_d', 'c_d', ' request_pending ', 'autorequest', 42, 'Bad-Value']))
      .toEqual(['a_b', 'c_d', 'request_pending', 'request_auto_approved'])
  })

  it('maps deletion notices and list auto-requests to selectable types', () => {
    expect(types.hasNotificationType(['deletion'], 'deletion')).toBe(true)
    expect(types.hasNotificationType(['request_auto_approved'], 'autorequest')).toBe(true)
    expect(types.hasNotificationType(['movie_night_added'], 'notify_movie_night_added')).toBe(true)
  })

  it('migrates stored composite selections to flat event ids', () => {
    db.setSetting('gotify_agent', JSON.stringify({ enabled: false, notificationTypes: ['issue_new', 'issue_comment_added_admin,issue_comment_added_user'] }))
    expect(db.normalizeStoredNotificationTypes()).toContain('gotify_agent')
    expect(JSON.parse(db.getSetting('gotify_agent')).notificationTypes)
      .toEqual(['issue_new', 'issue_comment_added_admin', 'issue_comment_added_user'])
    expect(db.normalizeStoredNotificationTypes()).not.toContain('gotify_agent')
  })

  it('Discord and Pushover deliver an event selected through a grouped checkbox', async () => {
    db.setSetting('discord_agent', JSON.stringify({
      enabled: true, webhookEnabled: true, webhookUrl: VALID_WEBHOOK,
      webhookNotificationTypes: ['issue_comment_added_admin,issue_comment_added_user'],
    }))
    db.setSetting('pushover_agent', JSON.stringify({
      enabled: true, appToken: 'app', userKey: 'global-key',
      notificationTypes: ['issue_comment_added_admin,issue_comment_added_user'],
    }))
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }))
    const ctx = { recipientId: null, feed: true, delivered: [] }
    expect((await discordAgent.send('issue_comment_added_user', { title: 'Reply' }, ctx)).status).toBe('sent')
    expect((await pushoverAgent.send('issue_comment_added_admin', { title: 'Reply' }, ctx)).status).toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('F04 — Telegram MarkdownV2', () => {
  // Strips escaped characters; what remains must be only the entity markers we add.
  const unescapedSpecials = (text) => text.replace(/\\[\s\S]/g, '').match(/[_*[\]()~`>#+\-=|{}.!\\]/g) || []

  it('escapes every reserved character (and backslashes) in dynamic text', () => {
    const nasty = 'A_b*c[d](e)~f`g>h#i+j-k=l|m{n}o.p!q\\r'
    const escaped = telegramAgent.escapeText(nasty)
    expect(unescapedSpecials(escaped)).toEqual([])
    expect(escaped.replace(/\\([\s\S])/g, '$1')).toBe(nasty)
  })

  it('builds balanced messages for punctuation-heavy, multiline titles and bodies', () => {
    const msg = telegramAgent.buildMessage('request_available', {
      title: 'Mission: Impossible – Dead Reckoning (Part One)!',
      body: 'Line 1 = ok.\nC:\\Movies\\[2023] {4K} #1 | 50% off > *now*',
    })
    expect(unescapedSpecials(msg)).toEqual(['*', '*', '_', '_'])
    expect(msg.startsWith('*Mission: Impossible')).toBe(true)
    expect(msg.endsWith('\n\n_Diskovarr_')).toBe(true)
    expect(telegramAgent.buildMessage('test', { title: 'Audit!', body: 'Test = passed' }))
      .toBe('*Audit\\!*\nTest \\= passed\n\n_Diskovarr_')
  })

  it('keeps poster captions under Telegram limits and well-formed', async () => {
    db.setSetting('telegram_agent', JSON.stringify({ enabled: true, botAPI: 'TOKEN', chatId: '42', embedPoster: true, notificationTypes: ['request_available'] }))
    fetchMock.mockImplementation(async () => new Response('{"ok":true}', { status: 200 }))
    const result = await telegramAgent.send('request_available', {
      title: 'Big.Title!', body: 'x.'.repeat(2000), posterUrl: 'https://image.tmdb.org/t/p/w500/a.jpg',
    }, { recipientId: null, feed: true, delivered: [] })
    expect(result.status).toBe('sent')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/sendPhoto$/)
    const body = JSON.parse(opts.body)
    expect(body.parse_mode).toBe('MarkdownV2')
    // Telegram counts caption length after entity parsing (escapes don't count).
    expect(body.caption.replace(/\\([\s\S])/g, '$1').length).toBeLessThanOrEqual(1024)
    expect(unescapedSpecials(body.caption)).toEqual(['*', '*', '_', '_'])
  })

  it('the Send Test message is valid MarkdownV2', async () => {
    fetchMock.mockImplementation(async () => new Response('{"ok":true}', { status: 200 }))
    await telegramAgent.sendTest({ botAPI: 'TOKEN', chatId: '42' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(unescapedSpecials(body.text)).toEqual(['*', '*', '_', '_'])
  })

  it('never cuts an emoji in half when truncating the title or a caption body', () => {
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const text = telegramAgent.buildMessage(null, { title: 'a'.repeat(198) + '😀tail', body: 'x' })
    expect(text).not.toMatch(loneSurrogate)
    expect(text.startsWith(`*${'a'.repeat(198)}…*`)).toBe(true)
    const caption = telegramAgent.buildMessage(null, { title: 't', body: 'x'.repeat(698) + '😀 more' }, { caption: true })
    expect(caption).not.toMatch(loneSurrogate)
    expect(caption).toContain(`${'x'.repeat(698)}…`)
  })

  it('a personal chat that is the admin chat is not sent a second copy on a non-carrier row', async () => {
    db.setSetting('telegram_agent', JSON.stringify({ enabled: true, botAPI: 'TOKEN', chatId: '42', notificationTypes: ['request_pending'] }))
    fetchMock.mockImplementation(async () => new Response('{"ok":true}', { status: 200 }))
    db.setUserNotificationPrefs('tg-same', { telegram_enabled: true, telegram_chat_id: '42' })
    db.setUserNotificationPrefs('tg-own', { telegram_enabled: true, telegram_chat_id: '77' })
    const payload = { title: 'New request' }
    expect((await telegramAgent.send('request_pending', payload, { recipientId: 'tg-same', feed: true, delivered: [] })).status).toBe('sent')
    expect((await telegramAgent.send('request_pending', payload, { recipientId: 'tg-same', feed: false, delivered: [] })).status).toBe('skipped')
    expect((await telegramAgent.send('request_pending', payload, { recipientId: 'tg-own', feed: false, delivered: [] })).status).toBe('sent')
    expect(fetchMock.mock.calls.map(([, opts]) => JSON.parse(opts.body).chat_id)).toEqual(['42', '77'])
  })

  it('reports a Telegram 400 as a permanent failure and a 429 as retryable', async () => {
    db.setSetting('telegram_agent', JSON.stringify({ enabled: true, botAPI: 'TOKEN', chatId: '42', notificationTypes: ['request_available'] }))
    const ctx = { recipientId: null, feed: true, delivered: [] }
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false,"description":"can\'t parse entities"}', { status: 400 }))
    expect((await telegramAgent.send('request_available', { title: 'x' }, ctx)).status).toBe('failed')
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false,"parameters":{"retry_after":30}}', { status: 429 }))
    const limited = await telegramAgent.send('request_available', { title: 'x' }, ctx)
    expect(limited).toMatchObject({ status: 'retry', retryAfter: 30 })
  })
})

describe('F05 — SMTP transport follows saved settings; Send Test is isolated', () => {
  function fakeTransports() {
    const made = []
    vi.spyOn(nodemailer, 'createTransport').mockImplementation((options) => {
      const t = { options, sendMail: vi.fn(async () => ({})), close: vi.fn() }
      made.push(t)
      return t
    })
    return made
  }
  const saved = (overrides) => db.setSetting('email_agent', JSON.stringify({
    enabled: true, smtpHost: 'old.example.invalid', smtpPort: 587, emailFrom: 'from@example.invalid', requireTls: false, authUser: 'old-user', ...overrides,
  }))

  it('rebuilds the transport when host, port, TLS or auth change', () => {
    const made = fakeTransports()
    saved()
    const first = emailAgent.getTransporter()
    expect(emailAgent.getTransporter()).toBe(first)
    saved({ smtpHost: 'new.example.invalid', smtpPort: 465, requireTls: true, authUser: 'new-user' })
    const second = emailAgent.getTransporter()
    expect(second).not.toBe(first)
    expect(second.options).toMatchObject({ host: 'new.example.invalid', port: 465, requireTLS: true, auth: { user: 'new-user' } })
    expect(first.close).toHaveBeenCalled()
    expect(made).toHaveLength(2)
  })

  it('Send Test uses exactly the submitted settings on its own transport', async () => {
    const made = fakeTransports()
    saved()
    const shared = emailAgent.getTransporter()
    await emailAgent.sendTest({ smtpHost: 'test-host.example.invalid', smtpPort: 2525, emailFrom: 'test@example.invalid', requireTls: true })
    const testTransport = made[made.length - 1]
    expect(testTransport).not.toBe(shared)
    expect(testTransport.options).toMatchObject({ host: 'test-host.example.invalid', port: 2525, requireTLS: true })
    expect(testTransport.sendMail).toHaveBeenCalledTimes(1)
    expect(testTransport.close).toHaveBeenCalled()
    // The shared transport (queued mail) is untouched.
    expect(emailAgent.getTransporter()).toBe(shared)
    expect(shared.sendMail).not.toHaveBeenCalled()
  })
})

describe('F06 — email broadcasts use the notification address and opt-in', () => {
  it('reaches opted-in users with an address and reports real counts', async () => {
    const made = []
    vi.spyOn(nodemailer, 'createTransport').mockImplementation((options) => {
      const t = { options, sendMail: vi.fn(async () => ({})), close: vi.fn() }
      made.push(t)
      return t
    })
    db.setSetting('email_agent', JSON.stringify({ enabled: true, smtpHost: 'smtp.example.invalid', smtpPort: 587, emailFrom: 'from@example.invalid' }))
    db.upsertKnownUser('mail-on', 'On', null, null)
    db.upsertKnownUser('mail-off', 'Off', null, null)
    db.upsertKnownUser('mail-noaddr', 'NoAddr', null, null)
    db.setUserNotificationPrefs('mail-on', { email_enabled: true, email_address: 'on@example.invalid' })
    db.setUserNotificationPrefs('mail-off', { email_enabled: false, email_address: 'off@example.invalid' })
    db.setUserNotificationPrefs('mail-noaddr', { email_enabled: true })

    const tally = await emailAgent.sendBroadcast('Hello **all**')
    expect(tally).toEqual({ attempted: 1, sent: 1, failed: 0 })
    const sent = made.flatMap(t => t.sendMail.mock.calls.map(c => c[0].to))
    expect(sent).toEqual(['on@example.invalid'])
  })

  it('feed-only providers broadcast regardless of their type list, and the manager reports counts', async () => {
    db.setSetting('slack_agent', JSON.stringify({ enabled: true, webhookUrl: 'https://hooks.slack.invalid/x', notificationTypes: ['request_pending'] }))
    fetchMock.mockImplementation(async () => new Response('ok', { status: 200 }))
    expect(await slackAgent.sendBroadcast('Maintenance tonight')).toEqual({ attempted: 1, sent: 1, failed: 0 })
    const results = await manager.sendBroadcast('Maintenance tonight')
    expect(results.slack).toEqual({ attempted: 1, sent: 1, failed: 0 })
  })
})

describe('S05 — user-supplied destinations', () => {
  it('accepts only Discord HTTPS webhook URLs', () => {
    expect(destinations.isDiscordWebhookUrl(VALID_WEBHOOK)).toBe(true)
    expect(destinations.isDiscordWebhookUrl(VALID_WEBHOOK.replace('discord.com', 'canary.discord.com'))).toBe(true)
    expect(destinations.isDiscordWebhookUrl(VALID_WEBHOOK.replace('/api/', '/api/v10/'))).toBe(true)
    for (const bad of [
      'http://127.0.0.1:9999/internal',
      VALID_WEBHOOK.replace('https:', 'http:'),
      VALID_WEBHOOK.replace('discord.com', 'discord.com.evil.example'),
      VALID_WEBHOOK.replace('discord.com', 'discord.com:8443'),
      VALID_WEBHOOK.replace('https://', 'https://user:pw@'),
      'https://discord.com/api/channels/1/messages',
      'https://127.0.0.1/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
      'not a url',
    ]) expect(destinations.isDiscordWebhookUrl(bad), bad).toBe(false)
  })

  it('rejects push endpoints on loopback, private, link-local or localhost (any spelling)', () => {
    expect(destinations.isSafePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(destinations.isSafePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1:9443/private', 'https://0x7f.1/x', 'https://2130706433/x', 'https://[::1]/x',
      'https://[::ffff:127.0.0.1]/x', 'https://10.0.0.5/x', 'https://192.168.1.10/x', 'https://172.16.0.1/x',
      'https://169.254.169.254/latest', 'https://[fe80::1]/x', 'https://[fd00::1]/x', 'https://localhost/x',
      'https://push.localhost/x', 'https://0.0.0.0/x',
    ]) expect(destinations.isSafePushEndpoint(bad), bad).toBe(false)
  })

  it('judges NAT64 addresses by the IPv4 they carry; the local-use NAT64 prefix is blocked', () => {
    for (const ok of ['64:ff9b::808:808', '64:ff9b::8.8.8.8', '8.8.8.8', '2606:4700::1']) {
      expect(destinations.isPrivateAddress(ok), ok).toBe(false)
    }
    for (const bad of ['64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::192.168.1.1', '64:ff9b:1::a00:1', '64:ff9b:1:ab::808:808', '::ffff:7f00:1', '::1']) {
      expect(destinations.isPrivateAddress(bad), bad).toBe(true)
    }
    expect(destinations.isSafePushEndpoint('https://[64:ff9b::808:808]/x')).toBe(true)
    expect(destinations.isSafePushEndpoint('https://[64:ff9b:1::a00:1]/x')).toBe(false)
  })

  it('refuses to connect when a push host resolves to a private address', async () => {
    const err = await new Promise((resolve) => destinations.publicOnlyLookup('localhost', {}, (e) => resolve(e)))
    expect(err).toMatchObject({ code: 'EPRIVATEADDR', retryable: false })
  })

  it('never sends to a stored personal webhook that is not Discord', async () => {
    db.setSetting('discord_agent', JSON.stringify({ enabled: true, webhookEnabled: true, webhookUrl: VALID_WEBHOOK, webhookNotificationTypes: ['request_available'] }))
    db.setUserNotificationPrefs('hooky', { discord_enabled: true, discord_webhook: 'http://127.0.0.1:9999/internal' })
    const result = await discordAgent.send('request_available', { title: 'Audit' }, { recipientId: 'hooky', feed: false, delivered: [] })
    expect(result.status).toBe('failed')
    expect(fetchMock.mock.calls.map(c => String(c[0]))).not.toContain('http://127.0.0.1:9999/internal')
  })

  it('registers push subscriptions only when enabled and only for allowed endpoints', () => {
    const sub = (endpoint) => ({ endpoint, keys: { auth: 'authKey_12345', p256dh: 'p256dhKey_12345' } })
    db.setSetting('webpush_agent', JSON.stringify({ enabled: false }))
    expect(webpushAgent.registerSubscription('pusher', sub('https://fcm.googleapis.com/fcm/send/1')))
      .toMatchObject({ ok: false, status: 400 })
    db.setSetting('webpush_agent', JSON.stringify({ enabled: true }))
    expect(webpushAgent.registerSubscription('pusher', sub('https://127.0.0.1:9443/private')).ok).toBe(false)
    expect(webpushAgent.registerSubscription('pusher', sub('http://fcm.googleapis.com/fcm/send/1')).ok).toBe(false)
    expect(webpushAgent.registerSubscription('pusher', sub('https://fcm.googleapis.com/fcm/send/1'))).toEqual({ ok: true })
    expect(db.getUserNotificationPrefs('pusher').webpush_enabled).toBe(true)
  })
})
