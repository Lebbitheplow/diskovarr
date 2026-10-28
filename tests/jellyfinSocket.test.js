import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-jf-sock-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const library = nodeRequire('../server/services/jellyfin/library.js')
const socket = nodeRequire('../server/services/jellyfin/socket.js')

db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
db.setSetting('jellyfin_api_key', 'test-key')
db.setSetting('jellyfin_enabled', '1')

// Fake WebSocket: records the URL and outbound frames, exposes the handlers the
// module assigns so a test can drive open/message/close by hand.
let sockets = []
class FakeWebSocket {
  constructor(url, options) {
    this.options = options
    this.url = url
    this.sent = []
    this.closed = false
    sockets.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true }
  open() { this.onopen?.() }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  serverClose(code = 1006) { this.onclose?.({ code }) }
}

const flush = () => new Promise(r => setImmediate(r))

let upsertCalls, refreshCalls, pollCalls, delivered
beforeEach(() => {
  // Only the timer APIs the module uses — leave setImmediate real so flush() works.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  globalThis.WebSocket = FakeWebSocket
  sockets = []
  upsertCalls = []
  refreshCalls = []
  pollCalls = 0
  delivered = []
  library.upsertItemsByIds = async (ids) => { upsertCalls.push(ids); return ids.map(id => ({ ratingKey: id })) }
  library.pollNewItems = async () => { pollCalls++; return [{ ratingKey: 'polled' }] }
  library.refreshKnownItems = async (ids) => { refreshCalls.push(ids); return [{ ratingKey: ids[0] }] }
})
afterEach(() => {
  socket.stop()
  vi.useRealTimers()
})

function openSocket() {
  socket.sync(fresh => delivered.push(fresh))
  expect(sockets).toHaveLength(1)
  const ws = sockets[0]
  ws.open()
  return ws
}

