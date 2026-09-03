import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// library.js pulls in the db; point it at a throwaway directory BEFORE loading
// so tests never touch the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-jf-lib-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const client = nodeRequire('../server/services/jellyfin/client.js')
const library = nodeRequire('../server/services/jellyfin/library.js')

// Enable Jellyfin in the scratch settings table (no network — jfFetch is mocked).
db.setSetting('jellyfin_url', 'http://jellyfin.test:8096')
db.setSetting('jellyfin_api_key', 'test-key')
db.setSetting('jellyfin_enabled', '1')

const FOLDERS = [
  { ItemId: 'folder-movies', Name: 'Movies', CollectionType: 'movies' },
  { ItemId: 'folder-tv', Name: 'TV', CollectionType: 'tvshows' },
  { ItemId: 'folder-music', Name: 'Music', CollectionType: 'music' },
]

function jfItem(overrides = {}) {
  return {
    Id: 'aaaa-1111',
    Name: 'Heat',
    Type: 'Movie',
    ProductionYear: 1995,
    PremiereDate: '1995-12-15T00:00:00.0000000Z',
    DateCreated: '2026-01-02T03:04:05.0000000Z',
    Overview: 'Cops and robbers.',
    OfficialRating: 'R',
    CommunityRating: 8.3,
    CriticRating: 87,
    RunTimeTicks: 170 * 60 * 10_000_000,
    Genres: ['Crime', 'Drama'],
    Tags: ['favorite-director', ' ', ''],
    Studios: [{ Name: 'Warner Bros.' }],
    ProviderIds: { Tmdb: '949', Imdb: 'tt0113277' },
    ProductionLocations: ['USA'],
    ImageTags: { Primary: 'ptag' },
    BackdropImageTags: ['btag'],
    People: [
      { Name: 'Michael Mann', Type: 'Director' },
      { Name: 'Michael Mann', Type: 'Writer' },
      { Name: 'Art Linson', Type: 'Producer' },
      { Name: 'Al Pacino', Type: 'Actor' },
      { Name: 'Robert De Niro', Type: 'Actor' },
    ],
    MediaSources: [{ Size: 4_000_000_000, MediaStreams: [{ Type: 'Video', Width: 1920 }] }],
    ...overrides,
  }
}

// A jfFetch stub that routes by path + query. `calls` records every request.
function mockFetch(handlers) {
  const calls = []
  client.jfFetch = async (p) => {
    calls.push(p)
    const [pathname, qs = ''] = p.split('?')
    const params = new URLSearchParams(qs)
    for (const h of handlers) {
      const out = h(pathname, params)
      if (out !== undefined) return out
    }
    return { Items: [] }
  }
  return calls
}

const foldersHandler = (pathname) => (pathname === '/Library/VirtualFolders' ? FOLDERS : undefined)

describe('parseItem', () => {
  it('maps a BaseItemDto onto the Plex-shaped library item', () => {
    const item = library.parseItem(jfItem())
    expect(item).toMatchObject({
      ratingKey: 'aaaa-1111',
      title: 'Heat',
      year: 1995,
      type: 'movie',
      genres: ['Crime', 'Drama'],
      directors: ['Michael Mann'],
      writers: ['Michael Mann'],
      producers: ['Art Linson'],
      cast: ['Al Pacino', 'Robert De Niro'],
      audienceRating: 8.3,
      rating: 8.7,
      contentRating: 'R',
      studio: 'Warner Bros.',
      tmdbId: '949',
      tvdbId: null,
      countries: ['USA'],
      labels: ['favorite-director'],
      collections: [],
      releaseDate: '1995-12-15',
      duration: 170 * 60 * 1000,
      videoResolution: '1080',
      fileSize: 4_000_000_000,
      source: 'jellyfin',
      leafCount: null,
    })
    expect(item.addedAt).toBe(Math.floor(Date.parse('2026-01-02T03:04:05Z') / 1000))
    expect(item.thumb).toBe('/Items/aaaa-1111/Images/Primary?tag=ptag')
    expect(item.art).toBe('/Items/aaaa-1111/Images/Backdrop/0')
  })

  it('fills collections from the BoxSet map and handles series', () => {
    const collectionsById = new Map([['s-1', ['Marvel', 'MCU Phase 1']]])
    const item = library.parseItem(
      jfItem({ Id: 's-1', Type: 'Series', RecursiveItemCount: 42, MediaSources: undefined, ProviderIds: { Tvdb: '77' } }),
      { collectionsById },
    )
    expect(item.type).toBe('show')
    expect(item.leafCount).toBe(42)
    expect(item.videoResolution).toBeNull()
    expect(item.fileSize).toBeNull()
    expect(item.tmdbId).toBeNull()
    expect(item.tvdbId).toBe('77')
    expect(item.collections).toEqual(['Marvel', 'MCU Phase 1'])
  })

  it('tolerates a sparse dto', () => {
    const item = library.parseItem({ Id: 'x', Type: 'Movie' })
    expect(item).toMatchObject({ ratingKey: 'x', title: '', year: 0, addedAt: 0, thumb: null, art: null, labels: [], producers: [], duration: 0 })
  })
})

