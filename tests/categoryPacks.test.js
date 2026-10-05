import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Throwaway data dir BEFORE loading the db module — never the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-categories-test-'))
process.env.PLEX_URL = 'http://plex.test:32400'
process.env.PLEX_TOKEN = 'token'
process.env.PLEX_SERVER_ID = 'machine'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const automation = nodeRequire('../server/db/automation.js')
const listPolicy = nodeRequire('../server/services/collectionPolicy.js')
const policy = nodeRequire('../server/services/categoryPolicy.js')
const seasonal = nodeRequire('../server/services/listSources/seasonal.js')
const presets = nodeRequire('../server/services/listSources/presets.js')
const autoRequest = nodeRequire('../server/services/autoRequest.js')
const packs = nodeRequire('../server/services/categoryPacks.js')

const item = (ratingKey, type, extra = {}) => ({
  ratingKey, sectionId: type === 'show' ? '2' : '1', title: ratingKey, year: 2000, thumb: null, art: null, type,
  genres: [], directors: [], cast: [], audienceRating: 0, contentRating: '', addedAt: 0, summary: '',
  rating: 0, ratingImage: '', audienceRatingImage: '', studio: '', tmdbId: ratingKey.replace(/\D/g, '') || '1', source: 'plex',
  ...extra,
})

// Fake Plex: records every call and answers the handful of endpoints the
// category sync touches. `state.collections` is what the server "has".
function stubPlex(state) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = new URL(url)
    const method = opts.method || 'GET'
    calls.push({ method, path: u.pathname, params: u.searchParams })
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
    const m = u.pathname.match(/^\/library\/sections\/(\d+)\/collections$/)
    if (m) return json({ MediaContainer: { Metadata: state.collections.filter(c => c.section === m[1]) } })
    if (u.pathname === '/library/collections' && method === 'POST') {
      const created = { ratingKey: String(state.nextKey++), title: u.searchParams.get('title'), smart: '1', section: u.searchParams.get('sectionId') }
      state.collections.push(created)
      return json({ MediaContainer: { Metadata: [created] } })
    }
    const c = u.pathname.match(/^\/library\/collections\/(\d+)$/)
    if (c) {
      const found = state.collections.find(x => x.ratingKey === c[1])
      if (method === 'DELETE') { state.collections = state.collections.filter(x => x.ratingKey !== c[1]); return json({}) }
      return found ? json({ MediaContainer: { Metadata: [found] } }) : { ok: false, status: 404, text: async () => '' }
    }
    return json({})
  }))
  return calls
}

// ── Schedule windows ─────────────────────────────────────────────────────────

describe('list schedule windows', () => {
  const on = (m, d) => new Date(2026, m - 1, d)

  it('normalizes MM-DD and rejects junk', () => {
    expect(listPolicy.normalizeMonthDay('10-01')).toBe('10-01')
    expect(listPolicy.normalizeMonthDay('5/18')).toBe('05-18')
    expect(listPolicy.normalizeMonthDay('13-01')).toBeNull()
    expect(listPolicy.normalizeMonthDay('october')).toBeNull()
    expect(listPolicy.normalizeMonthDay(null)).toBeNull()
  })

  it('is inclusive on both ends and open-ended without a full window', () => {
    const halloween = { scheduleStart: '10-01', scheduleEnd: '10-31' }
    expect(listPolicy.inSchedule(halloween, on(10, 1))).toBe(true)
    expect(listPolicy.inSchedule(halloween, on(10, 31))).toBe(true)
    expect(listPolicy.inSchedule(halloween, on(11, 1))).toBe(false)
    expect(listPolicy.inSchedule(halloween, on(9, 30))).toBe(false)
    expect(listPolicy.inSchedule({}, on(3, 3))).toBe(true)
    expect(listPolicy.inSchedule({ scheduleStart: '10-01' }, on(3, 3))).toBe(true)
  })

  it('wraps the new year', () => {
    const newYear = { scheduleStart: '12-26', scheduleEnd: '01-04' }
    expect(listPolicy.inSchedule(newYear, on(12, 30))).toBe(true)
    expect(listPolicy.inSchedule(newYear, on(1, 4))).toBe(true)
    expect(listPolicy.inSchedule(newYear, on(1, 5))).toBe(false)
    expect(listPolicy.inSchedule(newYear, on(12, 25))).toBe(false)
  })

  it('every holiday has a valid window and a seasonal preset', () => {
    for (const h of seasonal.HOLIDAYS) {
      expect(listPolicy.normalizeMonthDay(h.start)).toBe(h.start)
      expect(listPolicy.normalizeMonthDay(h.end)).toBe(h.end)
      expect(presets.byKey(`seasonal_${h.key}`)).toMatchObject({ group: 'Seasonal', mediaType: 'movie', seasonal: h.key })
    }
    expect(presets.getPresets().find(p => p.key === 'seasonal_halloween').schedule).toEqual({ start: '10-01', end: '10-31' })
  })
})

