import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRequire } from 'node:module'
import { setupLibraryAccessFixture, shareXml, defaultShares, jfUser, JF_ALL, JF_ONE, JF_BLOCK, JF_KID, JF_OFF, F2 } from './helpers/libraryAccessFixture.js'

// Per-user library access (services/libraryAccess): plex.tv sharing and
// Jellyfin policy snapshots, the Access object, DB accessors and the admin
// routes. Every plex.tv / Plex / Jellyfin call is answered by the fixture's
// scripted fetch; the db lives in a throwaway directory. Failure modes and the
// on-demand refresh are in libraryAccessFailures.test.js.
const { db, libraryAccess, plexAccess, state, realFetch, seedJellyfinUsers, keysFor, row } = setupLibraryAccessFixture()
const nodeRequire = createRequire(import.meta.url)
const recommender = nodeRequire('../server/services/recommender.js')
const discoverRecommender = nodeRequire('../server/services/discoverRecommender.js')

describe('Plex snapshots from plex.tv sharing', () => {
  it('maps shared sections by Section.key, detects the owner, and never keeps share tokens', async () => {
    await libraryAccess.refreshAll()
    expect(db.getOwnerUserId()).toBe('1')
    expect(row('1').role).toBe('owner')
    expect(libraryAccess.forUser('1')).toBeNull()

    const alice = libraryAccess.forUser('100')
    expect([...alice.plex.sections].sort()).toEqual(['1', '2'])
    expect(alice.plex.all).toBe(false)
    expect(alice.jellyfin).toBeNull() // unlinked Plex account: no Jellyfin access
    expect([...libraryAccess.forUser('200').plex.sections].sort()).toEqual(['1', '10', '2'])
    expect(libraryAccess.forUser('800').plex.all).toBe(true)

    const stored = JSON.stringify(db.prepare('SELECT * FROM user_library_access').all())
    expect(stored).not.toMatch(/LEAKED_/)
    const parsed = plexAccess.xmlElements(`<MediaContainer>${shareXml('9', { sections: [['1', '1']] })}</MediaContainer>`, 'SharedServer', 'Section')
    expect(parsed[0].attrs.accessToken).toBeUndefined()
    // One batch: shared_servers + users + owner lookup (+ probes for filtered/home users)
    expect(state.calls.filter(c => c.path.endsWith('/shared_servers'))).toHaveLength(1)
    expect(state.calls.filter(c => c.url.startsWith('https://plex.tv')).every(c => c.token === 'ADMIN_TOKEN' || c.path === '/api/v2/resources')).toBe(true)
  })

  it('pending invites and users without a share have no access', async () => {
    await libraryAccess.refreshAll()
    expect(row('400').role).toBe('removed')
    expect(JSON.parse(row('400').filters).pending).toBe(true)
    expect(row('500').role).toBe('removed')
    expect(libraryAccess.forUser('400').plex).toBeNull()
    expect(keysFor(libraryAccess.forUser('500'))).toEqual([])
  })

  it('filtered users are probed with their own server token: partial sections list visible keys', async () => {
    await libraryAccess.refreshAll()
    const carol = libraryAccess.forUser('300')
    expect([...carol.plex.filtered.keys()]).toEqual(['1'])
    expect(libraryAccess.allows(carol, { sectionId: '1', ratingKey: '101' })).toBe(true)
    expect(libraryAccess.allows(carol, { sectionId: '1', ratingKey: '102' })).toBe(false)
    expect(libraryAccess.allows(carol, { section_id: '2', rating_key: '203' })).toBe(true)
    expect(keysFor(carol)).toEqual(['101', '201', '202', '203'])
    expect(state.calls.some(c => c.path === '/api/v2/resources' && c.token === 'CAROL_PLEX')).toBe(true)
    expect(state.calls.some(c => c.path === '/library/sections/1/all' && c.token === 'CAROL_SRV')).toBe(true)
    // A Home member without a share row is asked the server too
    const home = libraryAccess.forUser('600')
    expect(row('600').role).toBe('home')
    expect([...home.plex.sections]).toEqual(['2'])
    expect(home.plex.filtered.size).toBe(0)
  })

  it('a fresh login token skips the plex.tv resources lookup', async () => {
    await libraryAccess.refreshOnLogin('300', { serverToken: 'CAROL_SRV' })
    expect(state.calls.some(c => c.path === '/api/v2/resources')).toBe(false)
    expect(keysFor(libraryAccess.forUser('300'))).toEqual(['101', '201', '202', '203'])
  })

  it('reads attributes after a raw ">" inside a quoted value', () => {
    const [el] = plexAccess.xmlElements(
      '<MediaContainer><SharedServer userID="9" username="A>B" filterMovies="contentRating=G">'
      + `<Section key="1" title='x>y' shared="1"/></SharedServer></MediaContainer>`, 'SharedServer', 'Section')
    expect(el.attrs).toMatchObject({ userID: '9', username: 'A>B', filterMovies: 'contentRating=G' })
    expect(el.children).toEqual([{ key: '1', title: 'x>y', shared: '1' }])
  })

  it('invalidates the user rec/discover caches only when their access changes', async () => {
    await libraryAccess.refreshUser('200')
    const recSpy = vi.spyOn(recommender, 'invalidateUserCache')
    const discoverSpy = vi.spyOn(discoverRecommender, 'invalidateUserCache')
    try {
      await libraryAccess.refreshUser('200')
      expect(recSpy).not.toHaveBeenCalledWith('200')
      const fpBefore = libraryAccess.fingerprint(libraryAccess.forUser('200'))
      state.shares = state.shares.map(s => s.includes('userID="200"') ? shareXml('200', { sections: [['1', '1'], ['2', '1']] }) : s)
      await libraryAccess.refreshUser('200')
      expect(recSpy).toHaveBeenCalledWith('200')
      expect(discoverSpy).toHaveBeenCalledWith('200')
      expect(libraryAccess.fingerprint(libraryAccess.forUser('200'))).not.toBe(fpBefore)
    } finally {
      recSpy.mockRestore()
      discoverSpy.mockRestore()
    }
  })
})