describe('getSimilar', () => {
  it('returns one hub in the plex.getRelated shape, Movie/Series only', async () => {
    const calls = mockFetch([
      (pathname) => (pathname === '/Items/seed-1/Similar'
        ? { Items: [
            { Id: 'm-1', Name: 'Collateral', Type: 'Movie', ProductionYear: 2004, ProviderIds: { Tmdb: '1538' } },
            { Id: 's-1', Name: 'Miami Vice', Type: 'Series', ProductionYear: 1984 },
            { Id: 'e-1', Name: 'Pilot', Type: 'Episode' },
          ] }
        : undefined),
    ])
    const hubs = await library.getSimilar('seed-1', 5)
    expect(calls[0]).toBe('/Items/seed-1/Similar?Limit=5&Fields=ProviderIds')
    expect(hubs).toEqual([{
      context: 'hub.jellyfin.similar',
      title: 'Similar',
      items: [
        { ratingKey: 'm-1', tmdbId: '1538', title: 'Collateral', year: 2004, type: 'movie' },
        { ratingKey: 's-1', tmdbId: null, title: 'Miami Vice', year: 1984, type: 'show' },
      ],
    }])
  })

  it('returns [] on errors and empty results', async () => {
    mockFetch([() => { throw new Error('boom') }])
    expect(await library.getSimilar('seed-1')).toEqual([])
    mockFetch([() => ({ Items: [] })])
    expect(await library.getSimilar('seed-1')).toEqual([])
  })
})

describe('upsertItemsByIds', () => {
  beforeEach(() => {
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    // TV folder explicitly disabled; Movies never toggled → enabled by default.
    db.setSyncEnabledSections([{ id: 'jf_folder-tv', enabled: false }])
  })

  it('fetches only enabled folders, keeps Movie/Series in the id list, and stamps details', async () => {
    const calls = mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        if (params.get('ParentId') === 'folder-movies') {
          return { Items: [
            jfItem({ Id: 'aaaa-1111' }),
            jfItem({ Id: 'ep-1', Type: 'Episode', Name: 'Episode' }),      // wrong type
            jfItem({ Id: 'not-asked', Name: 'Not requested' }),           // not in Ids
          ] }
        }
        return { Items: [jfItem({ Id: 'tv-1', Type: 'Series' })] }        // disabled folder
      },
    ])

    const fresh = await library.upsertItemsByIds(['aaaa-1111', 'ep-1', 'tv-1', '', null])
    expect(fresh.map(i => i.ratingKey)).toEqual(['aaaa-1111'])
    expect(fresh[0].sectionId).toBe('jf_folder-movies')

    const itemCalls = calls.filter(c => c.startsWith('/Items?'))
    expect(itemCalls).toHaveLength(1)
    const params = new URLSearchParams(itemCalls[0].split('?')[1])
    expect(params.get('ParentId')).toBe('folder-movies')
    expect(params.get('Ids')).toBe('aaaa-1111,ep-1,tv-1')
    expect(params.get('IncludeItemTypes')).toBe('Movie,Series')
    expect(params.get('Fields')).toContain('Tags')

    const row = db.getLibraryItemByKey('aaaa-1111')
    expect(row.source).toBe('jellyfin')
    expect(row.producers).toEqual(['Art Linson'])
    expect(row.labels).toEqual(['favorite-director'])
    expect(db.getLibraryItemByKey('tv-1')).toBeNull()
    expect(db.getLibraryItemByKey('not-asked')).toBeNull()
    // Jellyfin rows never enter the Plex-only detail backfill.
    expect(db.getItemsNeedingDetailSync(100).map(r => r.ratingKey)).not.toContain('aaaa-1111')
  })

  it('is a no-op without ids or when disabled', async () => {
    const calls = mockFetch([foldersHandler])
    expect(await library.upsertItemsByIds([])).toEqual([])
    expect(await library.upsertItemsByIds(null)).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('pollNewItems watermark', () => {
  it('first tick only sets the watermark; later ticks return items added since', async () => {
    db.setSyncEnabledSections([])
    const future = new Date(Date.now() + 60_000).toISOString()
    const past = new Date(Date.now() - 86_400_000).toISOString()
    const calls = mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        if (params.get('ParentId') === 'folder-movies') {
          return { Items: [jfItem({ Id: 'new-1', DateCreated: future }), jfItem({ Id: 'old-1', DateCreated: past })] }
        }
        return { Items: [] }
      },
    ])
    // Module state: earlier tests never called pollNewItems, so this is the first tick.
    expect(await library.pollNewItems()).toEqual([])
    expect(calls.filter(c => c.startsWith('/Items?'))).toHaveLength(0)

    const fresh = await library.pollNewItems()
    expect(fresh.map(i => i.ratingKey)).toEqual(['new-1'])
    expect(fresh[0].sectionId).toBe('jf_folder-movies')
    const pollCalls = calls.filter(c => c.startsWith('/Items?'))
    expect(pollCalls.length).toBe(2) // movies + tv, music folder ignored
    expect(pollCalls[0]).toContain('SortBy=DateCreated')
    expect(db.getLibraryItemByKey('new-1')?.source).toBe('jellyfin')
    expect(db.getLibraryItemByKey('old-1')).toBeNull()
  })
})