// ── Pure pack policy ─────────────────────────────────────────────────────────

describe('category policy', () => {
  it('builds Plex smart filters per rule', () => {
    expect(policy.filterPath({ sectionId: '1', media: 'movie', rule: { kind: 'studio', value: 'Warner Bros. Pictures' } }))
      .toBe('/library/sections/1/all?type=1&sort=originallyAvailableAt:desc&studio=Warner%20Bros.%20Pictures')
    expect(policy.filterPath({ sectionId: '1', media: 'movie', rule: { kind: 'decade', decade: 1990, limit: 100 } }))
      .toBe('/library/sections/1/all?type=1&sort=rating:desc&decade=1990&limit=100')
    expect(policy.filterPath({ sectionId: '2', media: 'tv', rule: { kind: 'decade', decade: 1990, limit: 50 } }))
      .toContain('sort=audienceRating:desc')
    expect(policy.filterPath({ sectionId: '2', media: 'tv', rule: { kind: 'network', id: '66234' } }))
      .toBe('/library/sections/2/all?type=2&sort=originallyAvailableAt:desc&network=66234')
    expect(policy.filterPath({ sectionId: '1', media: 'movie', rule: { kind: 'recent', days: 90 } }))
      .toContain('originallyAvailableAt%3E%3E=-90d')
    expect(policy.filterPath({ sectionId: '2', media: 'tv', rule: { kind: 'new_episodes', days: 7 } }))
      .toBe('/library/sections/2/all?type=4&sort=originallyAvailableAt:desc&episode.originallyAvailableAt%3E%3E=-7d')
    expect(policy.plexTypeFor('tv', { kind: 'new_episodes' })).toBe(4)
    expect(policy.plexTypeFor('tv', { kind: 'studio' })).toBe(2)
  })

  it('uses Kometa-compatible sort titles and artwork paths', () => {
    expect(policy.sortTitle('studio', 'Pixar')).toBe('!070_Pixar')
    expect(policy.sortTitle('decade', 'Best of 1990s')).toBe('!100_Best of 1990s')
    expect(policy.posterUrl('studio', 'Pixar', 'Pixar')).toBe(`${policy.IMAGE_BASE}/studio/Pixar.jpg`)
    expect(policy.posterUrl('basic', 'released', 'Newly Released')).toBe(`${policy.IMAGE_BASE}/chart/color/Newly%20Released.jpg`)
    expect(policy.posterUrl('seasonal', 'halloween', 'Halloween Movies')).toBe(`${policy.IMAGE_BASE}/seasonal/halloween.jpg`)
  })

  it('normalizes config and dedupes titles per library', () => {
    expect(policy.normalizeConfig('studio', null)).toEqual({ enabled: false, visibility: 'library', minItems: 5 })
    expect(policy.normalizeConfig('decade', { enabled: 1, visibility: 'nope', minItems: -3, limit: 9999 }))
      .toEqual({ enabled: true, visibility: 'library', minItems: 1, limit: 500 })
    const taken = new Set(['tv:netflix'])
    const kept = policy.dedupeTitles([
      { media: 'tv', title: 'Netflix' }, { media: 'movie', title: 'Netflix' }, { media: 'tv', title: 'HBO' },
    ], taken)
    expect(kept.map(k => `${k.media}:${k.title}`)).toEqual(['movie:Netflix', 'tv:HBO'])
    expect(policy.filterableName('Film4, Inc')).toBe(false)
  })
})