describe('Jellyfin snapshots from user policy', () => {
  beforeAll(() => seedJellyfinUsers())

  it('applies folder access, blocked folders and parental controls', async () => {
    await libraryAccess.refreshAll()
    expect(libraryAccess.forUser(`jf_${JF_ALL}`).jellyfin.all).toBe(true)
    expect(libraryAccess.forUser(`jf_${JF_ALL}`).plex).toBeNull() // unlinked Jellyfin account
    // EnabledFolders arrive dashed/upper-case; sections match the stored rows
    expect(keysFor(libraryAccess.forUser(`jf_${JF_ONE}`), 'jellyfin')).toEqual(['aaaa1111'])
    expect(keysFor(libraryAccess.forUser(`jf_${JF_BLOCK}`), 'jellyfin')).toEqual(['aaaa1111'])
    const kid = libraryAccess.forUser(`jf_${JF_KID}`)
    expect(kid.jellyfin.filtered.size).toBe(2)
    expect(keysFor(kid, 'jellyfin')).toEqual(['aaaa1111'])
    expect(libraryAccess.allows(kid, { sectionId: `jf_${F2}`, ratingKey: 'bbbb2222', source: 'jellyfin' })).toBe(false)
    expect(row(`jf_${JF_OFF}`, 'jellyfin').role).toBe('removed')
    // Parental filtering is Jellyfin's own answer: never scoped by ParentId
    const items = state.calls.filter(c => c.path === '/Items')
    expect(items).toHaveLength(1)
    expect(items[0].url).toContain(`userId=${JF_KID}`)
    expect(items[0].url).not.toMatch(/ParentId/i)
  })

  it('a linked account checks Jellyfin items against the jf_ snapshot', async () => {
    db.linkJellyfinAccount(`jf_${JF_ONE}`, '200')
    try {
      await libraryAccess.refreshUser('200')
      const bob = libraryAccess.forUser('200')
      expect(bob.jellyfin.userId).toBe(`jf_${JF_ONE}`)
      expect(keysFor(bob, 'jellyfin')).toEqual(['aaaa1111'])
      const pool = await libraryAccess.libraryPool(bob)
      expect(pool.map(i => i.ratingKey).sort()).toEqual(['101', '102', '201', '202', '203', 'aaaa1111'])
    } finally {
      db.unlinkJellyfinAccount(`jf_${JF_ONE}`)
      libraryAccess.invalidate()
    }
  })

  it('the 15-minute user sync only re-snapshots changed policies', async () => {
    await libraryAccess.refreshAll()
    const jellyfin = nodeRequire('../server/services/jellyfin/client.js')
    const summary = (u) => ({ id: u.Id, policy: jellyfin.policySummary(u.Policy) })
    state.calls = []
    await libraryAccess.syncJellyfinPolicies(state.jfUsers.map(summary))
    expect(state.calls).toEqual([])
    state.jfUsers[0] = jfUser(JF_ALL, { EnableAllFolders: false, EnabledFolders: [F2] })
    await libraryAccess.syncJellyfinPolicies(state.jfUsers.map(summary))
    expect(keysFor(libraryAccess.forUser(`jf_${JF_ALL}`), 'jellyfin')).toEqual(['bbbb2222'])
  })

})

