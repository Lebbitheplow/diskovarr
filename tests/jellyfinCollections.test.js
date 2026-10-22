import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-jf-coll-'))
// No Plex configured → the Plex half of the mirror is skipped, Jellyfin runs alone.
delete process.env.PLEX_URL
delete process.env.PLEX_TOKEN

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const automation = nodeRequire('../server/db/automation.js')
const client = nodeRequire('../server/services/jellyfin/client.js')
const collections = nodeRequire('../server/services/jellyfin/collections.js')
const plexCollections = nodeRequire('../server/services/plexCollections.js')

db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
db.setSetting('jellyfin_api_key', 'admin-key')
db.setSetting('jellyfin_enabled', '1')

const item = (ratingKey, type, tmdbId, source) => ({
  ratingKey, sectionId: source === 'plex' ? '1' : 'jf_x', title: ratingKey, year: 2000, thumb: null, art: null, type,
  genres: [], directors: [], cast: [], audienceRating: 0, contentRating: '', addedAt: 0, summary: '',
  rating: 0, ratingImage: '', audienceRatingImage: '', studio: '', tmdbId, source,
})

function mockFetch(handler) {
  const calls = []
  client.jfFetch = async (p, opts = {}) => {
    calls.push({ path: p, method: opts.method || 'GET' })
    const [pathname, qs = ''] = p.split('?')
    const out = handler(pathname, new URLSearchParams(qs), opts.method || 'GET')
    return out === undefined ? null : out
  }
  return calls
}

beforeEach(() => {
  db.prepare('DELETE FROM library_items').run()
  db.upsertManyItems([
    item('jf-m1', 'movie', '100', 'jellyfin'),
    item('jf-m2', 'movie', '200', 'jellyfin'),
    item('jf-s1', 'show', '300', 'jellyfin'),
    item('55', 'movie', '100', 'plex'), // same tmdb id on Plex — must not leak into the BoxSet
  ])
})

describe('parseCollectionKeys', () => {
  it('round-trips the four-key object and still parses legacy values', () => {
    const keys = { movie: '1', tv: '2', jfMovie: 'a', jfTv: 'b' }
    expect(plexCollections.parseCollectionKeys(JSON.stringify(keys))).toEqual(keys)
    expect(plexCollections.parseCollectionKeys('{"movie":"9"}')).toEqual({ movie: '9' })
    expect(plexCollections.parseCollectionKeys('12345')).toEqual({ movie: '12345' })
    expect(plexCollections.parseCollectionKeys(null)).toEqual({})
  })
})