// ── Library packs against a fake Plex ────────────────────────────────────────

describe('library packs', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM library_items').run()
    db.prepare('DELETE FROM category_collections').run()
    db.setSetting('category_packs', '{}')
    db.upsertManyItems([
      item('m1', 'movie', { studio: 'Pixar', year: 1995 }),
      item('m2', 'movie', { studio: 'pixar', year: 1998 }),
      item('m3', 'movie', { studio: 'Pixar', year: 2003 }),
      item('m4', 'movie', { studio: 'A24', year: 2019 }),
      item('m5', 'movie', { studio: 'Film4, Inc', year: 2019 }),
      item('s1', 'show', { studio: 'HBO', year: 2011 }),
      item('s2', 'show', { studio: 'HBO', year: 2019 }),
      // Outside the two main libraries: never part of a Plex pack.
      item('y1', 'show', { studio: 'HBO', year: 2019, sectionId: '10' }),
    ])
  })
  afterEach(() => vi.unstubAllGlobals())

  it('plans studios above the minimum, case-insensitively, per library', async () => {
    packs.setPackConfig('studio', { minItems: 2 })
    const planned = await packs.planPack('studio', packs.getConfig().studio)
    expect(planned.map(p => `${p.media}:${p.title}:${p.count}`)).toEqual(['movie:Pixar:3', 'tv:HBO:2'])
  })

  it('plans decades with the configured cap', async () => {
    packs.setPackConfig('decade', { minItems: 2, limit: 50 })
    const planned = await packs.planPack('decade', packs.getConfig().decade)
    expect(planned.map(p => `${p.media}:${p.title}`)).toEqual(['movie:Best of 1990s', 'movie:Best of 2010s', 'tv:Best of 2010s'])
    expect(planned[0].rule).toEqual({ kind: 'decade', decade: 1990, limit: 50 })
  })

  it('adopts a same-named smart collection, creates the rest, and removes strays', async () => {
    const state = { nextKey: 900, collections: [{ ratingKey: '128744', title: 'Pixar', smart: '1', titleSort: '!070_Pixar', section: '1' }] }
    const calls = stubPlex(state)
    await packs.updatePack('studio', { enabled: true, minItems: 2, visibility: 'library' })
    const first = await packs.syncPack('studio')
    expect(first).toMatchObject({ collections: 2, created: 2, failed: 0 })

    const rows = packs.getRows('studio')
    expect(rows.map(r => `${r.title}:${r.plexKey}`)).toEqual(['Pixar:128744', 'HBO:900'])
    // Adopted: filter repointed, nothing created for it, artwork left alone.
    const created = calls.filter(c => c.method === 'POST' && c.path === '/library/collections')
    expect(created).toHaveLength(1)
    expect(created[0].params.get('title')).toBe('HBO')
    expect(created[0].params.get('smart')).toBe('1')
    expect(decodeURIComponent(created[0].params.get('uri'))).toContain('/library/sections/2/all?type=2&sort=originallyAvailableAt:desc&studio=HBO')
    expect(calls.some(c => c.method === 'PUT' && c.path === '/library/collections/128744/items')).toBe(true)
    expect(calls.filter(c => c.path.endsWith('/posters')).map(c => c.path)).toEqual(['/library/metadata/900/posters'])

    // HBO drops below the minimum → its collection is deleted, Pixar stays.
    db.prepare("DELETE FROM library_items WHERE rating_key = 's2'").run()
    const second = await packs.syncPack('studio')
    expect(second).toMatchObject({ collections: 1, created: 0, removed: 1 })
    expect(state.collections.map(c => c.title)).toEqual(['Pixar'])
    expect(packs.getRows('studio').map(r => r.title)).toEqual(['Pixar'])
  })

  it('refuses to take over a manual (non-smart) collection of the same name', async () => {
    const state = { nextKey: 900, collections: [{ ratingKey: '5', title: 'Pixar', smart: '0', section: '1' }] }
    stubPlex(state)
    await packs.updatePack('studio', { enabled: true, minItems: 3 })
    const summary = await packs.syncPack('studio')
    expect(summary).toMatchObject({ collections: 1, failed: 1 })
    expect(packs.getRows('studio')[0]).toMatchObject({ plexKey: null })
    expect(packs.getRows('studio')[0].lastError).toMatch(/manual collection/)
    expect(state.collections).toHaveLength(1)
  })

  it('disabling keeps the collections unless asked to delete them', async () => {
    const state = { nextKey: 900, collections: [] }
    stubPlex(state)
    await packs.updatePack('studio', { enabled: true, minItems: 2 })
    await packs.syncPack('studio')
    expect(state.collections).toHaveLength(2)
    await packs.updatePack('studio', { enabled: false })
    expect(packs.getRows('studio')).toHaveLength(0)
    expect(state.collections).toHaveLength(2)

    await packs.updatePack('studio', { enabled: true })
    await packs.syncPack('studio')
    await packs.updatePack('studio', { enabled: false }, { deleteCollections: true })
    expect(state.collections).toHaveLength(0)
  })
})

