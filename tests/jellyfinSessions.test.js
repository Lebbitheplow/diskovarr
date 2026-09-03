import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-jf-sess-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const client = nodeRequire('../server/services/jellyfin/client.js')
const sessions = nodeRequire('../server/services/jellyfin/sessions.js')
const playlists = nodeRequire('../server/services/jellyfin/playlists.js')

db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
db.setSetting('jellyfin_api_key', 'admin-key')
db.setSetting('jellyfin_enabled', '1')

function mockFetch(handler) {
  const calls = []
  client.jfFetch = async (p, opts = {}) => {
    calls.push({ path: p, method: opts.method || 'GET', token: opts.token || null, body: opts.body || null })
    const [pathname, qs = ''] = p.split('?')
    const out = handler(pathname, new URLSearchParams(qs), opts)
    return out === undefined ? null : out
  }
  return calls
}

const SESSIONS = [
  { Id: 'tv-1', DeviceName: 'Living Room TV', Client: 'Jellyfin Android TV', DeviceId: 'd1', UserId: 'u1', UserName: 'kaleb',
    Capabilities: { PlayableMediaTypes: ['Audio', 'Video'] }, NowPlayingItem: { Id: 'm-9', Name: 'Heat' } },
  { Id: 'self', DeviceName: 'Diskovarr', Client: 'Diskovarr', DeviceId: 'diskovarr-app', UserId: 'u1',
    Capabilities: { PlayableMediaTypes: ['Video'] } },
  { Id: 'audio-only', DeviceName: 'Finamp', Client: 'Finamp', DeviceId: 'd2', UserId: 'u1',
    Capabilities: { PlayableMediaTypes: ['Audio'] } },
  { Id: 'no-caps', DeviceName: 'Mystery', Client: 'X', DeviceId: 'd3', UserId: 'u1' },
  { Id: 'no-remote', DeviceName: 'Locked', Client: 'Jellyfin Web', DeviceId: 'd4', UserId: 'u1', SupportsRemoteControl: false,
    Capabilities: { PlayableMediaTypes: ['Video'] } },
  { Id: 'web-1', DeviceName: 'Firefox', Client: 'Jellyfin Web', DeviceId: 'd5', UserId: 'u1',
    Capabilities: { PlayableMediaTypes: ['Video'] } },
]

describe('listControllableSessions', () => {
  it('keeps only video-capable, remotely controllable sessions and skips Diskovarr itself', async () => {
    const calls = mockFetch((pathname) => (pathname === '/Sessions' ? SESSIONS : undefined))
    const list = await sessions.listControllableSessions('u1', { token: 'user-tok' })
    expect(calls[0]).toMatchObject({ path: '/Sessions?ControllableByUserId=u1', token: 'user-tok' })
    expect(list.map(s => s.id)).toEqual(['tv-1', 'web-1'])
    expect(list[0]).toMatchObject({
      name: 'Living Room TV (Jellyfin Android TV)', client: 'Jellyfin Android TV', deviceName: 'Living Room TV',
      userId: 'u1', userName: 'kaleb', nowPlayingItemId: 'm-9', nowPlayingTitle: 'Heat',
    })
    expect(sessions.toClient(list[0])).toEqual({
      name: 'Living Room TV (Jellyfin Android TV)', machineIdentifier: 'tv-1', product: 'Jellyfin Android TV',
      platform: 'Living Room TV', source: 'jellyfin', nowPlaying: { itemId: 'm-9', title: 'Heat' },
    })
  })

  it('falls back to the admin key when no user token is given and returns [] when disabled', async () => {
    const calls = mockFetch((pathname) => (pathname === '/Sessions' ? [] : undefined))
    await sessions.listControllableSessions('u1')
    expect(calls[0].token).toBeNull()
    db.setSetting('jellyfin_enabled', '0')
    expect(await sessions.listControllableSessions('u1')).toEqual([])
    db.setSetting('jellyfin_enabled', '1')
  })
})

describe('playOnSession / command', () => {
  it('posts PlayNow with the item ids', async () => {
    const calls = mockFetch(() => null)
    await sessions.playOnSession('tv-1', ['a', 'b'], { token: 't', startPositionTicks: 500 })
    expect(calls[0]).toMatchObject({ method: 'POST', token: 't', path: '/Sessions/tv-1/Playing?ItemIds=a%2Cb&PlayCommand=PlayNow&StartPositionTicks=500' })
    await expect(sessions.playOnSession('tv-1', [])).rejects.toThrow(/itemIds/)
  })

  it('maps playstate commands case-insensitively and rejects unknown ones', async () => {
    const calls = mockFetch(() => null)
    await sessions.command('tv-1', 'pause')
    await sessions.command('tv-1', 'Seek', { seekPositionTicks: 42 })
    expect(calls.map(c => c.path)).toEqual(['/Sessions/tv-1/Playing/Pause', '/Sessions/tv-1/Playing/Seek?SeekPositionTicks=42'])
    await expect(sessions.command('tv-1', 'SelfDestruct')).rejects.toThrow(/Unsupported/)
  })
})