describe('Access lookups', () => {
  beforeAll(async () => {
    plexAccess.resetBatch()
    state.shares = defaultShares()
    await libraryAccess.refreshAll()
  })

  it('exempts the password admin, the API key, system principals and the owner', () => {
    expect(libraryAccess.forRequest({ session: { isAdmin: true, plexUser: { id: '100' } } })).toBeNull()
    expect(libraryAccess.forRequest({ apiKeyAuth: true, session: { plexUser: { id: 'api-key' } } })).toBeNull()
    expect(libraryAccess.forUser('__svc_1_2__')).toBeNull()
    expect(libraryAccess.forUser('autorequest')).toBeNull()
    expect(libraryAccess.forRequest({ session: { plexUser: { id: '1' } } })).toBeNull()
    expect(libraryAccess.forRequest({ session: {} })).toBe(libraryAccess.NO_ACCESS)
    // Diskovarr admins are limited like everyone else in user-facing views
    db.setUserAdmin('100', true)
    try {
      libraryAccess.invalidate()
      expect(libraryAccess.forRequest({ session: { plexUser: { id: '100' }, isPlexAdminUser: true } })).not.toBeNull()
    } finally { db.setUserAdmin('100', false) }
  })

  it('the kill switch lifts every restriction', () => {
    libraryAccess.setEnforced(false)
    expect(libraryAccess.forUser('500')).toBeNull()
    expect(libraryAccess.forRequest({ session: { plexUser: { id: '100' } } })).toBeNull()
    libraryAccess.setEnforced(true)
    expect(libraryAccess.forUser('100')).not.toBeNull()
  })

  it('DB accessors take an optional access and prefer an allowed row', () => {
    const alice = libraryAccess.forUser('100')
    const bob = libraryAccess.forUser('200')
    expect(keysFor(alice)).toEqual(['101', '102', '201', '202', '203'])
    expect(keysFor(null)).toHaveLength(7) // plain call: unchanged
    expect(db.getLibraryTmdbKeys(null, alice).has('31:tv')).toBe(false)
    expect(db.getLibraryTmdbKeys(null, bob).has('31:tv')).toBe(true)
    expect(db.getLibraryTmdbKeys().has('31:tv')).toBe(true)
    expect([...db.getLibraryTitleYearSet('plex', alice)].some(k => k.startsWith('tube a'))).toBe(false)
    expect(db.getLibraryItemByTmdbId(99, 'tv', null, alice).rating_key).toBe('203')
    expect(db.getLibraryItemByTmdbId(31, 'tv', null, alice)).toBeNull()
    expect(db.getLibraryItemByKeyFor('1001', alice)).toBeNull()
    expect(db.getLibraryItemByKeyFor('1001', bob).sectionId).toBe('10')
    expect(db.getLibraryItemByKeyFor('1001', null).ratingKey).toBe('1001')
    // Only section 10: the duplicate there is the one returned
    libraryAccess.saveSnapshot('900', 'plex', { role: 'shared', sectionIds: ['10'] })
    libraryAccess.invalidate()
    expect(db.getLibraryItemByTmdbId(99, 'tv', 'plex', libraryAccess.forUser('900')).rating_key).toBe('1002')
  })

  it('allowsKey/allowsPoster pass ids that are not library rows', () => {
    const alice = libraryAccess.forUser('100')
    expect(libraryAccess.allowsKey(alice, '1001')).toBe(false)
    expect(libraryAccess.allowsKey(alice, '555555')).toBe(true) // e.g. an episode
    expect(libraryAccess.allowsPoster(alice, '/library/metadata/1001/thumb/123')).toBe(false)
    expect(libraryAccess.allowsPoster(alice, '/library/metadata/101/thumb/123')).toBe(true)
    expect(libraryAccess.allowsPoster(alice, '/library/collections/1001/composite/1')).toBe(true)
    expect(libraryAccess.allowsPoster(alice, '/Items/aaaa1111/Images/Primary')).toBe(false)
    expect(libraryAccess.filter(alice, [{ sectionId: '1', ratingKey: '101' }, { sectionId: '10', ratingKey: '1001' }]))
      .toEqual([{ sectionId: '1', ratingKey: '101' }])
  })

  it('an undefined access (a router without the middleware) sees nothing', async () => {
    const movieA = { sectionId: '1', ratingKey: '101' }
    expect(libraryAccess.allows(null, movieA)).toBe(true)
    expect(libraryAccess.allows(undefined, movieA)).toBe(false)
    expect(libraryAccess.allowsKey(undefined, '101')).toBe(false)
    expect(libraryAccess.allowsPoster(undefined, '/library/metadata/101/thumb/1')).toBe(false)
    expect(libraryAccess.filter(undefined, [movieA])).toEqual([])
    expect(libraryAccess.fingerprint(undefined)).toBe('none')
    expect(await libraryAccess.libraryPool(undefined)).toEqual([])
    expect(libraryAccess.sqlPredicate(undefined).sql).toBe('0=1')
    expect(db.getLibraryItemByKeyFor('101', undefined)).toBeNull()
  })

  it('fingerprints are stable per access and differ between users', () => {
    const a1 = libraryAccess.fingerprint(libraryAccess.forUser('100'))
    libraryAccess.invalidate()
    expect(libraryAccess.fingerprint(libraryAccess.forUser('100'))).toBe(a1)
    expect(libraryAccess.fingerprint(libraryAccess.forUser('200'))).not.toBe(a1)
    expect(libraryAccess.fingerprint(null)).toBe('all')
  })
})

