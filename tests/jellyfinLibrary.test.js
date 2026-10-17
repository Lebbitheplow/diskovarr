import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
const fulfillment = nodeRequire('../server/services/requestFulfillment.js')

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
      collections: null, // no BoxSet map → membership unknown, the upsert keeps stored names
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

  it('fetches only enabled folders, keeps requested Movie/Series, and stamps details', async () => {
    const calls = mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        if (params.get('ParentId') === 'folder-movies') {
          return { Items: [
            jfItem({ Id: 'aaaa-1111' }),
            jfItem({ Id: 'ep-1', Type: 'Episode', Name: 'Episode' }),      // episode without a series
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
    expect(params.get('IncludeItemTypes')).toBe('Movie,Series,Season,Episode')
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

// ── Audit 2026-10-17 regressions ─────────────────────────────────────────────

// Module state (folder cache, poll watermark) belongs to one server URL, so a
// fresh URL gives each test a clean slate — and exercises that reset (JF-20).
let urlGen = 0
function freshConnection() {
  db.setSetting('jellyfin_url', `http://jellyfin-${++urlGen}.test:8096`)
}

// /Items stub honouring StartIndex/Limit over a fixed list.
function paged(list, params) {
  const start = Number(params.get('StartIndex') || 0)
  const limit = Number(params.get('Limit') || list.length)
  return { Items: list.slice(start, start + limit), TotalRecordCount: list.length }
}

describe('episode and season events resolve to their series (JF-05)', () => {
  let fulfilled
  beforeEach(() => {
    freshConnection()
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    db.setSyncEnabledSections([])
    fulfilled = vi.spyOn(fulfillment, 'checkAndNotifyFulfilled').mockReturnValue(0)
  })
  afterEach(() => vi.restoreAllMocks())

  it('an episode-only import refreshes the existing show, stamps the episode date and runs fulfillment', async () => {
    db.upsertManyItems([{ ...library.parseItem(jfItem({ Id: 'show-1', Type: 'Series', RecursiveItemCount: 10, ProviderIds: { Tmdb: '1399' } })), sectionId: 'jf_folder-tv' }], { withDetails: true })
    db.updateLastEpisodeAdded('show-1', 1000)
    const epDate = '2026-10-01T12:00:00Z'
    const calls = mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items' || params.get('ParentId') !== 'folder-tv') return undefined
        if (params.get('IncludeItemTypes') === 'Series') {
          return { Items: [jfItem({ Id: 'show-1', Type: 'Series', RecursiveItemCount: 12, ProviderIds: { Tmdb: '1399' } })] }
        }
        return { Items: [
          { Id: 'ep-11', Type: 'Episode', SeriesId: 'show-1', DateCreated: epDate },
          { Id: 'ep-12', Type: 'Episode', SeriesId: 'show-1', DateCreated: '2026-09-30T12:00:00Z' },
          { Id: 'season-2', Type: 'Season', SeriesId: 'show-1' },
        ] }
      },
    ])
    const fresh = await library.upsertItemsByIds(['ep-11', 'ep-12', 'season-2'])
    expect(fresh.map(i => i.ratingKey)).toEqual(['show-1'])
    const row = db.getLibraryItemByKey('show-1')
    expect(row.leafCount).toBe(12)
    expect(row.lastEpisodeAddedAt).toBe(Math.floor(Date.parse(epDate) / 1000))
    expect(fulfilled).toHaveBeenCalledTimes(1)
    // the first query asked for episodes and seasons too
    const first = new URLSearchParams(calls.find(c => c.includes('ParentId=folder-tv')).split('?')[1])
    expect(first.get('IncludeItemTypes')).toBe('Movie,Series,Season,Episode')
  })

  it('never moves the last-episode-added date backwards', async () => {
    db.upsertManyItems([{ ...library.parseItem(jfItem({ Id: 'show-2', Type: 'Series' })), sectionId: 'jf_folder-tv' }], { withDetails: true })
    db.updateLastEpisodeAdded('show-2', 2_000_000_000)
    mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items' || params.get('ParentId') !== 'folder-tv') return undefined
        if (params.get('IncludeItemTypes') === 'Series') return { Items: [jfItem({ Id: 'show-2', Type: 'Series' })] }
        return { Items: [{ Id: 'old-ep', Type: 'Episode', SeriesId: 'show-2', DateCreated: '2020-01-01T00:00:00Z' }] }
      },
    ])
    await library.upsertItemsByIds(['old-ep'])
    expect(db.getLibraryItemByKey('show-2').lastEpisodeAddedAt).toBe(2_000_000_000)
  })

  it('fetches a large id batch in chunks per folder', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `m-${i}`)
    const calls = mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items' || params.get('ParentId') !== 'folder-movies') return undefined
        return { Items: params.get('Ids').split(',').map(id => jfItem({ Id: id, ProviderIds: {} })) }
      },
    ])
    const fresh = await library.upsertItemsByIds(ids)
    expect(fresh).toHaveLength(120)
    const movieCalls = calls.filter(c => c.includes('ParentId=folder-movies'))
    expect(movieCalls).toHaveLength(3) // 50 + 50 + 20
    expect(movieCalls.every(c => new URLSearchParams(c.split('?')[1]).get('Ids').split(',').length <= 50)).toBe(true)
  })
})

