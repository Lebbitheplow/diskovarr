import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

// Load through Node's CommonJS loader so every module shares the same db
// instance (Vitest's ESM import would create a second transformed copy).
const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const matcher = nodeRequire('../server/services/monitorMatcher.js')

function makeContent(overrides = {}) {
  return {
    tmdbId: 550, mediaType: 'movie', title: 'Fight Club',
    genres: ['Drama', 'Thriller'], cast: ['Brad Pitt', 'Edward Norton'],
    directors: ['David Fincher'], writers: [], producers: [],
    studio: 'Fox 2000 Pictures', networks: [], collections: [],
    countries: ['United States'], keywords: ['cult film'], language: 'en',
    productionCompanies: ['Fox 2000 Pictures'],
    ...overrides,
  }
}

describe('evaluateCriterion', () => {
  it('matches array fields case-insensitively by substring', () => {
    const content = makeContent()
    expect(matcher.evaluateCriterion({ type: 'genre', entityName: 'drama' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'cast', entityName: 'BRAD PITT' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'cast', entityName: 'norton' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'director', entityName: 'Kubrick' }, content)).toBe(false)
  })

  it('matches scalar fields (studio, language)', () => {
    const content = makeContent()
    expect(matcher.evaluateCriterion({ type: 'studio', entityName: 'fox 2000' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'language', entityName: 'en' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'language', entityName: 'ja' }, content)).toBe(false)
  })

  it('matches media_type and specific title criteria', () => {
    const content = makeContent()
    expect(matcher.evaluateCriterion({ type: 'media_type', entityName: 'movie' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'media_type', entityName: 'tv' }, content)).toBe(false)
    expect(matcher.evaluateCriterion({ type: 'movie', entityName: 'Fight Club', entityId: '550' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'movie', entityName: 'Other', entityId: '999' }, content)).toBe(false)
    expect(matcher.evaluateCriterion({ type: 'tv_series', entityName: 'Fight Club', entityId: '550' }, content)).toBe(false)
  })

  it('matches keyword and production_company arrays', () => {
    const content = makeContent()
    expect(matcher.evaluateCriterion({ type: 'keyword', entityName: 'cult' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'production_company', entityName: 'Fox 2000' }, content)).toBe(true)
  })

  it('never matches unknown criterion types', () => {
    expect(matcher.evaluateCriterion({ type: 'bogus', entityName: 'x' }, makeContent())).toBe(false)
  })
})

describe('matchMonitor', () => {
  const criteria = [
    { type: 'genre', entityName: 'Drama' },
    { type: 'cast', entityName: 'Nobody' },
  ]

  it('ALL mode requires every criterion', () => {
    const { matched } = matcher.matchMonitor({ matchMode: 'ALL' }, criteria, makeContent())
    expect(matched).toBe(false)
  })

  it('ANY mode requires at least one criterion', () => {
    const { matched, matchedCriteria } = matcher.matchMonitor({ matchMode: 'ANY' }, criteria, makeContent())
    expect(matched).toBe(true)
    expect(matchedCriteria).toHaveLength(1)
  })

  it('empty criteria never match', () => {
    expect(matcher.matchMonitor({ matchMode: 'ANY' }, [], makeContent()).matched).toBe(false)
  })
})

describe('buildContentFromLibrary', () => {
  const item = {
    tmdbId: '77701', type: 'movie', title: 'Cached Movie',
    genres: ['Horror'], cast: [], directors: [], writers: [], producers: [],
    studio: 'Plex Studio', collections: [], countries: [],
  }

  it('enriches keywords/language/production companies from the TMDB cache', () => {
    db.setTmdbCache(77701, 'movie', {
      tmdbId: 77701, mediaType: 'movie', title: 'Cached Movie',
      keywords: ['haunted house', 'found footage'],
      originalLanguage: 'ja',
      studio: 'A24, Neon',
    })
    const content = matcher.buildContentFromLibrary(item)
    expect(content.keywords).toEqual(['haunted house', 'found footage'])
    expect(content.language).toBe('ja')
    expect(content.productionCompanies).toEqual(['A24', 'Neon'])
    // The whole point: these criterion types now fire for Plex-added content
    expect(matcher.evaluateCriterion({ type: 'keyword', entityName: 'found footage' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'language', entityName: 'ja' }, content)).toBe(true)
    expect(matcher.evaluateCriterion({ type: 'production_company', entityName: 'a24' }, content)).toBe(true)
  })

  it('falls back to empty facets without a cache entry (no throw, no match)', () => {
    const content = matcher.buildContentFromLibrary({ ...item, tmdbId: '999999' })
    expect(content.keywords).toEqual([])
    expect(content.language).toBe('')
    expect(content.productionCompanies).toEqual([])
    expect(matcher.evaluateCriterion({ type: 'keyword', entityName: 'anything' }, content)).toBe(false)
    // Plex-native facets still work
    expect(matcher.evaluateCriterion({ type: 'genre', entityName: 'horror' }, content)).toBe(true)
  })
})

describe('replaceCriteria', () => {
  it('atomically swaps a monitor criteria set — no duplicates, removals persist', () => {
    const monitorId = db.createMonitor({
      userId: 'u1', name: 'test', enabled: true, matchMode: 'ALL',
      notifyPlex: true, notifyRequestable: true,
    })
    db.createCriteria({ monitorId, type: 'genre', entityName: 'Horror' })
    db.createCriteria({ monitorId, type: 'cast', entityName: 'Brad Pitt' })

    // Re-saving the same set (the old duplication bug) must not grow it
    db.replaceCriteria(monitorId, [
      { type: 'genre', entityName: 'Horror' },
      { type: 'cast', entityName: 'Brad Pitt' },
    ])
    expect(db.getCriteria(monitorId)).toHaveLength(2)

    // A removal in the editor persists on save
    db.replaceCriteria(monitorId, [{ type: 'genre', entityName: 'Horror' }])
    const after = db.getCriteria(monitorId)
    expect(after).toHaveLength(1)
    expect(after[0].type).toBe('genre')
    expect(after[0].entityName).toBe('Horror')

    db.deleteMonitor(monitorId, 'u1')
  })
})