describe('admin routes', () => {
  let server, base
  beforeAll(async () => {
    const express = nodeRequire('../server/node_modules/express')
    const admin = nodeRequire('../server/routes/admin.js')
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => { req.session = { isAdmin: true }; next() })
    app.use('/admin', admin)
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${server.address().port}`
    plexAccess.resetBatch()
    await libraryAccess.refreshAll()
  })
  afterAll(() => new Promise(resolve => server.close(resolve)))
  const call = async (method, route, body) => {
    const res = await realFetch(base + route, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }

  it('lists each user\'s sections with titles and no tokens', async () => {
    const { status, data } = await call('GET', '/admin/library-access')
    expect(status).toBe(200)
    expect(data.enforced).toBe(true)
    expect(data.ownerId).toBe('1')
    const alice = data.users.find(u => u.userId === '100')
    expect(alice.snapshots[0]).toMatchObject({ source: 'plex', role: 'shared', sections: [{ id: '1', title: 'S1' }, { id: '2', title: 'S2' }] })
    const carol = data.users.find(u => u.userId === '300')
    expect(carol.snapshots[0].filteredSections).toEqual([{ id: '1', title: 'S1' }])
    expect(data.users.find(u => u.userId === '1').owner).toBe(true)
    expect(data.users.some(u => u.userId.startsWith('__'))).toBe(false)
    expect(JSON.stringify(data)).not.toMatch(/ADMIN_TOKEN|CAROL_PLEX|CAROL_SRV|LEAKED_|JF_KEY/)
  })

  it('saves the kill switch and refreshes on demand', async () => {
    expect((await call('POST', '/admin/library-access/settings', { enforced: 'no' })).status).toBe(400)
    expect((await call('POST', '/admin/library-access/settings', { enforced: false })).data.enforced).toBe(false)
    expect(db.getSetting('library_access_enforced')).toBe('0')
    expect(libraryAccess.forUser('500')).toBeNull()
    await call('POST', '/admin/library-access/settings', { enforced: true })
    state.calls = []
    const { status, data } = await call('POST', '/admin/library-access/refresh')
    expect(status).toBe(200)
    expect(data.lastRefresh.users).toBeGreaterThan(0)
    expect(state.calls.filter(c => c.path.endsWith('/shared_servers'))).toHaveLength(1)
  })
})
