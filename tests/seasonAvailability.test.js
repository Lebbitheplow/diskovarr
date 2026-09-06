import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// Pure helpers only — the module requires its service dependencies lazily, so
// loading it never opens a database.
const nodeRequire = createRequire(import.meta.url)
const { mergeSeasonAvailability, parseRequestedSeasons } = nodeRequire('../server/services/seasonAvailability.js')

const tmdb = (...counts) => counts.map((episodeCount, i) => ({ number: i + 1, name: `Season ${i + 1}`, episodeCount, airDate: null }))
const byNumber = (rows) => Object.fromEntries(rows.map(r => [r.number, r]))

describe('parseRequestedSeasons', () => {
  it('treats a null or empty seasons_json as a whole-show request', () => {
    expect(parseRequestedSeasons([{ seasons_json: null }]).all).toBe(true)
    expect(parseRequestedSeasons([{ seasons_json: '[]' }]).all).toBe(true)
    expect(parseRequestedSeasons([]).all).toBe(false)
  })

  it('collects explicit season numbers across rows and ignores junk', () => {
    const r = parseRequestedSeasons([{ seasons_json: '[1,2]' }, { seasons_json: '[2,"3",0,-1]' }, { seasons_json: 'not json' }])
    expect([...r.seasons].sort()).toEqual([1, 2, 3])
    expect(r.all).toBe(true) // the unparsable row falls back to whole-show
  })
})

describe('mergeSeasonAvailability — show not in the library', () => {
  it('grays out only explicitly requested seasons', () => {
    const rows = mergeSeasonAvailability({
      tmdbSeasons: tmdb(10, 10, 8),
      librarySeasons: null,
      requested: { all: false, seasons: new Set([2]) },
    })
    const s = byNumber(rows)
    expect(rows.map(r => r.number)).toEqual([1, 2, 3])
    expect(s[1]).toMatchObject({ complete: false, requested: false, selectable: true, libraryCount: 0 })
    expect(s[2]).toMatchObject({ complete: false, requested: true, selectable: false })
    expect(s[3].selectable).toBe(true)
  })

  it('grays out every season after a whole-show request', () => {
    const rows = mergeSeasonAvailability({ tmdbSeasons: tmdb(10, 10), librarySeasons: null, requested: { all: true, seasons: new Set() } })
    expect(rows.every(r => r.requested && !r.selectable)).toBe(true)
  })

  it('works with no request data at all', () => {
    const rows = mergeSeasonAvailability({ tmdbSeasons: tmdb(6) })
    expect(rows).toHaveLength(1)
    expect(rows[0].selectable).toBe(true)
  })
})

describe('mergeSeasonAvailability — show in the library', () => {
  it('marks complete seasons, keeps partial ones selectable, and ignores whole-show requests', () => {
    const rows = mergeSeasonAvailability({
      tmdbSeasons: tmdb(10, 10, 8),
      librarySeasons: [{ number: 1, episodeCount: 10 }, { number: 2, episodeCount: 4 }],
      requested: { all: true, seasons: new Set([3]) },
    })
    const s = byNumber(rows)
    expect(s[1]).toMatchObject({ complete: true, requested: false, selectable: false, libraryCount: 10, episodeCount: 10 })
    expect(s[2]).toMatchObject({ complete: false, requested: false, selectable: true, libraryCount: 4 })
    expect(s[3]).toMatchObject({ complete: false, requested: true, selectable: false, libraryCount: 0 })
  })

  it('treats a season TMDB does not list as complete once anything of it is present', () => {
    const rows = mergeSeasonAvailability({
      tmdbSeasons: tmdb(10),
      librarySeasons: [{ number: 1, episodeCount: 10 }, { number: 2, episodeCount: 3 }],
      requested: { all: false, seasons: new Set() },
    })
    const s = byNumber(rows)
    expect(rows.map(r => r.number)).toEqual([1, 2])
    expect(s[2]).toMatchObject({ complete: true, episodeCount: null, libraryCount: 3, selectable: false })
  })

  it('leaves everything selectable when the library holds no seasons yet', () => {
    const rows = mergeSeasonAvailability({ tmdbSeasons: tmdb(10, 10), librarySeasons: [], requested: { all: true, seasons: new Set() } })
    expect(rows.every(r => r.selectable)).toBe(true)
  })

  it('drops specials (season 0) and sorts by number', () => {
    const rows = mergeSeasonAvailability({
      tmdbSeasons: [{ number: 2, episodeCount: 5 }, { number: 0, episodeCount: 3 }, { number: 1, episodeCount: 5 }],
      librarySeasons: [{ number: 0, episodeCount: 3 }],
      requested: { all: false, seasons: new Set() },
    })
    expect(rows.map(r => r.number)).toEqual([1, 2])
  })
})
