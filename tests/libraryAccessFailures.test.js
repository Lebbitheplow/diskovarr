import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createRequire } from 'node:module'
import { setupLibraryAccessFixture, SECTION_ITEMS, shareXml, defaultShares, jfUser, JF_ALL, JF_BLOCK, F2 } from './helpers/libraryAccessFixture.js'

// Per-user library access when checks fail or overlap: what a failed refresh
// keeps or clears (fail closed), filtered sections that hide nothing yet,
// login tokens vs refreshes in flight, and the request middleware's on-demand
// refresh. Same scripted fixture as libraryAccess.test.js.
const { db, libraryAccess, state, seedJellyfinUsers, keysFor, row } = setupLibraryAccessFixture()
const nodeRequire = createRequire(import.meta.url)
const recommender = nodeRequire('../server/services/recommender.js')

beforeAll(async () => {
  seedJellyfinUsers()
  await libraryAccess.refreshAll() // baseline snapshots; adopts '1' as the server owner
})

describe('Plex: failed and overlapping refreshes', () => {
  it('fails closed when a filtered user has no server token', async () => {
    db.prepare("DELETE FROM user_library_access WHERE user_id = '300'").run()
    db.prepare("UPDATE known_users SET plex_token = NULL WHERE user_id = '300'").run()
    try {
      await libraryAccess.refreshUser('300')
      expect(row('300').fetched_at).toBeNull()
      expect(row('300').last_error).toMatch(/sign-in/)
      expect(libraryAccess.forUser('300').plex).toBeNull()
    } finally {
      db.prepare("UPDATE known_users SET plex_token = 'CAROL_PLEX' WHERE user_id = '300'").run()
    }
  })

  it('a failed refresh keeps the last good snapshot and records the error', async () => {
    await libraryAccess.refreshUser('100')
    const before = row('100')
    state.fail = { '/shared_servers': 503 }
    await libraryAccess.refreshUser('100')
    const after = row('100')
    expect(after.fetched_at).toBe(before.fetched_at)
    expect(after.section_ids).toBe(before.section_ids)
    expect(after.last_error).toMatch(/503/)
    expect(libraryAccess.allows(libraryAccess.forUser('100'), { sectionId: '1', ratingKey: '101' })).toBe(true)
  })

  it('a newly added filter whose check fails clears the looser snapshot (fail closed)', async () => {
    await libraryAccess.refreshUser('100')
    expect(libraryAccess.allows(libraryAccess.forUser('100'), { sectionId: '1', ratingKey: '102' })).toBe(true)
    const recSpy = vi.spyOn(recommender, 'invalidateUserCache')
    try {
      state.shares = state.shares.map(s => s.includes('userID="100"')
        ? shareXml('100', { movies: 'contentRating=G', sections: [['1', '1'], ['2', '1'], ['10', '0']] }) : s)
      state.fail = { '/api/v2/resources': 401 } // alice's stored plex.tv token was revoked
      await libraryAccess.refreshUser('100')
      expect(row('100').fetched_at).toBeNull()
      expect(row('100').last_error).toMatch(/401/)
      const alice = libraryAccess.forUser('100')
      expect(alice.plex).toBeNull()
      expect(libraryAccess.allows(alice, { sectionId: '1', ratingKey: '102' })).toBe(false)
      expect(recSpy).toHaveBeenCalledWith('100')
    } finally {
      recSpy.mockRestore()
      state.shares = defaultShares()
      state.fail = {}
      await libraryAccess.refreshUser('100')
    }
  })

  it('a failed check keeps the last snapshot probed under the same filters', async () => {
    await libraryAccess.refreshUser('300')
    const before = row('300')
    state.fail = { '/api/v2/resources': 401 }
    await libraryAccess.refreshUser('300')
    expect(row('300').fetched_at).toBe(before.fetched_at)
    expect(row('300').last_error).toMatch(/401/)
    const carol = libraryAccess.forUser('300')
    expect(libraryAccess.allows(carol, { sectionId: '1', ratingKey: '101' })).toBe(true)
    expect(libraryAccess.allows(carol, { sectionId: '1', ratingKey: '102' })).toBe(false)
  })

  it('a filtered section is listed even when it hides nothing yet: later titles stay hidden', async () => {
    const saved = SECTION_ITEMS.CAROL_SRV[1]
    SECTION_ITEMS.CAROL_SRV[1] = ['101', '102'] // carol's movie filter hides nothing today
    try {
      await libraryAccess.refreshUser('300')
      const carol = libraryAccess.forUser('300')
      expect([...carol.plex.filtered.keys()]).toEqual(['1']) // filterMovies covers movie sections only
      expect(state.calls.some(c => c.path === '/library/sections/1/all' && c.token === 'ADMIN_TOKEN')).toBe(false)
      db.prepare("INSERT INTO library_items (rating_key, section_id, title, year, type, tmdb_id, source) VALUES ('103', '1', 'Movie C', 2020, 'movie', '13', 'plex')").run()
      expect(libraryAccess.allows(carol, { sectionId: '1', ratingKey: '103' })).toBe(false)
      expect(libraryAccess.allows(carol, { sectionId: '1', ratingKey: '102' })).toBe(true)
      expect(libraryAccess.allows(carol, { sectionId: '2', ratingKey: '203' })).toBe(true)
    } finally {
      SECTION_ITEMS.CAROL_SRV[1] = saved
      db.prepare("DELETE FROM library_items WHERE rating_key = '103'").run()
      await libraryAccess.refreshUser('300')
    }
  })

  it('a login token is not dropped by a token-less refresh already running', async () => {
    db.prepare("DELETE FROM user_library_access WHERE user_id = '300'").run()
    db.prepare("UPDATE known_users SET plex_token = NULL WHERE user_id = '300'").run()
    let release
    state.gate = { needle: '/shared_servers', promise: new Promise(resolve => { release = resolve }) }
    try {
      const background = libraryAccess.refreshUser('300') // no token: fails closed on its own
      const login = libraryAccess.refreshOnLogin('300', { serverToken: 'CAROL_SRV' })
      release()
      await Promise.all([background, login])
      expect(state.calls.filter(c => c.path.endsWith('/shared_servers'))).toHaveLength(2)
      expect(row('300').fetched_at).not.toBeNull()
      expect(keysFor(libraryAccess.forUser('300'))).toEqual(['101', '201', '202', '203'])
    } finally {
      db.prepare("UPDATE known_users SET plex_token = 'CAROL_PLEX' WHERE user_id = '300'").run()
    }
  })

  it('the owner\'s sign-in skips the refresh', async () => {
    expect(db.getOwnerUserId()).toBe('1')
    await libraryAccess.refreshOnLogin('1', { serverToken: 'OWNER_SRV' })
    expect(state.calls).toEqual([])
  })
})