describe('ItemsUpdated refresh (JF-05)', () => {
  beforeEach(() => {
    freshConnection()
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    db.setSyncEnabledSections([])
  })
  afterEach(() => vi.restoreAllMocks())

  it('refreshes known rows only and reports the ones that just gained a TMDB id', async () => {
    const fulfilled = vi.spyOn(fulfillment, 'checkAndNotifyFulfilled').mockReturnValue(0)
    db.upsertManyItems([
      { ...library.parseItem(jfItem({ Id: 'late', ProviderIds: {} })), sectionId: 'jf_folder-movies' },
      { ...library.parseItem(jfItem({ Id: 'known', ProviderIds: { Tmdb: '5' } })), sectionId: 'jf_folder-movies' },
    ], { withDetails: true })
    const calls = mockFetch([
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        return { Items: params.get('Ids').split(',').map(id => jfItem({ Id: id, Name: `${id} v2`, ProviderIds: { Tmdb: id === 'late' ? '777' : '5' } })) }
      },
    ])
    const identified = await library.refreshKnownItems(['late', 'known', 'never-seen'])
    expect(identified.map(i => i.ratingKey)).toEqual(['late'])
    expect(db.getLibraryItemByKey('late').tmdbId).toBe('777')
    expect(db.getLibraryItemByKey('known').title).toBe('known v2')
    expect(db.getLibraryItemByKey('never-seen')).toBeNull()
    const params = new URLSearchParams(calls[0].split('?')[1])
    expect(params.get('ParentId')).toBe('folder-movies')
    expect(params.get('Ids').split(',').sort()).toEqual(['known', 'late'])
    expect(fulfilled).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for ids that are not library rows', async () => {
    const calls = mockFetch([])
    expect(await library.refreshKnownItems(['ep-x', 'season-y'])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('fallback poll (JF-15)', () => {
  const T0 = Date.parse('2026-10-17T10:00:00Z')
  beforeEach(() => {
    freshConnection()
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    db.setSyncEnabledSections([])
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('a failed tick keeps the watermark, so the retry still finds what it missed', async () => {
    const created = new Date(T0 + 100_000).toISOString()
    let failTv = false
    const calls = mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        if (params.get('ParentId') === 'folder-tv') {
          if (failTv) throw new Error('Jellyfin API error 500 for /Items')
          return { Items: [jfItem({ Id: 'show-new', Type: 'Series', DateCreated: created })] }
        }
        return { Items: [] }
      },
    ])
    expect(await library.pollNewItems()).toEqual([]) // watermark = T0
    failTv = true
    vi.setSystemTime(T0 + 1_000_000)
    expect(await library.pollNewItems()).toEqual([])
    failTv = false
    vi.setSystemTime(T0 + 2_000_000)
    const fresh = await library.pollNewItems()
    expect(fresh.map(i => i.ratingKey)).toEqual(['show-new'])
    // the failure dropped the folder cache, so the folder list was re-read
    expect(calls.filter(c => c === '/Library/VirtualFolders')).toHaveLength(2)
  })

  it('pages past the first 100 new items in a burst and ignores rows already stored', async () => {
    const burst = Array.from({ length: 150 }, (_, i) => jfItem({ Id: `b-${i}`, DateCreated: new Date(T0 + 60_000 - i * 1000).toISOString(), ProviderIds: {} }))
    mockFetch([
      foldersHandler,
      (pathname, params) => (pathname === '/Items' && params.get('ParentId') === 'folder-movies' ? paged(burst, params) : undefined),
    ])
    await library.pollNewItems()
    vi.setSystemTime(T0 + 120_000)
    const fresh = await library.pollNewItems()
    expect(fresh).toHaveLength(150)
    // the overlap re-reads the same window; stored rows aren't fresh twice
    vi.setSystemTime(T0 + 180_000)
    expect(await library.pollNewItems()).toEqual([])
  })

  it('includes an item created on the watermark second (ties)', async () => {
    mockFetch([
      foldersHandler,
      (pathname, params) => (pathname === '/Items' && params.get('ParentId') === 'folder-movies'
        ? { Items: [jfItem({ Id: 'tie', DateCreated: new Date(T0).toISOString(), ProviderIds: {} })] }
        : undefined),
    ])
    await library.pollNewItems()
    vi.setSystemTime(T0 + 60_000)
    expect((await library.pollNewItems()).map(i => i.ratingKey)).toEqual(['tie'])
  })
})

describe('collection names survive incremental updates (JF-16)', () => {
  beforeEach(() => {
    freshConnection()
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    db.setSyncEnabledSections([])
  })
  afterEach(() => vi.restoreAllMocks())

  const seed = () => db.upsertManyItems([{
    ...library.parseItem(jfItem({ Id: 'boxed' }), { collectionsById: new Map([['boxed', ['Actual BoxSet']]]) }),
    sectionId: 'jf_folder-movies',
  }], { withDetails: true })

  it('a by-id update keeps the stored BoxSet names', async () => {
    seed()
    mockFetch([foldersHandler, (pathname, params) => (pathname === '/Items' && params.get('ParentId') === 'folder-movies' ? { Items: [jfItem({ Id: 'boxed', Name: 'Heat (4K)' })] } : undefined)])
    await library.upsertItemsByIds(['boxed'])
    const row = db.getLibraryItemByKey('boxed')
    expect(row.title).toBe('Heat (4K)')
    expect(row.collections).toEqual(['Actual BoxSet'])
  })

  it('a full resync with a failed BoxSet lookup keeps them; a successful one propagates removal', async () => {
    vi.spyOn(fulfillment, 'checkAndNotifyFulfilled').mockReturnValue(0)
    seed()
    let boxSetsFail = true
    mockFetch([
      foldersHandler,
      (pathname, params) => {
        if (pathname !== '/Items') return undefined
        if (params.get('IncludeItemTypes') === 'BoxSet') {
          if (boxSetsFail) throw new Error('Jellyfin API error 500 for /Items')
          return { Items: [] }
        }
        if (params.get('ParentId') === 'folder-movies' && params.get('IncludeItemTypes') === 'Movie,Series') return { Items: [jfItem({ Id: 'boxed' })] }
        return { Items: [] }
      },
    ])
    await library.resyncAll()
    expect(db.getLibraryItemByKey('boxed').collections).toEqual(['Actual BoxSet'])
    boxSetsFail = false
    await library.resyncAll()
    expect(db.getLibraryItemByKey('boxed').collections).toEqual([])
  })
})

describe('fetchBoxSetMap pagination (JF-06)', () => {
  it('reads every page of BoxSet children', async () => {
    const children = Array.from({ length: 1500 }, (_, i) => ({ Id: `c-${i}` }))
    mockFetch([(pathname, params) => {
      if (pathname !== '/Items') return undefined
      if (params.get('IncludeItemTypes') === 'BoxSet') return { Items: [{ Id: 'big', Name: 'Big Box', ChildCount: 1500 }] }
      if (params.get('ParentId') === 'big') return paged(children, params)
      return undefined
    }])
    const map = await library.fetchBoxSetMap()
    expect(map.size).toBe(1500)
    expect(map.get('c-1499')).toEqual(['Big Box'])
  })

  it('throws when a later page fails, rather than returning a partial map', async () => {
    const children = Array.from({ length: 1500 }, (_, i) => ({ Id: `c-${i}` }))
    mockFetch([(pathname, params) => {
      if (pathname !== '/Items') return undefined
      if (params.get('IncludeItemTypes') === 'BoxSet') return { Items: [{ Id: 'big', Name: 'Big Box', ChildCount: 1500 }] }
      if (params.get('ParentId') === 'big') {
        if (Number(params.get('StartIndex')) > 0) throw new Error('Jellyfin API error 502 for /Items')
        return paged(children, params)
      }
      return undefined
    }])
    await expect(library.fetchBoxSetMap()).rejects.toThrow('502')
  })
})

describe('folder lifecycle (JF-20) and mixed libraries (JF-21)', () => {
  let folders
  beforeEach(() => {
    freshConnection()
    db.prepare("DELETE FROM library_items WHERE source = 'jellyfin'").run()
    db.setSyncEnabledSections([])
    vi.spyOn(fulfillment, 'checkAndNotifyFulfilled').mockReturnValue(0)
    folders = [
      { ItemId: 'folder-movies', Name: 'Movies', CollectionType: 'movies' },
      { ItemId: 'folder-gone', Name: 'Old', CollectionType: 'movies' },
    ]
  })
  afterEach(() => vi.restoreAllMocks())

  const stub = () => mockFetch([
    (pathname) => {
      if (pathname !== '/Library/VirtualFolders') return undefined
      if (folders instanceof Error) throw folders
      return folders
    },
    (pathname, params) => {
      if (pathname !== '/Items') return undefined
      if (params.get('IncludeItemTypes') !== 'Movie,Series') return { Items: [] }
      return { Items: [jfItem({ Id: `in-${params.get('ParentId')}`, ProviderIds: {} })] }
    },
  ])

  it('retires the rows of a folder the server no longer has, but never on a failed or empty list', async () => {
    const calls = stub()
    await library.resyncAll()
    expect(db.getLibraryItemByKey('in-folder-gone')?.sectionId).toBe('jf_folder-gone')

    folders = new Error('Jellyfin API error 503 for /Library/VirtualFolders')
    await expect(library.resyncAll()).rejects.toThrow('503')
    expect(db.getLibraryItemByKey('in-folder-gone')).not.toBeNull()

    folders = []
    await library.resyncAll()
    expect(db.getLibraryItemByKey('in-folder-gone')).not.toBeNull()

    folders = [{ ItemId: 'folder-movies', Name: 'Movies', CollectionType: 'movies' }]
    await library.resyncAll()
    expect(db.getLibraryItemByKey('in-folder-gone')).toBeNull()
    expect(db.getLibraryItemByKey('in-folder-movies')).not.toBeNull()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('a new server URL drops the cached folder list; a rotated API key keeps it', async () => {
    const calls = stub()
    await library.upsertItemsByIds(['x'])
    await library.upsertItemsByIds(['x'])
    expect(calls.filter(c => c === '/Library/VirtualFolders')).toHaveLength(1)
    db.setSetting('jellyfin_api_key', 'rotated-key')
    await library.upsertItemsByIds(['x'])
    expect(calls.filter(c => c === '/Library/VirtualFolders')).toHaveLength(1)
    freshConnection()
    await library.upsertItemsByIds(['x'])
    expect(calls.filter(c => c === '/Library/VirtualFolders')).toHaveLength(2)
    db.setSetting('jellyfin_api_key', 'test-key')
  })

  it('lists mixed movie/show libraries and still skips music, photos, home videos and BoxSets', async () => {
    folders = [
      { ItemId: 'f-mixed-old', Name: 'Mixed', CollectionType: null },
      { ItemId: 'f-mixed-new', Name: 'Mixed 10.9', CollectionType: 'mixed' },
      { ItemId: 'f-music', Name: 'Music', CollectionType: 'music' },
      { ItemId: 'f-photos', Name: 'Photos', CollectionType: 'homevideos' },
      { ItemId: 'f-box', Name: 'Collections', CollectionType: 'boxsets' },
    ]
    stub()
    expect(await library.getFolders()).toEqual([
      { id: 'f-mixed-old', title: 'Mixed', type: 'mixed' },
      { id: 'f-mixed-new', title: 'Mixed 10.9', type: 'mixed' },
    ])
  })

  it('syncs a mixed folder, including its last-episode-added pass', async () => {
    const calls = stub()
    await library.syncFolder({ id: 'f-mixed', title: 'Mixed', type: 'mixed' })
    expect(db.getLibraryItemByKey('in-f-mixed')?.sectionId).toBe('jf_f-mixed')
    expect(calls.some(c => c.includes('IncludeItemTypes=Episode'))).toBe(true)
  })
})

describe('resync hooks (JF-05 / JF-17)', () => {
  beforeEach(() => {
    freshConnection()
    db.setSyncEnabledSections([])
  })
  afterEach(() => { vi.restoreAllMocks(); library.onResynced(null) })

  it('every completed resync runs fulfillment and the registered hook; concurrent callers share one run', async () => {
    const fulfilled = vi.spyOn(fulfillment, 'checkAndNotifyFulfilled').mockReturnValue(0)
    const hook = vi.fn()
    library.onResynced(hook)
    const calls = mockFetch([foldersHandler])
    await Promise.all([library.resyncAll(), library.resyncAll()])
    expect(calls.filter(c => c === '/Library/VirtualFolders')).toHaveLength(1)
    expect(fulfilled).toHaveBeenCalledWith('jellyfin resync')
    expect(hook).toHaveBeenCalledTimes(1)
  })
})