describe('resolvePlayableItemIds', () => {
  beforeEach(() => {
    db.upsertManyItems([
      { ratingKey: 'series-1', sectionId: 'jf_tv', title: 'The Wire', year: 2002, thumb: null, art: null, type: 'show',
        genres: [], directors: [], cast: [], audienceRating: 0, contentRating: '', addedAt: 0, summary: '',
        rating: 0, ratingImage: '', audienceRatingImage: '', studio: '', source: 'jellyfin' },
    ])
  })

  it('plays movies directly', async () => {
    const calls = mockFetch(() => undefined)
    expect(await sessions.resolvePlayableItemIds('movie-1', 'u1', { type: 'movie' })).toEqual(['movie-1'])
    expect(calls).toHaveLength(0)
  })

  it('uses NextUp for shows and falls back to the first episode', async () => {
    let nextUp = { Items: [{ Id: 'ep-5' }] }
    const calls = mockFetch((pathname) => {
      if (pathname === '/Shows/NextUp') return nextUp
      if (pathname === '/Shows/series-1/Episodes') return { Items: [{ Id: 'ep-1' }] }
      return undefined
    })
    expect(await sessions.resolvePlayableItemIds('series-1', 'u1', { token: 't' })).toEqual(['ep-5'])
    expect(calls[0].path).toBe('/Shows/NextUp?SeriesId=series-1&UserId=u1&Limit=1')
    nextUp = { Items: [] }
    expect(await sessions.resolvePlayableItemIds('series-1', 'u1')).toEqual(['ep-1'])
    expect(calls.at(-1).path).toBe('/Shows/series-1/Episodes?Limit=1&UserId=u1')
  })

  it('returns [] for a show with no episodes', async () => {
    mockFetch(() => ({ Items: [] }))
    expect(await sessions.resolvePlayableItemIds('series-1', 'u1')).toEqual([])
  })
})

describe('playlists.createPlaylistWithItems', () => {
  it('replaces a same-named playlist, resolves shows to one episode, posts the Jellyfin body', async () => {
    db.upsertManyItems([
      { ratingKey: 'series-2', sectionId: 'jf_tv', title: 'Show', year: 2002, thumb: null, art: null, type: 'show',
        genres: [], directors: [], cast: [], audienceRating: 0, contentRating: '', addedAt: 0, summary: '',
        rating: 0, ratingImage: '', audienceRatingImage: '', studio: '', source: 'jellyfin' },
    ])
    const calls = mockFetch((pathname, params, opts) => {
      if (pathname === '/Users/u1/Items' && params.get('IncludeItemTypes') === 'Playlist') {
        return { Items: [{ Id: 'old-pl', Name: 'Diskovarr Wrapped 2026' }, { Id: 'other', Name: 'Other' }] }
      }
      if (pathname === '/Shows/NextUp') return { Items: [] }
      if (pathname === '/Shows/series-2/Episodes') return { Items: [{ Id: 'ep-1' }] }
      if (pathname === '/Playlists' && opts.method === 'POST') return { Id: 'new-pl' }
      return undefined
    })
    const result = await playlists.createPlaylistWithItems('u1', 'Diskovarr Wrapped 2026', ['movie-1', 'series-2', 'movie-1'], { token: 't' })
    expect(result).toEqual({ playlistId: 'new-pl', count: 2 })
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/Items/old-pl')).toBe(true)
    const create = calls.find(c => c.path === '/Playlists')
    expect(create).toMatchObject({ method: 'POST', token: 't', body: { Name: 'Diskovarr Wrapped 2026', Ids: ['movie-1', 'ep-1'], UserId: 'u1', MediaType: 'Video' } })
    expect(playlists.getPlaylistDeepLink('new-pl')).toBe('http://jellyfin.test:8096/web/index.html#!/details?id=new-pl')
  })

  it('throws when nothing resolves', async () => {
    mockFetch(() => ({ Items: [] }))
    await expect(playlists.createPlaylistWithItems('u1', 'x', [])).rejects.toThrow(/No playlist items/)
  })
})