// ── Seasonal pack ────────────────────────────────────────────────────────────

describe('seasonal pack', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM list_sources').run()
    db.setSetting('category_packs', '{}')
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('creates one scheduled, collection-only list per holiday and toggles them', async () => {
    stubPlex({ nextKey: 900, collections: [] })
    await packs.updatePack('seasonal', { enabled: true, visibility: 'home' })
    const lists = automation.getListSources().filter(l => l.pack === 'seasonal')
    expect(lists).toHaveLength(seasonal.HOLIDAYS.length)
    const halloween = lists.find(l => l.packKey === 'halloween')
    expect(halloween).toMatchObject({
      name: 'Halloween Movies', presetKey: 'seasonal_halloween', mediaType: 'movie', enabled: true,
      maxRequestsPerRun: 0, collectionEnabled: true, collectionVisibility: 'home',
      scheduleStart: '10-01', scheduleEnd: '10-31',
    })
    // Re-enabling never duplicates.
    await packs.updatePack('seasonal', { enabled: false })
    expect(automation.getListSources().every(l => !l.enabled)).toBe(true)
    await packs.updatePack('seasonal', { enabled: true })
    expect(automation.getListSources().filter(l => l.pack === 'seasonal')).toHaveLength(seasonal.HOLIDAYS.length)
  })

  it('an out-of-season list takes its collection down and is due the day its window opens', async () => {
    const state = { nextKey: 900, collections: [{ ratingKey: '77', title: 'Halloween Movies', smart: '0', section: '1' }] }
    const calls = stubPlex(state)
    const id = automation.createListSource({
      name: 'Halloween Movies', sourceType: 'preset', presetKey: 'seasonal_halloween', mediaType: 'movie',
      maxRequestsPerRun: 0, collectionEnabled: true, collectionRatingKey: JSON.stringify({ movie: '77' }),
      pack: 'seasonal', packKey: 'halloween', scheduleStart: '10-01', scheduleEnd: '10-31',
    })

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 2, 12))
    const summary = await autoRequest.syncList(automation.getListSource(id))
    expect(summary.outOfSeason).toBe(true)
    expect(state.collections).toHaveLength(0)
    // No list source was fetched while out of season.
    expect(calls.every(c => c.path.startsWith('/library/'))).toBe(true)
    const retired = automation.getListSource(id)
    expect(retired).toMatchObject({ collectionRatingKey: null, lastStatus: 'out of season' })
    expect(automation.getDueListSources().map(l => l.id)).not.toContain(id)

    vi.setSystemTime(new Date(2027, 9, 1, 0, 5))
    automation.updateListSource(id, { lastSyncedAt: Math.floor(Date.now() / 1000) - 60 })
    expect(automation.getDueListSources().map(l => l.id)).toContain(id)
  })
})
