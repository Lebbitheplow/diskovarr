import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
// affinity.js is pure — no db import — safe to load directly.
const affinity = nodeRequire('../server/services/recommend/affinity.js')
const C = nodeRequire('../server/services/recommend/constants.js')

describe('genre/keyword normalization', () => {
  it('splits combined TMDB genres and applies aliases', () => {
    expect(affinity.normalizeGenre('Sci-Fi & Fantasy')).toEqual(['science fiction', 'fantasy'])
    expect(affinity.normalizeGenre('Action & Adventure')).toEqual(['action', 'adventure'])
    expect(affinity.normalizeGenre('Drama')).toEqual(['drama'])
  })

  it('deduplicates normalized sets', () => {
    const set = affinity.normalizedGenreSet(['Sci-Fi & Fantasy', 'Science Fiction'])
    expect([...set].sort()).toEqual(['fantasy', 'science fiction'])
  })
})

describe('signedAffinity + damp', () => {
  it('computes the log2 ratio with smoothing', () => {
    // u=0, b=0.05 → log2(0.02/0.07) ≈ -1.807
    expect(affinity.signedAffinity(0, 0.05)).toBeCloseTo(-1.807, 2)
    // over-watched category is positive
    expect(affinity.signedAffinity(0.5, 0.1)).toBeGreaterThan(1)
  })

  it('clamps to ±3', () => {
    expect(affinity.signedAffinity(0, 10)).toBe(-3)
    expect(affinity.signedAffinity(10, 0)).toBe(3)
  })

  it('damp ramp matches the documented values', () => {
    expect(affinity.damp(0)).toBe(1)
    expect(affinity.damp(-0.5)).toBe(1)
    expect(affinity.damp(-1)).toBeCloseTo(0.86, 5)
    expect(affinity.damp(-2)).toBeCloseTo(0.58, 5)
    expect(affinity.damp(-3)).toBeCloseTo(0.30, 5)
  })
})

function makeProfile(overrides = {}) {
  return {
    normGenreWatchWeights: new Map(),
    normKeywordWatchWeights: new Map(),
    totalWatchWeight: 0,
    totalKeywordWatchWeight: 0,
    watchedItemCount: 0,
    keywordItemCount: 0,
    dismissCategoryCounts: { genres: new Map(), keywords: new Map() },
    ...overrides,
  }
}

describe('computeAffinities', () => {
  const baseline = {
    genres: new Map([['action', 0.5], ['drama', 0.3]]),
    keywords: new Map([['superhero', 0.10]]),
    count: 100,
  }

  it('produces signed affinities for watched vs baseline distributions', () => {
    const profile = makeProfile({
      normGenreWatchWeights: new Map([['action', 30], ['drama', 70]]),
      totalWatchWeight: 100,
      watchedItemCount: 50,
      totalKeywordWatchWeight: 80,
      keywordItemCount: 40,
    })
    const a = affinity.computeAffinities(profile, baseline)
    expect(a.genres.get('action')).toBeCloseTo(-0.70, 1)   // under-watched
    expect(a.genres.get('drama')).toBeCloseTo(1.17, 1)     // over-watched
    expect(a.keywords.get('superhero')).toBeCloseTo(-2.585, 2) // never watched
  })

  it('suppresses negatives for cold users (confidence gate)', () => {
    const profile = makeProfile({
      normGenreWatchWeights: new Map([['drama', 5]]),
      totalWatchWeight: 5,
      watchedItemCount: 3, // < MIN_WATCHED_ITEMS
      keywordItemCount: 3,
    })
    const a = affinity.computeAffinities(profile, baseline)
    expect(a.genres.get('action') || 0).toBeGreaterThanOrEqual(0)
    expect(a.keywords.get('superhero') || 0).toBeGreaterThanOrEqual(0)
  })

  it('reinforces negatives from dismissals', () => {
    const profile = makeProfile({
      normGenreWatchWeights: new Map([['action', 30], ['drama', 70]]),
      totalWatchWeight: 100,
      watchedItemCount: 50,
      totalKeywordWatchWeight: 80,
      keywordItemCount: 40,
      dismissCategoryCounts: { genres: new Map(), keywords: new Map([['superhero', 3]]) },
    })
    const a = affinity.computeAffinities(profile, baseline)
    expect(a.keywords.get('superhero')).toBe(-3) // -2.585 - 1.5 clamped to -3
  })

  it('quiz avoid forces a hard cap; quiz love forces a floor', () => {
    const profile = makeProfile({
      normGenreWatchWeights: new Map([['action', 90]]),
      totalWatchWeight: 100,
      watchedItemCount: 50,
      tasteAvoid: { genres: new Set(['action']), keywords: new Set() },
      tasteLove: { genres: new Set(['drama']), keywords: new Set() },
    })
    const a = affinity.computeAffinities(profile, baseline)
    expect(a.genres.get('action')).toBeLessThanOrEqual(C.TASTE_AVOID_AFFINITY_CAP)
    expect(a.hardGenres.has('action')).toBe(true)
    expect(a.genres.get('drama')).toBeGreaterThanOrEqual(C.TASTE_LOVE_AFFINITY_FLOOR)
  })
})

describe('itemDampener', () => {
  const affinities = {
    genres: new Map([['action', -0.7], ['drama', 1.0]]),
    keywords: new Map([['superhero', -3]]),
    hardGenres: new Set(),
    hardKeywords: new Set(),
  }

  it('multiplies negative-affinity category dampeners', () => {
    const { M } = affinity.itemDampener(['Action'], ['superhero'], affinities)
    // damp(-0.7)=0.944, damp(-3)=0.30 → 0.2832 (above floor 0.25)
    expect(M).toBeCloseTo(0.283, 2)
  })

  it('ignores positive affinities and unknown categories', () => {
    const { M, matched } = affinity.itemDampener(['Drama', 'Western'], [], affinities)
    expect(M).toBe(1)
    expect(matched).toEqual([])
  })

  it('applies the soft floor, and the hard floor for quiz avoids', () => {
    const many = {
      genres: new Map([['action', -3], ['thriller', -3], ['crime', -3]]),
      keywords: new Map(),
      hardGenres: new Set(),
      hardKeywords: new Set(),
    }
    expect(affinity.itemDampener(['Action', 'Thriller', 'Crime'], [], many).M).toBe(C.DAMP_FLOOR)
    many.hardGenres.add('action')
    expect(affinity.itemDampener(['Action', 'Thriller', 'Crime'], [], many).M).toBe(C.DAMP_FLOOR_HARD)
  })
})

describe('actorContextScale', () => {
  const ctx = new Map([['Some Actor', new Map([['drama', 0.8], ['action', 0.1]])]])
  const counts = new Map([['Some Actor', 5]])

  it('scales down out-of-context genres', () => {
    // overlap 0.1 → 0.35 + 0.65*0.1 = 0.415
    expect(affinity.actorContextScale('Some Actor', ['Action'], ctx, counts)).toBeCloseTo(0.415, 3)
  })

  it('gives full credit in-context', () => {
    // overlap 0.9 → 0.35 + 0.585 = 0.935
    expect(affinity.actorContextScale('Some Actor', ['Drama', 'Action'], ctx, counts)).toBeCloseTo(0.935, 3)
  })

  it('skips scaling for rarely-seen actors and unknown actors', () => {
    const few = new Map([['Some Actor', 1]])
    expect(affinity.actorContextScale('Some Actor', ['Action'], ctx, few)).toBe(1)
    expect(affinity.actorContextScale('Unknown', ['Action'], ctx, counts)).toBe(1)
  })
})
