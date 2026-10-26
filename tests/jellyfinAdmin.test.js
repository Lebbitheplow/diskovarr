import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createRequestHarness } from './helpers/requestApp.js'

// Jellyfin-only installs: the admin library controls, the manual sync and an
// unrestricted (owner) search must never need Plex — with no Plex URL every
// Plex fetch would go to "undefined/..." — and a configured-but-down Plex must
// not stop the Jellyfin side (audit 2026-10-17 JF-01). Also the post-save sync
// path (JF-17) and the admin watched-sync timestamps (JF-24).
delete process.env.PLEX_URL
delete process.env.PLEX_TOKEN

const h = createRequestHarness()
const { db, plex, nodeRequire } = h
const jellyfin = nodeRequire('../../server/services/jellyfin/index.js')
const jfSocket = nodeRequire('../../server/services/jellyfin/socket.js')
const libraryAccess = nodeRequire('../../server/services/libraryAccess/index.js')

const JF = 'http://jf.test'
const FOLDERS = [
  { ItemId: 'fm', Name: 'Movies', CollectionType: 'movies' },
  { ItemId: 'fx', Name: 'Everything', CollectionType: null },
]

function jellyfinOnly() {
  db.setSetting('plex_url', '')
  db.setSetting('plex_token', '')
  db.setSetting('jellyfin_url', JF)
  db.setSetting('jellyfin_api_key', 'k')
  db.setSetting('jellyfin_enabled', '1')
  db.setSyncEnabledSections([])
}

