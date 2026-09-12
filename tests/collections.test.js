import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-collections-test-'))

const nodeRequire = createRequire(import.meta.url)
const policy = nodeRequire('../server/services/collectionPolicy.js')
const flixpatrol = nodeRequire('../server/services/listSources/flixpatrol.js')
const listSources = nodeRequire('../server/services/listSources/index.js')
const anilist = nodeRequire('../server/services/listSources/anilist.js')
const automation = nodeRequire('../server/db/automation.js')
const autoRequest = nodeRequire('../server/services/autoRequest.js')
const plexLabels = nodeRequire('../server/services/plexLabels.js')

// ── Policy helpers ────────────────────────────────────────────────────────────

describe('collection policy', () => {
  const items = [
    { tmdbId: 1, mediaType: 'movie', title: 'A' },
    { tmdbId: 2, mediaType: 'movie', title: 'B' },
    { tmdbId: 2, mediaType: 'tv', title: 'B (show)' },
    { tmdbId: 3, mediaType: 'movie', title: 'C' },
  ]

  it('applies per-list and global exclusions by id AND media type, then caps', () => {
    const { items: kept, excludedCount } = policy.applyListPolicy(items, {
      maxItems: 2,
      exclusions: [{ tmdbId: 2, mediaType: 'movie' }],
      globalExclusions: [{ tmdbId: 3, mediaType: 'tv' }], // wrong type: must not exclude movie 3
    })
    expect(excludedCount).toBe(1)
    expect(kept.map(i => i.title)).toEqual(['A', 'B (show)'])
  })

  it('cap 0 means whole list', () => {
    expect(policy.applyListPolicy(items, { maxItems: 0 }).items).toHaveLength(4)
  })

  it('picks seasons per mode, never specials', () => {
    const seasons = [{ number: 0 }, { number: 1 }, { number: 2 }, { number: 3 }]
    expect(policy.pickSeasons('all', seasons)).toBeNull()
    expect(policy.pickSeasons('first', seasons)).toEqual([1])
    expect(policy.pickSeasons('latest', seasons)).toEqual([3])
    expect(policy.pickSeasons('first', [])).toEqual([1])
    expect(policy.pickSeasons('latest', null)).toBeNull()
  })

  it('maps visibility to Plex hub flags and back', () => {
    expect(policy.visibilityFlags('home')).toEqual({ rec: 1, own: 1, shared: 1 })
    expect(policy.visibilityFlags('owner_home')).toEqual({ rec: 1, own: 1, shared: 0 })
    expect(policy.visibilityFlags('recommended')).toEqual({ rec: 1, own: 0, shared: 0 })
    expect(policy.visibilityFlags('library')).toEqual({ rec: 0, own: 0, shared: 0 })
    for (const v of ['home', 'owner_home', 'recommended', 'library']) {
      expect(policy.visibilityFromFlags(policy.visibilityFlags(v))).toBe(v)
    }
  })

  it('builds Agregarr-compatible sort-title prefixes (order 1 = longest)', () => {
    expect(policy.sortTitlePrefix(1, 3)).toBe('!!!!')
    expect(policy.sortTitlePrefix(3, 3)).toBe('!!')
    expect(policy.sortTitlePrefix(5, 3)).toBe('!!') // order beyond max still valid
    expect(policy.sortTitlePrefix(1, 24)).toBe('!'.repeat(25)) // matches the live Agregarr prefix
  })

  it('builds the smart filter with per-type unwatched flag, sort, label and limit', () => {
    expect(policy.smartFilterPath({ sectionId: 1, mediaType: 'movie', label: 'diskovarr-list-7', sort: 'list', maxItems: 30 }))
      .toBe('/library/sections/1/all?type=1&sort=originallyAvailableAt:desc&unwatched=1&and=1&label=diskovarr-list-7&limit=30')
    expect(policy.smartFilterPath({ sectionId: 2, mediaType: 'tv', label: 'diskovarr-list-7', sort: 'title', maxItems: 0 }))
      .toBe('/library/sections/2/all?type=2&sort=titleSort&show.unwatchedLeaves=1&and=1&label=diskovarr-list-7')
  })

  it('orders regular-collection items per sort mode', () => {
    const rows = [
      { ratingKey: 'a', title: 'Zed', releaseDate: '2020-01-01', addedAt: 10, rating: 5 },
      { ratingKey: 'b', title: 'Alpha', releaseDate: '2022-01-01', addedAt: 30, rating: 9 },
      { ratingKey: 'c', title: 'Mid', releaseDate: '2021-01-01', addedAt: 20, rating: 7 },
    ]
    const keys = (sort) => policy.orderItems(rows, sort).map(r => r.ratingKey)
    expect(keys('list')).toEqual(['a', 'b', 'c'])
    expect(keys('release_desc')).toEqual(['b', 'c', 'a'])
    expect(keys('release_asc')).toEqual(['a', 'c', 'b'])
    expect(keys('title')).toEqual(['b', 'c', 'a'])
    expect(keys('added_desc')).toEqual(['b', 'c', 'a'])
    expect(keys('rating_desc')).toEqual(['b', 'c', 'a'])
  })

  it('plans the minimal set of moves and the plan reproduces the wanted order', () => {
    const apply = (current, moves) => {
      const order = [...current]
      for (const m of moves) {
        order.splice(order.indexOf(m.key), 1)
        order.splice(m.after === null ? 0 : order.indexOf(m.after) + 1, 0, m.key)
      }
      return order
    }
    expect(policy.planMoves(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([])
    const moves = policy.planMoves(['c', 'a', 'b', 'x'], ['a', 'b', 'c'])
    expect(apply(['c', 'a', 'b', 'x'], moves).filter(k => k !== 'x')).toEqual(['a', 'b', 'c'])
    // Items missing from the current list are skipped, not moved
    expect(policy.planMoves(['a'], ['a', 'zzz'])).toEqual([])
  })

  it('merges hubs and collections into one ordered home sequence', () => {
    const { sequence } = policy.planHomeLayout({
      hubs: [{ identifier: 'tv.recentlyadded', order: 1 }, { identifier: 'tv.toprated', order: 0 }, { identifier: 'tv.ondeck', order: 3 }],
      collections: [{ identifier: 'custom.collection.2.10', order: 2 }, { identifier: 'custom.collection.2.11', order: 0 }],
      anchor: 'tv.ondeck',
    })
    expect(sequence).toEqual(['tv.recentlyadded', 'custom.collection.2.10'])
    expect(policy.collectionHubId(2, '172757')).toBe('custom.collection.2.172757')
  })
})

// ── Plex label query encoding ────────────────────────────────────────────────

describe('plex labels', () => {
  it('rewrites the full label set and clears with the -= form', () => {
    expect(plexLabels.labelQuery(['Keep Me', 'diskovarr-list-3'])).toBe('label[0].tag.tag=Keep%20Me&label[1].tag.tag=diskovarr-list-3')
    expect(plexLabels.labelQuery([])).toBe('label[0].tag.tag-=')
  })
})

// ── FlixPatrol parser ────────────────────────────────────────────────────────

const GLOBAL_HTML = `
<html><body>
<h2 class="x"><span class="bg"></span> <span>TOP TV Shows on Netflix on September 12, 2026</span></h2>
<div><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/crew-girl/"><div><picture><img alt="Crew Girl" title="Crew Girl"></picture></div><div>Crew Girl <span title="This title is Netflix original"></span></div></a></td></tr>
<tr class="table-group"><td>2.</td><td><a href="/title/the-gentlemen-2024/"><div><picture><img alt="The Gentlemen" title="The Gentlemen"></picture></div><div>The Gentlemen</div></a></td></tr>
</tbody></table></div>
<h2 class="x"><span>TOP Movies on Netflix on September 12, 2026</span></h2>
<div><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/kpop-demon-hunters/"><picture><img alt="KPop Demon Hunters" title="KPop Demon Hunters"></picture></a></td></tr>
</tbody></table></div>
<h2 class="x"><span>TOP Movies on HBO Max on September 12, 2026</span></h2>
<div><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/weapons/"><picture><img alt="Weapons" title="Weapons"></picture></a></td></tr>
</tbody></table></div>
<h2><span>TOP Movies and TV Shows on Netflix on September 12, 2026 by country</span></h2>
<table><tr><td><a href="/title/ignored/"><img alt="Ignored" title="Ignored"></a></td></tr></table>
</body></html>`

const COUNTRY_HTML = `
<html><body>
<h2><span class="bg"></span> <span>Hulu TOP 10 in the United States on September 12, 2026</span></h2>
<div><h3>TOP 10 Overall</h3><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/mormon-wives/" class="hover:underline">The Secret Lives of Mormon Wives</a></td></tr>
</tbody></table>
<h3>TOP 10 Movies</h3><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/coraline/" class="hover:underline">Coraline</a></td></tr>
<tr class="table-group"><td>2.</td><td><a href="/title/the-devil-wears-prada-2/" class="hover:underline">The Devil Wears Prada 2</a></td></tr>
</tbody></table>
<h3>TOP 10 TV Shows</h3><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/mormon-wives/" class="hover:underline">The Secret Lives of Mormon Wives</a></td></tr>
</tbody></table></div>
<h2><span>Peacock TOP 10 in the United States on September 12, 2026</span></h2>
<div><h3>TOP 10 Overall</h3><table><tbody>
<tr class="table-group"><td>1.</td><td><a href="/title/love-island-usa/" class="hover:underline">Love Island USA</a></td></tr>
</tbody></table></div>
</body></html>`

describe('flixpatrol parser', () => {
  it('reads the global page per platform and media type, with slug years', () => {
    const tv = flixpatrol.parseTop10(GLOBAL_HTML, { platform: 'netflix', mediaType: 'tv' })
    expect(tv).toEqual([
      { title: 'Crew Girl', year: null, mediaType: 'tv' },
      { title: 'The Gentlemen', year: 2024, mediaType: 'tv' },
    ])
    expect(flixpatrol.parseTop10(GLOBAL_HTML, { platform: 'netflix', mediaType: 'movie' }).map(e => e.title)).toEqual(['KPop Demon Hunters'])
    expect(flixpatrol.parseTop10(GLOBAL_HTML, { platform: 'hbo', mediaType: 'movie' }).map(e => e.title)).toEqual(['Weapons'])
    expect(flixpatrol.parseTop10(GLOBAL_HTML, { platform: 'hulu', mediaType: 'movie' })).toEqual([])
  })

  it('reads country pages from the typed sub-tables, falling back to Overall', () => {
    expect(flixpatrol.parseTop10(COUNTRY_HTML, { platform: 'hulu', mediaType: 'movie' }).map(e => e.title))
      .toEqual(['Coraline', 'The Devil Wears Prada 2'])
    expect(flixpatrol.parseTop10(COUNTRY_HTML, { platform: 'hulu', mediaType: 'tv' }).map(e => e.title))
      .toEqual(['The Secret Lives of Mormon Wives'])
    // Peacock only has an Overall table: untyped entries resolve via /search/multi later
    expect(flixpatrol.parseTop10(COUNTRY_HTML, { platform: 'peacock', mediaType: 'tv' }))
      .toEqual([{ title: 'Love Island USA', year: null, mediaType: null }])
  })

  it('does not confuse HBO Max with other platforms or the by-country sections', () => {
    expect(flixpatrol.parseTop10(GLOBAL_HTML, { platform: 'hbo', mediaType: 'tv' })).toEqual([])
    expect(flixpatrol.pageUrl('global')).toBe('https://flixpatrol.com/top10')
    expect(flixpatrol.pageUrl('united-states')).toBe('https://flixpatrol.com/top10/streaming/united-states/')
  })
})

// ── Multi-URL lists ──────────────────────────────────────────────────────────

describe('multi-URL lists', () => {
  it('splits on newlines/whitespace and parses each URL', () => {
    const parsed = listSources.parseListUrls('https://trakt.tv/users/a/lists/one\nhttps://trakt.tv/users/b/lists/two?sort=rank,asc')
    expect(parsed.map(p => p.slug)).toEqual(['one', 'two'])
    expect(() => listSources.parseListUrls('https://trakt.tv/users/a/lists/one\nhttps://example.com/x')).toThrow(/Unsupported/)
    expect(() => listSources.parseListUrls('')).toThrow(/valid URL/)
  })
})

// ── AniList popular + id mapping ─────────────────────────────────────────────

describe('anilist popular chart', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('pages the popularity chart and attaches TMDB ids from the anime-lists index', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.push(url)
      if (String(url).includes('graphql.anilist.co')) {
        const body = JSON.parse(opts.body)
        expect(body.variables.formats).toEqual(['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'])
        return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, media: [
          { id: 16498, idMal: 16498, title: { english: 'Attack on Titan', romaji: 'Shingeki no Kyojin' }, startDate: { year: 2013 }, format: 'TV' },
          { id: 999999, idMal: null, title: { english: null, romaji: 'Unmapped Show' }, startDate: { year: 2001 }, format: 'ONA' },
        ] } } }) }
      }
      // anime-lists mapping
      return { ok: true, json: async () => ([
        { anilist_id: 16498, themoviedb_id: { tv: 1429 }, tvdb_id: 267440 },
      ]) }
    }))
    const entries = await anilist.fetchPopular({ mediaType: 'tv' }, { limit: 10 })
    expect(entries).toEqual([
      { anilistId: 16498, title: 'Attack on Titan', year: 2013, mediaType: 'tv', tmdbId: 1429, tvdbId: 267440 },
      { anilistId: 999999, title: 'Unmapped Show', year: 2001, mediaType: 'tv' },
    ])
    expect(calls.filter(u => String(u).includes('anime-list'))).toHaveLength(1)
  })
})

