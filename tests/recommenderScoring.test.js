import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

const nodeRequire = createRequire(import.meta.url)
const { scoreItem } = nodeRequire('../server/services/recommender.js')
const { scoreTmdbItem } = nodeRequire('../server/services/discoverRecommender.js')

function emptyProfile(overrides = {}) {
  return {
    genreWeights: new Map(), directorWeights: new Map(), actorWeights: new Map(),
    studioWeights: new Map(), decadeWeights: new Map(), keywordWeights: new Map(),
    keywordIdWeights: new Map(), collectionWeights: new Map(),
    tmdbSimilarMap: new Map(), plexRelatedMap: new Map(),
    interestSimilarMap: new Map(), interestPlexRelatedMap: new Map(),
    dismissalProfile: null, reviewProfile: null,
    directorTriggers: new Map(), actorTriggers: new Map(), studioTriggers: new Map(),
    ...overrides,
  }
}

function libItem(overrides = {}) {
  return {
    ratingKey: 'rk1', title: 'Test Item', year: 2000, type: 'movie',
    genres: [], directors: [], cast: [], studio: '',
    audienceRating: 0, addedAt: 0,
    ...overrides,
  }
}

const none = new Set()

describe('scoreItem (library)', () => {
  it('adds release-recency points to the score (regression: was signal-only)', () => {
    const thisYear = new Date().getFullYear()
    const fresh = scoreItem(libItem({ year: thisYear }), emptyProfile(), none, none, null)
    const old = scoreItem(libItem({ year: 2000 }), emptyProfile(), none, none, null)
    expect(fresh.score - old.score).toBeCloseTo(5, 5)
    expect(fresh.breakdown.recentReleasePts).toBe(5)
  })

  it('dampens actor-driven scores for negative-affinity categories', () => {
    const profile = emptyProfile({
      actorWeights: new Map([['Big Star', 1.0]]),
      affinity: {
        genres: new Map([['action', -3]]),
        keywords: new Map(),
        hardGenres: new Set(), hardKeywords: new Set(),
      },
    })
    const actionFlick = scoreItem(libItem({ genres: ['Action'], cast: ['Big Star'] }), profile, none, none, null)
    const drama = scoreItem(libItem({ genres: ['Drama'], cast: ['Big Star'] }), profile, none, none, null)
    // Same actor: 15 pts. Action is dampened ×0.30, drama untouched.
    expect(drama.score).toBeCloseTo(15, 1)
    expect(actionFlick.score).toBeCloseTo(15 * 0.30, 1)
    expect(actionFlick.breakdown.dampener.M).toBeCloseTo(0.30, 2)
  })

  it('scales actor points by genre context', () => {
    const profile = emptyProfile({
      actorWeights: new Map([['Drama Darling', 1.0]]),
      actorGenreCtx: new Map([['Drama Darling', new Map([['drama', 1.0]])]]),
      actorItemCount: new Map([['Drama Darling', 4]]),
    })
    const inCtx = scoreItem(libItem({ genres: ['Drama'], cast: ['Drama Darling'] }), profile, none, none, null)
    const outCtx = scoreItem(libItem({ genres: ['Action'], cast: ['Drama Darling'] }), profile, none, none, null)
    expect(inCtx.breakdown.actPts).toBeCloseTo(15, 1) // full overlap → scale 1
    expect(outCtx.breakdown.actPts).toBeCloseTo(15 * 0.35, 1) // no overlap → base scale
  })

  it('breakdown components reconstruct the score', () => {
    const profile = emptyProfile({
      actorWeights: new Map([['Big Star', 0.8]]),
      genreWeights: new Map([['Action', 1.0]]),
      affinity: {
        genres: new Map([['action', -1]]),
        keywords: new Map(),
        hardGenres: new Set(), hardKeywords: new Set(),
      },
    })
    const r = scoreItem(libItem({ genres: ['Action'], cast: ['Big Star'], audienceRating: 9.5 }), profile, none, none, null)
    const b = r.breakdown
    const positive = b.similarPts + b.plexRelatedPts + b.interestSimilarPts + b.interestPlexRelatedPts +
      b.dirPts + b.actPts + b.kwPts + b.collectionPts + b.genrePts + b.studioPts + b.decadePts +
      b.recentReleasePts + b.socialPts
    const expected = positive * b.M + b.ratingBonus + b.newBonus + b.reviewBonus - b.dismissPenalty - b.reviewPenalty
    expect(r.score).toBeCloseTo(expected, 6)
  })

  it('still hard-excludes watched and dismissed items', () => {
    const item = libItem()
    expect(scoreItem(item, emptyProfile(), new Set(['rk1']), none, null)).toBeNull()
    expect(scoreItem(item, emptyProfile(), none, new Set(['rk1']), null)).toBeNull()
  })

  it('adds social points for followee-loved titles', () => {
    const profile = emptyProfile({
      socialLovedMap: new Map([['42:movie', ['friend1']]]),
    })
    const r = scoreItem(libItem({ tmdbId: 42, year: 2000 }), profile, none, none, { tmdbId: 42, keywords: [], collection: null })
    expect(r.breakdown.socialPts).toBe(8)
    expect(r.reasons).toContain('Loved by friend1')
  })
})