describe('Jellyfin: failed refreshes', () => {
  it('a tightened policy whose folder lookup fails hides the newly blocked folder', async () => {
    const jellyfin = nodeRequire('../server/services/jellyfin/client.js')
    const summary = (u) => ({ id: u.Id, policy: jellyfin.policySummary(u.Policy) })
    const id = `jf_${JF_ALL}`
    await libraryAccess.refreshAll()
    expect(keysFor(libraryAccess.forUser(id), 'jellyfin')).toEqual(['aaaa1111', 'bbbb2222'])
    state.fail = { '/Library/VirtualFolders': 500 }
    // Same policy as the stored snapshot: that one stays
    await libraryAccess.refreshUser(`jf_${JF_BLOCK}`)
    expect(row(`jf_${JF_BLOCK}`, 'jellyfin').last_error).toMatch(/500/)
    expect(keysFor(libraryAccess.forUser(`jf_${JF_BLOCK}`), 'jellyfin')).toEqual(['aaaa1111'])
    // F2 newly blocked: the old "every folder" snapshot must not stand in
    state.jfUsers[0] = jfUser(JF_ALL, { BlockedMediaFolders: [F2] })
    await libraryAccess.syncJellyfinPolicies(state.jfUsers.map(summary))
    expect(row(id, 'jellyfin').fetched_at).toBeNull()
    expect(libraryAccess.allows(libraryAccess.forUser(id), { sectionId: `jf_${F2}`, ratingKey: 'bbbb2222', source: 'jellyfin' })).toBe(false)
    expect(keysFor(libraryAccess.forUser(id), 'jellyfin')).toEqual([])
    // The next 15-minute sync retries it
    state.fail = {}
    await libraryAccess.syncJellyfinPolicies(state.jfUsers.map(summary))
    expect(keysFor(libraryAccess.forUser(id), 'jellyfin')).toEqual(['aaaa1111'])
  })
})

describe('request middleware', () => {
  const run = async (id) => {
    const req = { session: { plexUser: { id } } }
    await new Promise(resolve => libraryAccess.middleware(req, {}, resolve))
    return req.libraryAccess
  }

  it('a user without a snapshot gets one bounded on-demand refresh for concurrent requests', async () => {
    db.upsertKnownUser('700', 'newbie', null, 'N')
    const [a, b] = await Promise.all([run('700'), run('700')])
    expect(state.calls.filter(c => c.path.endsWith('/shared_servers'))).toHaveLength(1)
    expect(row('700').role).toBe('removed') // plex.tv answered: no share
    expect(a.plex).toBeNull()
    expect(b.plex).toBeNull()
  })

  it('fails closed while plex.tv is down, retrying at most once per cooldown', async () => {
    db.upsertKnownUser('710', 'unlucky', null, 'U')
    state.fail = { '/shared_servers': 500 }
    const access = await run('710')
    expect(access.plex).toBeNull()
    expect(row('710').fetched_at).toBeNull()
    expect(row('710').last_error).toMatch(/500/)
    state.calls = []
    state.fail = {}
    await run('710')
    expect(state.calls).toEqual([])
  })

  it('only the request that starts an on-demand refresh waits for it', async () => {
    db.upsertKnownUser('730', 'eager', null, 'E2')
    let release
    state.gate = { needle: '/shared_servers', promise: new Promise(resolve => { release = resolve }) }
    let firstDone = false
    const first = run('730').then(a => { firstDone = true; return a })
    const second = await run('730') // the refresh is still running: no access, no wait
    expect(second.plex).toBeNull()
    expect(firstDone).toBe(false)
    release()
    expect((await first).plex).toBeNull()
    expect(row('730').role).toBe('removed')
    expect(state.calls.filter(c => c.path.endsWith('/shared_servers'))).toHaveLength(1)
  })

  it('sets null for the password admin without touching plex.tv', async () => {
    const req = { session: { isAdmin: true, plexUser: { id: '720' } } }
    await new Promise(resolve => libraryAccess.middleware(req, {}, resolve))
    expect(req.libraryAccess).toBeNull()
    expect(state.calls).toEqual([])
  })
})
