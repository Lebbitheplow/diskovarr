import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

const nodeRequire = createRequire(import.meta.url)
const wrapped = nodeRequire('../server/services/wrappedStats.js')
const { computePersonality } = nodeRequire('../server/services/wrappedPersonality.js')

// A play row shaped like wrappedStats.fetchPlays output.
function play(overrides = {}) {
  return {
    user_id: 'u1', user_name: 'User One', user_thumb: null,
    media_type: 'movie', entity_key: 'm1',
    title: 'Some Movie', parent_title: null, year: 2015, thumb: null,
    watched_at: Math.floor(new Date(2025, 5, 15, 21, 0).getTime() / 1000),
    duration: 5400, percent_complete: 95, watched_status: 'complete',
    li_title: null, li_year: null, li_thumb: null, li_genres: null,
    ...overrides,
  }
}

// ── Qualifying-play predicate (the wrapperr accuracy fix) ─────────────────────

describe('playQualifies', () => {
  it('accepts plays Tautulli marked complete, even short ones', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'complete', duration: 120, percent_complete: 5 }))).toBe(true)
  })
  it('rejects 4:59 of playback even at high completion', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'incomplete', duration: 299, percent_complete: 90 }))).toBe(false)
  })
  it('rejects 19% completion even with long duration', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'incomplete', duration: 3600, percent_complete: 19 }))).toBe(false)
  })
  it('accepts exactly 5 min and 20%', () => {
    expect(wrapped.playQualifies(play({ watched_status: 'incomplete', duration: 300, percent_complete: 20 }))).toBe(true)
  })
})

// ── December unlock gate ──────────────────────────────────────────────────────

describe('isYearUnlocked', () => {
  it('is locked on Nov 30 of the wrap year', () => {
    expect(wrapped.isYearUnlocked(2025, new Date(2025, 10, 30, 23, 59))).toBe(false)
  })
  it('unlocks at midnight Dec 1', () => {
    expect(wrapped.isYearUnlocked(2025, new Date(2025, 11, 1, 0, 0))).toBe(true)
  })
  it('stays unlocked forever after (archive)', () => {
    expect(wrapped.isYearUnlocked(2021, new Date(2026, 6, 4))).toBe(true)
  })
  it('never unlocks future years', () => {
    expect(wrapped.isYearUnlocked(2026, new Date(2026, 6, 4))).toBe(false)
  })
})

// ── Entity aggregation ────────────────────────────────────────────────────────

describe('aggregateEntities', () => {
  it('rolls episodes up to the show and sums plays/seconds', () => {
    const entities = wrapped.aggregateEntities([
      play({ media_type: 'episode', entity_key: 's1', parent_title: 'The Show', duration: 1800 }),
      play({ media_type: 'episode', entity_key: 's1', parent_title: 'The Show', duration: 1500 }),
      play({ entity_key: 'm1', duration: 5400 }),
    ])
    expect(entities.size).toBe(2)
    expect(entities.get('s1')).toMatchObject({ mediaType: 'show', title: 'The Show', seconds: 3300, plays: 2 })
    expect(entities.get('m1')).toMatchObject({ mediaType: 'movie', seconds: 5400, plays: 1 })
  })
  it('prefers library_items metadata and parses genres', () => {
    const entities = wrapped.aggregateEntities([
      play({ entity_key: 'm2', title: 'stale title', li_title: 'Canonical', li_year: 1999, li_genres: '["Drama","Crime"]' }),
    ])
    expect(entities.get('m2')).toMatchObject({ title: 'Canonical', year: 1999, genres: ['Drama', 'Crime'] })
  })
})

// ── Genres ────────────────────────────────────────────────────────────────────