describe('jellyfin collections', () => {
  it('looks up Jellyfin items by tmdb id only', () => {
    const byType = collections.jellyfinItemsFor([
      { tmdbId: 100, mediaType: 'movie' }, { tmdbId: 300, mediaType: 'tv' }, { tmdbId: 999, mediaType: 'movie' },
    ])
    expect(byType).toEqual({ movie: ['jf-m1'], tv: ['jf-s1'] })
  })

  it('creates BoxSets for a new mixed list and persists jfMovie/jfTv', async () => {
    const calls = mockFetch((pathname, params, method) => {
      if (pathname === '/Collections' && method === 'POST') return { Id: `box-${params.get('Name')}` }
      return undefined
    })
    const listId = automation.createListSource({ name: 'Faves', sourceType: 'imdb', url: 'https://www.imdb.com/chart/top/', mediaType: 'all', collectionEnabled: true })
    const listSource = automation.getListSource(listId)
    const keys = await plexCollections.syncListCollection(listSource, [
      { tmdbId: 100, mediaType: 'movie' }, { tmdbId: 200, mediaType: 'movie' }, { tmdbId: 300, mediaType: 'tv' },
    ])
    expect(keys).toEqual({ jfMovie: 'box-Faves', jfTv: 'box-Faves (TV)' })
    expect(calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([
      '/Collections?Name=Faves&Ids=jf-m1%2Cjf-m2',
      '/Collections?Name=Faves+%28TV%29&Ids=jf-s1',
    ])
    expect(JSON.parse(automation.getListSource(listId).collectionRatingKey)).toEqual(keys)
  })

  it('reconciles an existing BoxSet (add/remove) and drops the key when Jellyfin lost it', async () => {
    const calls = mockFetch((pathname, params, method) => {
      if (pathname === '/Items' && params.get('Ids') === 'box-a') return { Items: [{ Id: 'box-a', Type: 'BoxSet' }] }
      if (pathname === '/Items' && params.get('Ids') === 'box-gone') return { Items: [] }
      if (pathname === '/Items' && params.get('ParentId') === 'box-a') return { Items: [{ Id: 'jf-m1' }, { Id: 'stale' }] }
      if (pathname === '/Collections' && method === 'POST') return { Id: 'box-new' }
      return undefined
    })
    const keys = await collections.syncListBoxSets(
      { name: 'L', mediaType: 'all' },
      [{ tmdbId: 100, mediaType: 'movie' }, { tmdbId: 200, mediaType: 'movie' }],
      { movie: '7', jfMovie: 'box-a', jfTv: 'box-gone' },
    )
    // Plex key untouched; movie BoxSet reconciled; TV BoxSet vanished and has no items → removed
    expect(keys).toEqual({ movie: '7', jfMovie: 'box-a' })
    expect(calls.some(c => c.method === 'POST' && c.path === '/Collections/box-a/Items?Ids=jf-m2')).toBe(true)
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/Collections/box-a/Items?Ids=stale')).toBe(true)
  })

  it('deleteListCollections removes only the Jellyfin BoxSets it owns', async () => {
    const calls = mockFetch(() => null)
    await plexCollections.deleteListCollections({ collectionRatingKey: JSON.stringify({ jfMovie: 'box-1', jfTv: 'box-2' }) })
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual(['DELETE /Items/box-1', 'DELETE /Items/box-2'])
  })
})

// ── Audit 2026-10-17: complete membership reads (JF-06) ──────────────────────

describe('BoxSet membership reads paginate (JF-06)', () => {
  const ids = (from, to) => Array.from({ length: to - from }, (_, i) => ({ Id: `m${from + i}` }))

  it('reads every page, so a stale member past the first 1000 is removed', async () => {
    const members = [...ids(0, 1200), { Id: 'stale' }]
    const calls = mockFetch((pathname, params) => {
      if (pathname === '/Items' && params.get('Ids') === 'box-big') return { Items: [{ Id: 'box-big', Type: 'BoxSet' }] }
      if (pathname === '/Items' && params.get('ParentId') === 'box-big') {
        const start = Number(params.get('StartIndex') || 0)
        const limit = Number(params.get('Limit'))
        return { Items: members.slice(start, start + limit), TotalRecordCount: members.length }
      }
      return undefined
    })
    const wanted = members.filter(m => m.Id !== 'stale').map(m => m.Id)
    expect(await collections.syncTypeBoxSet({ title: 'Big', itemIds: wanted, existingId: 'box-big' })).toBe('box-big')
    // Nothing re-added; only the member past the first page that left the list goes
    expect(calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`))
      .toEqual(['DELETE /Collections/box-big/Items?Ids=stale'])
  })

  it('a failed second page aborts before any membership change', async () => {
    const calls = mockFetch((pathname, params) => {
      if (pathname === '/Items' && params.get('Ids') === 'box-big') return { Items: [{ Id: 'box-big', Type: 'BoxSet' }] }
      if (pathname === '/Items' && params.get('ParentId') === 'box-big') {
        if (Number(params.get('StartIndex') || 0) > 0) throw new Error('Jellyfin API error 500 for /Items')
        return { Items: ids(0, 1000), TotalRecordCount: 1500 }
      }
      return undefined
    })
    await expect(collections.syncTypeBoxSet({ title: 'Big', itemIds: ['m1'], existingId: 'box-big' })).rejects.toThrow(/500/)
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })

  it('a short page while the total says more remain counts as incomplete', async () => {
    const calls = mockFetch((pathname, params) => {
      if (pathname === '/Items' && params.get('Ids') === 'box-big') return { Items: [{ Id: 'box-big', Type: 'BoxSet' }] }
      if (pathname === '/Items' && params.get('ParentId') === 'box-big') return { Items: ids(0, 10), TotalRecordCount: 40 }
      return undefined
    })
    await expect(collections.syncTypeBoxSet({ title: 'Big', itemIds: ['m1'], existingId: 'box-big' })).rejects.toThrow(/incomplete/)
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })
})

// ── Audit 2026-10-17: BoxSet presentation options (JF-12) ────────────────────

describe('BoxSet presentation (JF-12)', () => {
  // One editable DTO per BoxSet; POST /Items/{id} replaces it wholesale.
  function boxServer(dto = {}) {
    const state = {
      dto: { Id: 'box-p', Type: 'BoxSet', Name: 'Picks', Tags: ['keep-me'], Genres: [], ProviderIds: {}, LockedFields: [], LockData: false, DisplayOrder: 'PremiereDate', ...dto },
      posts: [],
    }
    mockFetch((pathname, params, method) => {
      if (pathname === '/Items' && params.get('Ids') === 'box-p') return { Items: [state.dto] }
      if (pathname === '/Items' && params.get('ParentId') === 'box-p') return { Items: [{ Id: 'jf-m1' }] }
      if (pathname === '/Collections' && method === 'POST') return { Id: 'box-p' }
      return undefined
    })
    const inner = client.jfFetch
    client.jfFetch = async (p, opts = {}) => {
      if (opts.method === 'POST' && p === '/Items/box-p') { state.posts.push(opts.body); state.dto = { ...opts.body } }
      return inner(p, opts)
    }
    return state
  }
  const picks = (extra) => ({ name: 'Picks', mediaType: 'movie', ...extra })
  const entries = [{ tmdbId: 100, mediaType: 'movie' }]

  it('writes summary (locked), item order and library order, keeping the rest of the metadata', async () => {
    const state = boxServer()
    const list = picks({ collectionSummary: 'Hand-picked', collectionSort: 'title', libraryOrder: 1 })
    await collections.syncListBoxSets(list, entries, { jfMovie: 'box-p' }, { sortPrefixes: { movie: '!!' } })
    expect(state.posts).toHaveLength(1)
    expect(state.posts[0]).toMatchObject({
      Name: 'Picks', Overview: 'Hand-picked', DisplayOrder: 'SortName', ForcedSortName: '!!Picks', Tags: ['keep-me'],
    })
    expect(state.posts[0].LockedFields).toContain('Overview')

    // Already in step: no second write
    await collections.syncListBoxSets(list, entries, { jfMovie: 'box-p' }, { sortPrefixes: { movie: '!!' } })
    expect(state.posts).toHaveLength(1)
  })

  it('maps list order to insertion order and leaves orders Jellyfin cannot express alone', async () => {
    const state = boxServer()
    await collections.syncListBoxSets(picks({ collectionSort: 'list' }), entries, { jfMovie: 'box-p' })
    expect(state.posts.at(-1)).toMatchObject({ DisplayOrder: 'Default' })
    const before = state.posts.length
    // Descending orders have no BoxSet equivalent (Jellyfin sorts ascending only)
    await collections.syncListBoxSets(picks({ collectionSort: 'rating_desc' }), entries, { jfMovie: 'box-p' })
    expect(state.posts.length).toBe(before)
  })

  it('drops a library-order prefix once the list has no library position', async () => {
    const state = boxServer({ ForcedSortName: '!!!Picks', DisplayOrder: 'Default' })
    await collections.syncListBoxSets(picks({ collectionSort: 'list', libraryOrder: 0 }), entries, { jfMovie: 'box-p' })
    expect(state.posts.at(-1).ForcedSortName).toBeNull()
  })

  it('never filters the shared BoxSet by watched state (unwatched-only is Plex-only)', async () => {
    db.upsertKnownUser('viewer', 'viewer', null, null)
    db.replaceWatchedBatch('viewer', ['jf-m1'], 'jellyfin')
    const calls = mockFetch((pathname, params, method) => {
      if (pathname === '/Collections' && method === 'POST') return { Id: 'box-u' }
      return undefined
    })
    await collections.syncListBoxSets(
      { name: 'Unwatched', mediaType: 'movie', collectionUnwatchedOnly: true },
      [{ tmdbId: 100, mediaType: 'movie' }, { tmdbId: 200, mediaType: 'movie' }], {},
    )
    expect(calls.find(c => c.method === 'POST' && c.path.startsWith('/Collections?')).path)
      .toBe('/Collections?Name=Unwatched&Ids=jf-m1%2Cjf-m2')
  })
})

// ── Audit 2026-10-17: quick sync on Jellyfin (JF-11) ─────────────────────────

describe('collections quick sync without Plex (JF-11)', () => {
  const autoRequest = nodeRequire('../server/services/autoRequest.js')

  it('refreshes Jellyfin BoxSets from the cached list and notices new Jellyfin titles', async () => {
    db.prepare('DELETE FROM list_sources').run()
    const created = []
    mockFetch((pathname, params, method) => {
      if (pathname === '/Collections' && method === 'POST') { created.push(params.get('Ids')); return { Id: 'box-q' } }
      return undefined
    })
    const listId = automation.createListSource({ name: 'Cached', sourceType: 'imdb', url: 'https://www.imdb.com/chart/top/', mediaType: 'movie', collectionEnabled: true })
    automation.upsertListItem({ listId, tmdbId: 100, mediaType: 'movie', title: 'One', status: 'in_library', position: 1 })
    automation.upsertListItem({ listId, tmdbId: 400, mediaType: 'movie', title: 'Later', status: 'requested', position: 2 })
    automation.updateListSource(listId, { lastSyncedAt: Math.floor(Date.now() / 1000) - 60 })

    expect(await autoRequest.runQuickSync({ force: true })).toEqual({ updated: 1, lists: 1 })
    expect(created).toEqual(['jf-m1'])
    expect(JSON.parse(automation.getListSource(listId).collectionRatingKey)).toEqual({ jfMovie: 'box-q' })

    // Nothing new on either server → skipped
    expect(await autoRequest.runQuickSync()).toEqual({ skipped: 'no new library items' })

    // The requested title lands in Jellyfin → the next pass adds it without a source fetch
    db.upsertManyItems([item('jf-m4', 'movie', '400', 'jellyfin')])
    db.prepare("UPDATE library_items SET synced_at = synced_at + 120 WHERE rating_key = 'jf-m4'").run()
    const calls = mockFetch((pathname, params) => {
      if (pathname === '/Items' && params.get('Ids') === 'box-q') return { Items: [{ Id: 'box-q', Type: 'BoxSet' }] }
      if (pathname === '/Items' && params.get('ParentId') === 'box-q') return { Items: [{ Id: 'jf-m1' }] }
      return undefined
    })
    expect(await autoRequest.runQuickSync()).toEqual({ updated: 1, lists: 1 })
    expect(calls.some(c => c.method === 'POST' && c.path === '/Collections/box-q/Items?Ids=jf-m4')).toBe(true)
  })
})
