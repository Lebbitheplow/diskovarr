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