describe('syncLastEpisodeAdded', () => {
  it('stamps each series with its newest episode DateCreated', async () => {
    db.upsertManyItems([
      { ...library.parseItem(jfItem({ Id: 'series-a', Type: 'Series' })), sectionId: 'jf_folder-tv' },
      { ...library.parseItem(jfItem({ Id: 'series-b', Type: 'Series' })), sectionId: 'jf_folder-tv' },
    ], { withDetails: true })
    const calls = mockFetch([
      (pathname, params) => (pathname === '/Items' && params.get('IncludeItemTypes') === 'Episode'
        ? { Items: [
            { Id: 'e3', SeriesId: 'series-a', DateCreated: '2026-03-01T00:00:00Z' },
            { Id: 'e2', SeriesId: 'series-b', DateCreated: '2026-02-01T00:00:00Z' },
            { Id: 'e1', SeriesId: 'series-a', DateCreated: '2026-01-01T00:00:00Z' },
            { Id: 'e0', DateCreated: '2026-01-01T00:00:00Z' },
          ] }
        : undefined),
    ])
    const n = await library.syncLastEpisodeAdded({ id: 'folder-tv', title: 'TV', type: 'show' })
    expect(n).toBe(2)
    expect(calls[0]).toContain('ParentId=folder-tv')
    expect(calls[0]).toContain('Limit=500')
    expect(db.getLibraryItemByKey('series-a').lastEpisodeAddedAt).toBe(Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1000))
    expect(db.getLibraryItemByKey('series-b').lastEpisodeAddedAt).toBe(Math.floor(Date.parse('2026-02-01T00:00:00Z') / 1000))
  })
})

describe('fetchBoxSetMap', () => {
  it('inverts BoxSet children into itemId → [names]', async () => {
    mockFetch([
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        if (params.get('IncludeItemTypes') === 'BoxSet') {
          return { Items: [
            { Id: 'box-1', Name: 'Marvel', ChildCount: 2 },
            { Id: 'box-2', Name: 'Empty', ChildCount: 0 },
            { Id: 'box-3', Name: 'Heat Films', ChildCount: 1 },
          ] }
        }
        if (params.get('ParentId') === 'box-1') return { Items: [{ Id: 'm-1' }, { Id: 'm-2' }] }
        if (params.get('ParentId') === 'box-3') return { Items: [{ Id: 'm-1' }] }
        return undefined
      },
    ])
    const map = await library.fetchBoxSetMap()
    expect(map.get('m-1')).toEqual(['Marvel', 'Heat Films'])
    expect(map.get('m-2')).toEqual(['Marvel'])
    expect(map.has('box-2')).toBe(false)
  })
})

describe('isFolderEnabled', () => {
  it('defaults to enabled unless explicitly disabled', () => {
    db.setSyncEnabledSections([{ id: 'jf_off', enabled: false }, { id: 'jf_on', enabled: true }, { id: '1', enabled: true }])
    expect(library.isFolderEnabled('off')).toBe(false)
    expect(library.isFolderEnabled('on')).toBe(true)
    expect(library.isFolderEnabled('never-toggled')).toBe(true)
  })
})