describe('computeGenres', () => {
  it('weights genres by seconds and yields a percentage mix', () => {
    const entities = wrapped.aggregateEntities([
      play({ entity_key: 'a', duration: 3000, li_genres: '["Drama"]' }),
      play({ entity_key: 'b', duration: 1000, li_genres: '["Comedy"]' }),
    ])
    const genres = wrapped.computeGenres(entities)
    expect(genres[0]).toMatchObject({ name: 'Drama', pct: 75 })
    expect(genres[1]).toMatchObject({ name: 'Comedy', pct: 25 })
  })
  it('returns [] when nothing has genre metadata', () => {
    const entities = wrapped.aggregateEntities([play({ li_genres: null })])
    expect(wrapped.computeGenres(entities)).toEqual([])
  })
})

// ── Time / binge / streak ─────────────────────────────────────────────────────

const ts = (y, m, d, h = 20) => Math.floor(new Date(y, m, d, h).getTime() / 1000)

describe('computeTimeStats', () => {
  it('handles a single day: streak of 1 and that day as binge day', () => {
    const t = wrapped.computeTimeStats([
      play({ watched_at: ts(2025, 2, 10, 21), duration: 3600 }),
      play({ watched_at: ts(2025, 2, 10, 23), duration: 1800 }),
    ])
    expect(t.streak).toMatchObject({ days: 1, start: '2025-03-10', end: '2025-03-10' })
    expect(t.bingeDay).toMatchObject({ date: '2025-03-10', seconds: 5400, plays: 2 })
    expect(t.peakHour).toBeGreaterThanOrEqual(21)
  })
  it('finds the longest consecutive-day streak, including across a month boundary', () => {
    const plays = [
      play({ watched_at: ts(2025, 0, 30) }),
      play({ watched_at: ts(2025, 0, 31) }),
      play({ watched_at: ts(2025, 1, 1) }),
      play({ watched_at: ts(2025, 1, 2) }),
      // gap
      play({ watched_at: ts(2025, 5, 10) }),
    ]
    expect(wrapped.computeTimeStats(plays).streak).toMatchObject({ days: 4, start: '2025-01-30', end: '2025-02-02' })
  })
  it('picks the max-seconds day as binge day over a max-plays day', () => {
    const t = wrapped.computeTimeStats([
      play({ watched_at: ts(2025, 3, 1), duration: 600 }),
      play({ watched_at: ts(2025, 3, 1, 21), duration: 600 }),
      play({ watched_at: ts(2025, 3, 2), duration: 7200 }),
    ])
    expect(t.bingeDay).toMatchObject({ date: '2025-04-02', seconds: 7200, plays: 1 })
  })
  it('accumulates month seconds into the right bucket', () => {
    const t = wrapped.computeTimeStats([play({ watched_at: ts(2025, 6, 4), duration: 1234 })])
    expect(t.months[6]).toBe(1234)
    expect(t.months.reduce((a, b) => a + b, 0)).toBe(1234)
  })
})

// ── Birth decade ──────────────────────────────────────────────────────────────

describe('computeBirthDecade', () => {
  const entitiesFromYears = (years) => wrapped.aggregateEntities(
    years.map((year, i) => play({ entity_key: `e${i}`, year, duration: 3600 }))
  )
  it('is ineligible below 5 dated titles', () => {
    expect(wrapped.computeBirthDecade(entitiesFromYears([1990, 1991, 1992, 1993]), 2025)).toMatchObject({ eligible: false })
  })
  it('puts the nostalgia peak at the cumulative-weight midpoint (uniform case)', () => {
    const result = wrapped.computeBirthDecade(entitiesFromYears([2000, 2000, 2000, 2000, 2000]), 2025)
    // birthYear = 2000 − 18 = 1982 → decade 1980, taste age 2025 − 1982 = 43
    expect(result).toMatchObject({ eligible: true, peakYear: 2000, decade: 1980, age: 43 })
  })
  it('lets log10 age-weighting pull the peak toward older titles', () => {
    // Equal watch time old vs new: the age multiplier makes 1980 outweigh 2024.
    const result = wrapped.computeBirthDecade(entitiesFromYears([1980, 1980, 2024, 2024, 2024]), 2025)
    expect(result.eligible).toBe(true)
    expect(result.peakYear).toBe(1980)
  })
  it('emits a decade distribution that sums to ~100%', () => {
    const result = wrapped.computeBirthDecade(entitiesFromYears([1985, 1995, 2005, 2015, 2020]), 2025)
    const sum = result.distribution.reduce((s, d) => s + d.pct, 0)
    expect(sum).toBeGreaterThanOrEqual(98)
    expect(sum).toBeLessThanOrEqual(102)
  })
})