describe('jellyfin socket', () => {
  it('connects with the api key, seeds the poll watermark on open, and reports isConnected', async () => {
    expect(socket.isConnected()).toBe(false)
    const ws = openSocket()
    expect(ws.url).toBe('ws://jellyfin.test:8096/socket?deviceId=diskovarr-app')
    expect(ws.options.headers.Authorization).toMatch(/^MediaBrowser /)
    expect(ws.options.headers.Authorization).toContain('Token="test-key"')
    expect(ws.url).not.toContain('test-key')
    expect(socket.isConnected()).toBe(true)
    await flush()
    expect(pollCalls).toBe(1) // watermark only; nothing delivered
    expect(delivered).toEqual([])
    socket.stop()
    expect(ws.closed).toBe(true)
    expect(socket.isConnected()).toBe(false)
  })

  it('LibraryChanged with ItemsAdded → upsertItemsByIds, delivered to the handler', async () => {
    const ws = openSocket()
    await flush()
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['a', 'b'], ItemsUpdated: [], ItemsRemoved: [] } })
    await flush()
    expect(upsertCalls).toEqual([['a', 'b']])
    expect(delivered).toEqual([[{ ratingKey: 'a' }, { ratingKey: 'b' }]])
    vi.advanceTimersByTime(5000)
    await flush()
    expect(pollCalls).toBe(1) // no poll for a direct add
  })

  it('LibraryChanged without an ItemsAdded list → debounced pollNewItems', async () => {
    const ws = openSocket()
    await flush()
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsUpdated: ['x'] } })
    ws.message({ MessageType: 'LibraryChanged', Data: {} })
    expect(pollCalls).toBe(1)
    vi.advanceTimersByTime(2999)
    expect(pollCalls).toBe(1)
    vi.advanceTimersByTime(1)
    await flush()
    expect(pollCalls).toBe(2) // two messages, one debounced poll
    expect(upsertCalls).toEqual([])
    expect(delivered).toEqual([[{ ratingKey: 'polled' }]])
  })

  it('LibraryChanged with an empty ItemsAdded list is ignored', async () => {
    const ws = openSocket()
    await flush()
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: [], ItemsRemoved: ['gone'] } })
    vi.advanceTimersByTime(5000)
    await flush()
    expect(pollCalls).toBe(1)
    expect(upsertCalls).toEqual([])
  })

  it('a burst of more than 50 ids is still fetched by id (chunked in the library), not reduced to a poll', async () => {
    const ws = openSocket()
    await flush()
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`)
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ids } })
    vi.advanceTimersByTime(3000)
    await flush()
    expect(upsertCalls).toEqual([ids])
    expect(pollCalls).toBe(1)
  })

  it('ItemsUpdated with no adds refreshes known rows; only newly identified items are delivered', async () => {
    const ws = openSocket()
    await flush()
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: [], ItemsUpdated: ['u1', 'u2'] } })
    await flush()
    expect(refreshCalls).toEqual([['u1', 'u2']])
    expect(upsertCalls).toEqual([])
    expect(delivered).toEqual([[{ ratingKey: 'u1' }]])
  })

  it('by-id batches run one at a time', async () => {
    const order = []
    let release
    library.upsertItemsByIds = async (ids) => {
      order.push(`start ${ids[0]}`)
      if (ids[0] === 'a') await new Promise(r => { release = r })
      order.push(`end ${ids[0]}`)
      return []
    }
    const ws = openSocket()
    await flush()
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['a'] } })
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['b'] } })
    await flush()
    expect(order).toEqual(['start a'])
    release()
    await flush(); await flush()
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('a failed by-id fetch falls back to the poll', async () => {
    library.upsertItemsByIds = async () => { throw new Error('502') }
    const ws = openSocket()
    await flush()
    ws.message({ MessageType: 'LibraryChanged', Data: { ItemsAdded: ['a'] } })
    await flush()
    vi.advanceTimersByTime(3000)
    await flush()
    expect(pollCalls).toBe(2)
    expect(delivered).toEqual([[{ ratingKey: 'polled' }]])
  })

  it('answers ForceKeepAlive at half the advertised timeout', () => {
    const ws = openSocket()
    const keepAlives = () => ws.sent.filter(m => m.MessageType === 'KeepAlive')
    ws.message({ MessageType: 'ForceKeepAlive', Data: 60 })
    vi.advanceTimersByTime(29_999)
    expect(keepAlives()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(keepAlives()).toEqual([{ MessageType: 'KeepAlive' }])
    vi.advanceTimersByTime(30_000)
    expect(keepAlives()).toHaveLength(2)
  })

  it('ignores malformed frames and unknown message types', () => {
    const ws = openSocket()
    ws.onmessage({ data: 'not json' })
    ws.message({ MessageType: 'Sessions', Data: [] })
    expect(upsertCalls).toEqual([])
  })

  it('reconnects with backoff after a server-side close', async () => {
    const ws = openSocket()
    ws.serverClose(1006)
    expect(socket.isConnected()).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    expect(socket.isConnected()).toBe(true)
  })

  it('subscribes to session updates on open', () => {
    const ws = openSocket()
    expect(ws.sent[0]).toEqual({ MessageType: 'SessionsStart', Data: '0,1500' })
  })

  it('sync() with Jellyfin disabled stops the socket', () => {
    const ws = openSocket()
    db.setSetting('jellyfin_enabled', '0')
    socket.sync()
    expect(ws.closed).toBe(true)
    expect(socket.isConnected()).toBe(false)
    db.setSetting('jellyfin_enabled', '1')
  })
})

describe('per-play history from Sessions messages', () => {
  const movie = { Id: 'm-1', Name: 'Heat', Type: 'Movie', ProductionYear: 1995, RunTimeTicks: 100 * 10_000_000, ImageTags: { Primary: 't' } }
  const episode = { Id: 'e-1', Name: 'Pilot', Type: 'Episode', SeriesId: 's-1', SeriesName: 'The Wire', SeasonId: 'sea-1', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 100 * 10_000_000 }
  const session = (id, item, positionSec, extra = {}) => ({
    Id: id, UserId: 'guid-1', UserName: 'kaleb', NowPlayingItem: item,
    PlayState: { PositionTicks: positionSec * 10_000_000, IsPaused: false }, ...extra,
  })
  const rows = () => db.prepare("SELECT * FROM watch_history WHERE source = 'jellyfin' ORDER BY watched_at").all()

  beforeEach(() => {
    db.prepare("DELETE FROM watch_history").run()
    db.seedJellyfinUser('jf_guid-1', 'kaleb', null)
  })

  it('writes one row with the real played length when the item stops', () => {
    const t0 = Date.now()
    vi.setSystemTime(t0)
    socket.handleSessions([session('tv', movie, 0)])
    expect(socket.trackedPlays()).toBe(1)
    vi.setSystemTime(t0 + 45_000)
    socket.handleSessions([session('tv', movie, 45)])
    vi.setSystemTime(t0 + 90_000)
    socket.handleSessions([session('tv', movie, 90)])
    vi.setSystemTime(t0 + 95_000)
    socket.handleSessions([{ Id: 'tv', UserId: 'guid-1', UserName: 'kaleb' }]) // NowPlayingItem gone
    expect(socket.trackedPlays()).toBe(0)
    const [row] = rows()
    // 90 s observed playing plus the 5 s until it vanished; progress from the last position.
    expect(row).toMatchObject({
      user_id: 'jf_guid-1', rating_key: 'm-1', media_type: 'movie', title: 'Heat', year: 1995,
      duration: 95, percent_complete: 90, watched_status: 'complete', user_name: 'kaleb', source: 'jellyfin',
      origin: 'session', watched_at: Math.floor(t0 / 1000),
    })
    // Identity: user, item, session and start — stable across a reconnect.
    expect(row.history_id).toBe(`jfs:guid-1:m-1:tv:${Math.floor(t0 / 1000)}`)
  })

  it('keys episodes on the series, resolves linked users, and records incomplete plays', () => {
    db.seedKnownUser('777', 'plex', null, null)
    db.linkJellyfinAccount('jf_guid-1', '777')
    const t0 = Date.now()
    vi.setSystemTime(t0)
    socket.handleSessions([session('tv', episode, 10)])
    vi.setSystemTime(t0 + 45_000)
    socket.handleSessions([session('tv', episode, 55)])
    vi.setSystemTime(t0 + 46_000)
    socket.handleSessions([]) // session vanished entirely
    const [row] = rows()
    expect(row).toMatchObject({
      user_id: '777', rating_key: 'e-1', grandparent_rating_key: 's-1', parent_rating_key: 'sea-1', parent_title: 'The Wire',
      media_type: 'episode', season_number: 1, episode_number: 1, duration: 46, percent_complete: 55, watched_status: 'incomplete',
    })
    db.unlinkJellyfinAccount('jf_guid-1')
  })

  it('switching items mid-session closes the first play and starts the second', () => {
    const t0 = Date.now()
    vi.setSystemTime(t0)
    socket.handleSessions([session('tv', movie, 0)])
    vi.setSystemTime(t0 + 60_000)
    socket.handleSessions([session('tv', movie, 60)])
    vi.setSystemTime(t0 + 61_000)
    socket.handleSessions([session('tv', episode, 0)])
    expect(rows().map(r => r.rating_key)).toEqual(['m-1'])
    expect(socket.trackedPlays()).toBe(1)
    socket.flushPlays()
    expect(socket.trackedPlays()).toBe(0)
  })

  it('ignores short plays, non-video items, sessions without a user, and bad payloads', () => {
    const t0 = Date.now()
    vi.setSystemTime(t0)
    socket.handleSessions([
      session('short', movie, 0),
      session('music', { Id: 'a-1', Name: 'Song', Type: 'Audio', RunTimeTicks: 1 }, 0),
      { Id: 'nouser', NowPlayingItem: movie, PlayState: {} },
      null, 'garbage',
    ])
    expect(socket.trackedPlays()).toBe(1)
    vi.setSystemTime(t0 + 10_000)
    socket.handleSessions([])
    expect(rows()).toEqual([])
    socket.handleSessions('not an array')
    socket.handleMessage(JSON.stringify({ MessageType: 'Sessions', Data: { bogus: true } }))
  })

  it('replaces a same-window item-level row from the user sync with the real play', () => {
    const t0 = Date.now()
    const nowSec = Math.floor(t0 / 1000)
    db.upsertWatchHistoryBatch([{
      historyId: `jf:guid-1:m-1:${nowSec - 600}`, userId: 'jf_guid-1', ratingKey: 'm-1', mediaType: 'movie',
      title: 'Heat', watchedAt: nowSec - 600, duration: 100, percentComplete: 100, source: 'jellyfin',
    }])
    vi.setSystemTime(t0)
    socket.handleSessions([session('tv', movie, 0)])
    vi.setSystemTime(t0 + 40_000)
    socket.handleSessions([session('tv', movie, 40)])
    vi.setSystemTime(t0 + 41_000)
    socket.handleSessions([])
    const all = rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ duration: 41, origin: 'session' })
  })
})

describe('played-time accounting (pauses, seeks, reconnects)', () => {
  const movie = { Id: 'm-acct', Name: 'Ronin', Type: 'Movie', RunTimeTicks: 2000 * 10_000_000 }
  const rows = () => db.prepare("SELECT * FROM watch_history WHERE source = 'jellyfin' ORDER BY watched_at, history_id").all()
  // A session observation: position in seconds (null = the player sent none).
  const obs = (sid, positionSec, { paused = false, item = movie } = {}) => ({
    Id: sid, UserId: 'guid-acct', UserName: 'kaleb', NowPlayingItem: item,
    PlayState: positionSec == null ? { IsPaused: paused } : { PositionTicks: positionSec * 10_000_000, IsPaused: paused },
  })
  let t0
  const at = (sec, list) => { vi.setSystemTime(t0 + sec * 1000); socket.handleSessions(list) }
  // Observations every 10 s from `from` to `to` (inclusive) for each session,
  // the position advancing at `rate` from `pos` (null = no position reported).
  const playFor = (sids, from, to, pos, { rate = 1, paused = false } = {}) => {
    for (let t = from; t <= to; t += 10) {
      const p = pos == null ? null : (paused ? pos : pos + (t - from) * rate)
      at(t, [].concat(sids).map(sid => obs(sid, p, { paused })))
    }
  }

  beforeEach(() => {
    db.prepare("DELETE FROM watch_history").run()
    db.seedJellyfinUser('jf_guid-acct', 'kaleb', null)
    t0 = Math.floor(Date.now() / 1000) * 1000
  })

  it('records nothing for a session paused the whole time', () => {
    playFor('p1', 0, 3600, 600, { paused: true })
    at(3601, [])
    expect(rows()).toEqual([])
  })

  it('excludes paused time between stretches of playback', () => {
    playFor('p2', 0, 60, 0)
    playFor('p2', 61, 661, 61, { paused: true })
    playFor('p2', 662, 722, 61)
    at(723, [])
    expect(rows()).toMatchObject([{ duration: 122, percent_complete: 6 }])
  })

  it('does not count a forward seek as watched time, even before a long pause', () => {
    playFor('p3', 0, 30, 0)
    at(31, [obs('p3', 1830)]) // seek
    playFor('p3', 32, 3632, 1831, { paused: true })
    at(3633, [])
    // Completion still comes from where the player stopped.
    expect(rows()).toMatchObject([{ duration: 32, percent_complete: 92, watched_status: 'complete' }])
  })

  it('counts a replayed section after a backward seek', () => {
    playFor('p4', 0, 120, 0)
    playFor('p4', 121, 241, 0) // seek back, watch it again
    at(242, [])
    expect(rows()).toMatchObject([{ duration: 242, percent_complete: 6 }])
  })

  it('records wall time at faster playback speeds', () => {
    playFor('p5', 0, 60, 0, { rate: 2 })
    at(61, [])
    expect(rows()).toMatchObject([{ duration: 61, percent_complete: 6 }])
  })

  it('falls back to playing time when the player reports no position', () => {
    playFor('p6', 0, 60, null)
    at(61, [])
    expect(rows()).toMatchObject([{ duration: 61, percent_complete: 3 }])
  })

  it('caps the credit for a stretch with no updates before the session vanished', () => {
    playFor('p7', 0, 60, 0)
    at(600, []) // nine silent minutes, then gone
    expect(rows()).toMatchObject([{ duration: 75 }])
  })

  it('continues one play across a socket reconnect', () => {
    playFor('p8', 0, 120, 0)
    vi.setSystemTime(t0 + 121_000)
    socket.flushPlays() // socket dropped
    expect(rows()).toMatchObject([{ duration: 121 }])
    playFor('p8', 180, 300, 178) // reconnected: same session and item
    at(301, [])
    const all = rows()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ duration: 242, watched_at: t0 / 1000, history_id: `jfs:guid-acct:m-acct:p8:${t0 / 1000}` })
  })

  it('starts a new play when the reconnect comes long after the drop', () => {
    playFor('p9', 0, 120, 0)
    vi.setSystemTime(t0 + 121_000)
    socket.flushPlays()
    playFor('p9', 1000, 1060, 125)
    at(1061, [])
    expect(rows().map(r => r.duration)).toEqual([121, 61])
  })

  it('keeps two devices playing the same title as two plays', () => {
    playFor(['tv-a', 'tv-b'], 0, 120, 0)
    at(121, [])
    expect(rows().map(r => [r.history_id.split(':')[3], r.duration])).toEqual([['tv-a', 121], ['tv-b', 121]])
  })

  it('keeps two same-day rewatches as two plays', () => {
    playFor('p10', 0, 120, 0)
    at(121, [])
    playFor('p10', 7200, 7320, 0)
    at(7321, [])
    expect(rows().map(r => r.watched_at - t0 / 1000)).toEqual([0, 7200])
  })

  it('skips a play Playback Reporting already recorded', () => {
    db.upsertWatchHistoryBatch([{
      historyId: `jf:guid-acct:m-acct:${t0 / 1000 - 5}`, userId: 'jf_guid-acct', ratingKey: 'm-acct', mediaType: 'movie',
      title: 'Ronin', watchedAt: t0 / 1000 - 5, duration: 130, source: 'jellyfin', origin: 'plugin',
    }])
    playFor('p11', 0, 120, 0)
    at(121, [])
    expect(rows().map(r => r.origin)).toEqual(['plugin'])
  })
})