// Jellyfin answers; a configured Plex at plex.down is unreachable.
function respond({ jfDown = false } = {}) {
  h.setResponder((url) => {
    // what real fetch does with a Plex URL built from an unset setting
    if (!/^https?:\/\//.test(url)) throw new TypeError(`Failed to parse URL from ${url}`)
    if (url.startsWith(JF)) {
      if (jfDown) return new Response('down', { status: 503 })
      if (url.startsWith(`${JF}/Library/VirtualFolders`)) return Response.json(FOLDERS)
      return Response.json({ Items: [] })
    }
    if (url.startsWith('http://plex.down')) return new Response('down', { status: 503 })
    return Response.json({})
  })
}

const plexOutbound = () => h.outbound.filter(o => !o.url.startsWith(JF))

async function waitForSyncIdle() {
  await vi.waitFor(async () => {
    const { data } = await h.call('GET', '/admin/status', { role: 'panel' })
    expect(data.syncInProgress).toBe(false)
  }, { timeout: 3000 })
  return (await h.call('GET', '/admin/status', { role: 'panel' })).data
}

beforeAll(async () => { await h.start() })
afterAll(() => h.stop())
beforeEach(() => {
  h.reset()
  plex.invalidateCache() // no Plex section left in memory from an earlier test
  jellyfinOnly()
  respond()
})
afterEach(() => vi.restoreAllMocks())

describe('Jellyfin-only admin library controls (JF-01)', () => {
  it('lists Jellyfin folders without any Plex fetch', async () => {
    const res = await h.call('GET', '/admin/sync/libraries', { role: 'panel' })
    expect(res.status).toBe(200)
    expect(res.data.sections.map(s => [s.id, s.type, s.source, s.enabled])).toEqual([
      ['jf_fm', 'movie', 'jellyfin', true],
      ['jf_fx', 'mixed', 'jellyfin', true],
    ])
    expect(res.data.errors).toEqual({})
    expect(plexOutbound()).toEqual([])
  })

  it('still lists Jellyfin when a configured Plex is down, reporting the Plex error', async () => {
    db.setSetting('plex_url', 'http://plex.down')
    db.setSetting('plex_token', 't')
    const res = await h.call('GET', '/admin/sync/libraries', { role: 'panel' })
    expect(res.status).toBe(200)
    expect(res.data.sections.map(s => s.id)).toEqual(['jf_fm', 'jf_fx'])
    expect(res.data.errors.plex).toMatch(/503/)
  })

  it('is a 500 only when every configured server fails', async () => {
    db.setSetting('plex_url', 'http://plex.down')
    db.setSetting('plex_token', 't')
    respond({ jfDown: true })
    const res = await h.call('GET', '/admin/sync/libraries', { role: 'panel' })
    expect(res.status).toBe(500)
    expect(Object.keys(res.data.errors).sort()).toEqual(['jellyfin', 'plex'])
  })

  it('manual sync resyncs Jellyfin without touching Plex', async () => {
    const resync = vi.spyOn(jellyfin, 'resyncAll').mockResolvedValue()
    const warm = vi.spyOn(plex, 'warmCache')
    const res = await h.call('POST', '/admin/sync/library', { role: 'panel' })
    expect(res.data.success).toBe(true)
    const status = await waitForSyncIdle()
    expect(resync).toHaveBeenCalledTimes(1)
    expect(warm).not.toHaveBeenCalled()
    expect(status.lastSyncError).toBeNull()
    expect(plexOutbound()).toEqual([])
  })

  it('a failing Plex sync no longer skips the Jellyfin resync, and both outcomes are reported', async () => {
    db.setSetting('plex_url', 'http://plex.down')
    db.setSetting('plex_token', 't')
    const resync = vi.spyOn(jellyfin, 'resyncAll').mockResolvedValue()
    vi.spyOn(plex, 'warmCache').mockRejectedValue(new Error('Plex API error 503'))
    await h.call('POST', '/admin/sync/library', { role: 'panel' })
    const status = await waitForSyncIdle()
    expect(resync).toHaveBeenCalledTimes(1)
    expect(status.lastSyncError).toBe('Plex: Plex API error 503')
  })

  it('an unrestricted library pool skips Plex when it is not configured', async () => {
    db.prepare("INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id, source) VALUES ('jf-heat', 'jf_fm', 'Heat', 'movie', '949', 'jellyfin')").run()
    const pool = await libraryAccess.libraryPool(null)
    expect(pool.map(i => i.ratingKey)).toEqual(['jf-heat'])
    expect(plexOutbound()).toEqual([])
  })

  it('owner library search works on a Jellyfin-only install', async () => {
    db.setSetting('discover_enabled', '0') // library-only search path
    db.prepare("INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id, source) VALUES ('jf-heat', 'jf_fm', 'Heat', 'movie', '949', 'jellyfin')").run()
    const res = await h.call('GET', '/api/search?q=heat', { role: 'panel' })
    expect(res.status).toBe(200)
    expect(res.data.results.map(r => r.ratingKey)).toContain('jf-heat')
    expect(plexOutbound()).toEqual([])
  })
})

describe('connection save (JF-17)', () => {
  it('runs the library + user sync whose tail drops the recommendation caches', async () => {
    vi.spyOn(jfSocket, 'sync').mockImplementation(() => {})
    const full = vi.spyOn(jellyfin, 'syncLibraryAndUsers').mockResolvedValue(0)
    const res = await h.call('POST', '/admin/connections/save', { role: 'panel', body: { jellyfin_url: JF, jellyfin_api_key: 'k', jellyfin_enabled: true } })
    expect(res.data.success).toBe(true)
    expect(full).toHaveBeenCalledTimes(1)
  })
})

describe('admin watched-sync timestamps (JF-24)', () => {
  beforeEach(() => {
    db.prepare("DELETE FROM known_users WHERE user_id IN ('jf_aaa', 'jf_bbb', 'p-linked', 'p-plain', 'p-never')").run()
    db.prepare("DELETE FROM sync_log WHERE key LIKE '%watched_%'").run()
  })

  const stamp = (key, ts) => db.prepare('INSERT OR REPLACE INTO sync_log (key, last_sync) VALUES (?, ?)').run(key, ts)
  const statFor = (id) => db.getAdminStats().users.find(u => u.user_id === id)

  it('reports Jellyfin syncs (zero items included), linked accounts, Plex syncs and never-synced users', () => {
    db.seedJellyfinUser('jf_aaa', 'standalone', null)
    db.seedJellyfinUser('jf_bbb', 'linked-jf', null)
    db.upsertKnownUser('p-linked', 'plexy', null, null)
    db.upsertKnownUser('p-plain', 'plain', null, null)
    db.upsertKnownUser('p-never', 'never', null, null)
    db.prepare("UPDATE known_users SET linked_user_id = 'p-linked' WHERE user_id = 'jf_bbb'").run()
    stamp('jf_watched_aaa', 1_700_000_100) // successful sync, no watched rows
    stamp('jf_watched_bbb', 1_700_000_200)
    stamp('watched_p-linked', 1_700_000_050)
    stamp('watched_p-plain', 1_700_000_300)

    expect(statFor('jf_aaa')).toMatchObject({ last_sync: 1_700_000_100, watched_count: 0 })
    expect(statFor('jf_bbb').last_sync).toBe(1_700_000_200)
    expect(statFor('p-linked').last_sync).toBe(1_700_000_200) // newest of its Plex and linked Jellyfin syncs
    expect(statFor('p-plain').last_sync).toBe(1_700_000_300)
    expect(statFor('p-never').last_sync).toBe(0)
  })
})

describe('Jellyfin browser URL settings', () => {
  it('saves the external URL separately from the API address', async () => {
    const externalUrl = 'https://media.example.test:8096'
    const saved = await h.call('POST', '/admin/connections/save', {
      role: 'panel', body: { jellyfin_external_url: externalUrl },
    })
    expect(saved.status).toBe(200)
    const settings = await h.call('GET', '/admin/connections/settings', { role: 'panel' })
    expect(settings.data.jellyfin_url).toBe(JF)
    expect(settings.data.jellyfin_external_url).toBe(externalUrl)
    expect(jellyfin.getDeepLink('movie-id')).toBe(`${externalUrl}/web/index.html#!/details?id=movie-id`)
  })
})
