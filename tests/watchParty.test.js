import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Watch Together roster and lifecycle (the playback sync itself is covered in
// watchPartySync.test.js). Runs against a throwaway database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-watch-party-test-'))
process.env.TUBERR_MANAGED = '0'
process.env.PLEX_URL = 'http://192.168.1.10:32400'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const watchParty = nodeRequire('../server/services/watchParty/index.js')
const plexDriver = nodeRequire('../server/services/watchParty/plexDriver.js')
const jellyfinDriver = nodeRequire('../server/services/watchParty/jellyfinDriver.js')
const jfClient = nodeRequire('../server/services/jellyfin/client.js')

beforeAll(() => {
  db.prepare("INSERT INTO known_users (user_id, username) VALUES ('u1','alice'),('u2','bob'),('u3','carol')").run()
})

const freshParty = () => db.createWatchParty({ hostId: 'u1', source: 'plex', ratingKey: '100', title: 'Alien', subtitle: '1979', thumb: '/t', durationMs: 7000000 })

describe('roster', () => {
  it('makes the creator the host and invites each guest once', () => {
    const party = freshParty()
    watchParty.invite(party, ['u2', 'u2', 'u1', 'nobody'])
    watchParty.invite(party, ['u2', 'u3'])
    const members = db.getWatchPartyMembers(party.id)
    expect(members.map(m => `${m.user_id}:${m.role}:${m.status}`)).toEqual(['u1:host:invited', 'u2:guest:invited', 'u3:guest:invited'])
    const invites = db.prepare("SELECT user_id FROM notifications WHERE type = 'watch_party_invite' AND data LIKE ?").all(`%"partyId":${party.id}%`)
    expect(invites.map(n => n.user_id).sort()).toEqual(['u2', 'u3'])
  })

  it('lists open parties for members who have not declined', () => {
    const party = freshParty()
    watchParty.invite(party, ['u2', 'u3'])
    db.setWatchPartyMemberStatus(party.id, 'u3', 'declined')
    expect(db.getOpenWatchPartiesForUser('u2').map(p => p.id)).toContain(party.id)
    expect(db.getOpenWatchPartiesForUser('u3').map(p => p.id)).not.toContain(party.id)
    watchParty.endParty(party.id)
    expect(db.getOpenWatchPartiesForUser('u2').map(p => p.id)).not.toContain(party.id)
  })

  it('never removes the host', () => {
    const party = freshParty()
    db.removeWatchPartyMember(party.id, 'u1')
    expect(db.getWatchPartyMember(party.id, 'u1')).not.toBeNull()
  })
})

describe('snapshot', () => {
  it('describes a lobby from the viewer\'s side', () => {
    const party = freshParty()
    watchParty.invite(party, ['u2'])
    db.setWatchPartyMemberDevice(party.id, 'u1', { clientId: 'tv-1', clientName: 'Living Room', controlBase: 'http://pms' })
    const snap = watchParty.snapshot(db.getWatchParty(party.id), 'u2')
    expect(snap.isHost).toBe(false)
    expect(snap.playback).toBeNull()
    expect(snap.members.map(m => [m.username, m.status, m.deviceName])).toEqual([['alice', 'ready', 'Living Room'], ['bob', 'invited', null]])
  })

  it('refuses to start until the host has picked a TV', async () => {
    const party = freshParty()
    await expect(watchParty.startParty(party)).rejects.toThrow(/Pick the TV/)
    expect(db.getWatchParty(party.id).status).toBe('lobby')
  })
})

describe('restart recovery', () => {
  it('closes parties that were mid-playback and abandoned lobbies', () => {
    const playing = freshParty()
    db.setWatchPartyStatus(playing.id, 'playing')
    const stale = freshParty()
    db.prepare('UPDATE watch_parties SET created_at = unixepoch() - 90000 WHERE id = ?').run(stale.id)
    const fresh = freshParty()
    watchParty.init()
    expect(db.getWatchParty(playing.id).status).toBe('ended')
    expect(db.getWatchParty(stale.id).status).toBe('ended')
    expect(db.getWatchParty(fresh.id).status).toBe('lobby')
  })
})

describe('player timeline parsing', () => {
  it('reads the video timeline and ignores the others', () => {
    const xml = '<MediaContainer><Timeline state="stopped" type="music" /><Timeline address="x" duration="1288722" ratingKey="703306" state="playing" time="56928" type="video" /><Timeline state="stopped" type="photo" /></MediaContainer>'
    expect(plexDriver.parseTimeline(xml)).toEqual({ state: 'playing', time: 56928, duration: 1288722, ratingKey: '703306' })
  })

  it('reports an idle player as stopped and garbage as unreachable', () => {
    expect(plexDriver.parseTimeline('<MediaContainer><Timeline state="stopped" type="video" /></MediaContainer>').state).toBe('stopped')
    expect(plexDriver.parseTimeline('<html>502</html>')).toBeNull()
  })
})

describe('Jellyfin driver', () => {
  const TICKS = 10000
  let sessionList = []
  let calls = []
  beforeAll(() => {
    db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
    db.setSetting('jellyfin_api_key', 'admin-key')
    db.setSetting('jellyfin_enabled', '1')
    db.upsertJellyfinUser('jf_guid-9', 'dana', null, 'dana-token')
    jfClient.jfFetch = async (p, opts = {}) => {
      calls.push({ path: p, method: opts.method || 'GET', token: opts.token || null })
      if (p.startsWith('/Sessions?')) return sessionList
      if (p.startsWith('/Users/guid-9/Items/ep-2')) {
        return { Id: 'ep-2', Type: 'Episode', Name: 'Pilot', SeriesName: 'Severance', ParentIndexNumber: 1, IndexNumber: 2, RunTimeTicks: 3000000 * TICKS }
      }
      if (p.startsWith('/Shows/NextUp')) return { Items: [{ Id: 'ep-2' }] }
      return null
    }
  })
  const tv = (extra = {}) => ({ Id: 'sess-1', DeviceName: 'Den TV', Client: 'Jellyfin Android TV', DeviceId: 'd1', Capabilities: { PlayableMediaTypes: ['Video'] }, ...extra })

  it('uses the stored Jellyfin identity and pins a show to one episode', async () => {
    db.prepare("INSERT OR REPLACE INTO library_items (rating_key, section_id, title, type, thumb, source) VALUES ('series-1', 'jf_tv', 'Severance', 'show', '/Items/series-1/Images/Primary?tag=a', 'jellyfin')").run()
    const item = await jellyfinDriver.resolveItem('series-1', 'jf_guid-9')
    expect(item).toEqual({ ratingKey: 'ep-2', title: 'Severance', subtitle: 'S1E2 · Pilot', thumb: '/Items/series-1/Images/Primary?tag=a', durationMs: 3000000 })
  })

  it('creates a Jellyfin party for a Jellyfin title', async () => {
    const party = await watchParty.createParty({ hostId: 'jf_guid-9', ratingKey: 'series-1', userIds: [] })
    expect([party.source, party.rating_key]).toEqual(['jellyfin', 'ep-2'])
    expect(watchParty.snapshot(party, 'jf_guid-9').source).toBe('jellyfin')
  })

  it('only accepts a device that is one of the member\'s sessions', async () => {
    sessionList = [tv()]
    await expect(jellyfinDriver.registerDevice('jf_guid-9', 'sess-1')).resolves.toEqual({ clientName: 'Den TV (Jellyfin Android TV)', controlBase: null })
    await expect(jellyfinDriver.registerDevice('jf_guid-9', 'other')).rejects.toThrow(/not found/)
    await expect(jellyfinDriver.registerDevice('u1', 'sess-1')).rejects.toThrow(/linked Jellyfin account/)
  })

  it('reports an advancing position between an app\'s progress reports', async () => {
    const player = await jellyfinDriver.playerFor({ user_id: 'jf_guid-9', client_id: 'sess-1' })
    const playing = (ms) => [tv({ NowPlayingItem: { Id: 'ep-2', RunTimeTicks: 3000000 * TICKS }, PlayState: { PositionTicks: ms * TICKS, IsPaused: false } })]
    sessionList = playing(60000)
    expect(await jellyfinDriver.pollTimeline(player, 1000000)).toMatchObject({ state: 'playing', time: 60000, ratingKey: 'ep-2', duration: 3000000 })
    expect((await jellyfinDriver.pollTimeline(player, 1004000)).time).toBe(64000)
    sessionList = playing(70000)
    expect((await jellyfinDriver.pollTimeline(player, 1010000)).time).toBe(70000)
    sessionList = [tv({ NowPlayingItem: { Id: 'ep-2' }, PlayState: { PositionTicks: 71000 * TICKS, IsPaused: true } })]
    expect(await jellyfinDriver.pollTimeline(player, 1015000)).toMatchObject({ state: 'paused', time: 71000 })
    expect((await jellyfinDriver.pollTimeline(player, 1019000)).time).toBe(71000)
    sessionList = [tv()]
    expect((await jellyfinDriver.pollTimeline(player, 1020000)).state).toBe('stopped')
    sessionList = []
    expect(await jellyfinDriver.pollTimeline(player, 1021000)).toBeNull()
  })

  it('sends load, pause, resume and seek as Jellyfin session commands with the member\'s token', async () => {
    const player = await jellyfinDriver.playerFor({ user_id: 'jf_guid-9', client_id: 'sess-1' })
    calls = []
    await jellyfinDriver.load({ rating_key: 'ep-2' }, player, 90000)
    await jellyfinDriver.sendCommand(player, 'pause')
    await jellyfinDriver.sendCommand(player, 'play')
    await jellyfinDriver.sendCommand(player, 'seekTo', { offset: 120000.4 })
    expect(calls.map(c => `${c.method} ${c.path} ${c.token}`)).toEqual([
      'POST /Sessions/sess-1/Playing?ItemIds=ep-2&PlayCommand=PlayNow&StartPositionTicks=900000000 dana-token',
      'POST /Sessions/sess-1/Playing/Pause dana-token',
      'POST /Sessions/sess-1/Playing/Unpause dana-token',
      'POST /Sessions/sess-1/Playing/Seek?SeekPositionTicks=1200000000 dana-token',
    ])
  })
})