// ── Persistence of the new list fields ───────────────────────────────────────

describe('list source persistence', () => {
  it('round-trips presentation, policy and exclusion fields', () => {
    const id = automation.createListSource({
      name: 'Trending', sourceType: 'preset', presetKey: 'tmdb_trending_tv_week', mediaType: 'tv',
      approvalMode: 'auto', syncIntervalHours: 12, maxRequestsPerRun: 100,
      collectionEnabled: true, collectionVisibility: 'owner_home', collectionUnwatchedOnly: true,
      collectionSort: 'release_desc', homeOrder: 2, libraryOrder: 1, maxItems: 30, seasonMode: 'first',
      exclusions: [{ tmdbId: 5, mediaType: 'tv', title: 'X' }, { tmdbId: 'bad' }],
      collectionRatingKey: JSON.stringify({ tv: '172757' }),
    })
    const list = automation.getListSource(id)
    expect(list).toMatchObject({
      collectionVisibility: 'owner_home', collectionUnwatchedOnly: true, collectionSort: 'release_desc',
      homeOrder: 2, libraryOrder: 1, maxItems: 30, seasonMode: 'first',
      exclusions: [{ tmdbId: 5, mediaType: 'tv', title: 'X' }],
      collectionRatingKey: '{"tv":"172757"}',
    })
    automation.updateListSource(id, { collectionSort: 'nonsense', seasonMode: 'latest', homeOrder: 0, exclusions: [] })
    const updated = automation.getListSource(id)
    expect(updated.collectionSort).toBe('list')
    expect(updated.seasonMode).toBe('latest')
    expect(updated.homeOrder).toBe(0)
    expect(updated.exclusions).toEqual([])
    expect(automation.getCollectionListsForMedia('tv').map(l => l.id)).toContain(id)
    expect(automation.getCollectionListsForMedia('movie').map(l => l.id)).not.toContain(id)
  })

  it('keeps list positions for the quick sync', () => {
    const id = automation.createListSource({ name: 'P', sourceType: 'preset', presetKey: 'tmdb_popular_movies', mediaType: 'movie' })
    const t0 = Math.floor(Date.now() / 1000) - 5
    automation.upsertListItem({ listId: id, tmdbId: 3, mediaType: 'movie', title: 'C', status: 'in_library', position: 3 })
    automation.upsertListItem({ listId: id, tmdbId: 1, mediaType: 'movie', title: 'A', status: 'seen', position: 1 })
    automation.upsertListItem({ listId: id, tmdbId: 2, mediaType: 'movie', title: 'B', status: 'requested', position: 2 })
    expect(automation.getListItemsInOrder(id, t0).map(i => i.title)).toEqual(['A', 'B', 'C'])
  })

  it('stores global exclusions deduplicated by id and type', () => {
    const saved = autoRequest.setGlobalExclusions([
      { tmdbId: 121, mediaType: 'movie', title: 'The Two Towers' },
      { tmdbId: 121, mediaType: 'tv', title: 'Doctor Who' },
      { tmdbId: 121, mediaType: 'movie' },
      { tmdbId: 0 },
    ])
    expect(saved).toHaveLength(2)
    expect(autoRequest.getGlobalExclusions()).toEqual(saved)
  })
})