// ── Percentiles & buddy ───────────────────────────────────────────────────────

describe('percentileOfRank', () => {
  it('maps rank to a top-X% figure', () => {
    expect(wrapped.percentileOfRank(1, 100)).toBe(1)
    expect(wrapped.percentileOfRank(1, 4)).toBe(25)
    expect(wrapped.percentileOfRank(4, 4)).toBe(100)
  })
  it('handles the single-user server without dividing by zero', () => {
    expect(wrapped.percentileOfRank(1, 1)).toBe(100)
    expect(wrapped.percentileOfRank(1, 0)).toBe(null)
  })
})

// ── Personality ───────────────────────────────────────────────────────────────

describe('computePersonality', () => {
  const base = {
    year: 2025,
    totals: { seconds: 100000, completionRate: 50, movies: { seconds: 40000 }, shows: { seconds: 60000, count: 5 } },
    time: { peakHour: 14, streak: null, bingeDay: null },
    decade: { eligible: false },
  }
  it('assigns the dominant genre-family archetype', () => {
    const p = computePersonality({ ...base, genres: [
      { name: 'Fantasy', seconds: 5000 }, { name: 'Adventure', seconds: 3000 }, { name: 'Drama', seconds: 1000 },
    ] })
    expect(p.title).toBe('The Adventurer')
    expect(p.blurb.length).toBeGreaterThan(40)
  })
  it('falls back to The Omnivore when no family dominates', () => {
    const p = computePersonality({ ...base, genres: [
      { name: 'Comedy', seconds: 1000 }, { name: 'Horror', seconds: 1000 }, { name: 'Drama', seconds: 1000 },
      { name: 'Documentary', seconds: 1000 }, { name: 'Action', seconds: 1000 },
    ] })
    expect(p.title).toBe('The Omnivore')
  })
  it('is The Omnivore with no genre data at all', () => {
    expect(computePersonality({ ...base, genres: [] }).title).toBe('The Omnivore')
  })
  it('awards Night Owl for a 11 PM peak and Completionist at 90%+', () => {
    const p = computePersonality({
      ...base,
      totals: { ...base.totals, completionRate: 95 },
      time: { ...base.time, peakHour: 23 },
      genres: [{ name: 'Horror', seconds: 5000 }],
    })
    const keys = p.traits.map((t) => t.key)
    expect(keys).toContain('night-owl')
    expect(keys).toContain('completionist')
    expect(p.title).toBe('The Thrill Seeker')
  })
  it('caps traits at 3', () => {
    const p = computePersonality({
      year: 2025,
      totals: { seconds: 100000, completionRate: 99, movies: { seconds: 90000 }, shows: { seconds: 10000, count: 1 } },
      time: { peakHour: 23, streak: { days: 10 }, bingeDay: { seconds: 30000 } },
      decade: { eligible: true, peakYear: 1980 },
      genres: [{ name: 'Comedy', seconds: 5000 }],
    })
    expect(p.traits.length).toBe(3)
  })
})

describe('pickShowBuddy', () => {
  it('returns the other user closest in watch time', () => {
    const watchers = new Map([['me', 10000], ['far', 40000], ['close', 11000]])
    expect(wrapped.pickShowBuddy('me', watchers)).toMatchObject({ userId: 'close', theirSeconds: 11000, mySeconds: 10000 })
  })
  it('returns null when nobody else watched the show', () => {
    expect(wrapped.pickShowBuddy('me', new Map([['me', 10000]]))).toBe(null)
  })
  it('returns null when the user is not among the watchers', () => {
    expect(wrapped.pickShowBuddy('ghost', new Map([['a', 1], ['b', 2]]))).toBe(null)
  })
})