describe('scoreTmdbItem (discover)', () => {
  function tmdbItem(overrides = {}) {
    return {
      tmdbId: 99, mediaType: 'movie', title: 'Candidate', year: 2000,
      genres: [], directors: [], cast: [], keywords: [], studio: '',
      voteAverage: 0, collection: null,
      ...overrides,
    }
  }

  it('applies the review profile (regression: was ignored on Explore)', () => {
    const profile = emptyProfile({
      reviewProfile: {
        positiveGenres: new Map(), positiveDirectors: new Map(), positiveActors: new Map(),
        negativeGenres: new Map([['Action', 1.0]]),
        negativeDirectors: new Map(), negativeActors: new Map(),
      },
    })
    const r = scoreTmdbItem(tmdbItem({ genres: ['Action'] }), profile)
    expect(r.breakdown.reviewPenalty).toBeCloseTo(1.5, 5)
    expect(r.score).toBeCloseTo(-1.5, 5)
  })

  it('dampens keyword-avoided candidates below actor-driven alternatives', () => {
    const profile = emptyProfile({
      actorWeights: new Map([['Big Star', 1.0]]),
      affinity: {
        genres: new Map(),
        keywords: new Map([['superhero', -2.3], ['based on comic', -2.0]]),
        hardGenres: new Set(), hardKeywords: new Set(),
      },
    })
    const capeFlick = scoreTmdbItem(tmdbItem({ cast: ['Big Star'], keywords: ['superhero', 'based on comic'] }), profile)
    const drama = scoreTmdbItem(tmdbItem({ cast: ['Big Star'] }), profile)
    // damp(-2.3)≈0.496 × damp(-2.0)=0.58 → M≈0.288
    expect(drama.score).toBeCloseTo(15, 1)
    expect(capeFlick.score).toBeLessThan(15 * 0.30)
    expect(capeFlick.breakdown.dampener.categories.map(c => c.name).sort())
      .toEqual(['based on comic', 'superhero'])
  })

  it('quiz-avoided categories floor to the hard minimum', () => {
    const profile = emptyProfile({
      actorWeights: new Map([['Big Star', 1.0]]),
      directorWeights: new Map([['Fav Director', 1.0]]),
      affinity: {
        genres: new Map(), keywords: new Map([['superhero', -2.5]]),
        hardGenres: new Set(), hardKeywords: new Set(['superhero']),
      },
    })
    const r = scoreTmdbItem(tmdbItem({ cast: ['Big Star'], directors: ['Fav Director'], keywords: ['superhero'] }), profile)
    // 15 actor + 30 director = 45 → hard-floored M can't be undercut but the
    // dampener itself is damp(-2.5)=0.44 → still above hard floor
    expect(r.breakdown.M).toBeLessThan(0.5)
    expect(r.score).toBeLessThan(45 * 0.5)
  })
})
