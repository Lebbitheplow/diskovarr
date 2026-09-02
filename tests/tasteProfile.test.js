import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

const nodeRequire = createRequire(import.meta.url)
const { expandTaste, applyTastePriors, buildTasteOnlyProfile } = nodeRequire('../server/services/recommend/tasteProfile.js')
const C = nodeRequire('../server/services/recommend/constants.js')

describe('expandTaste', () => {
  it('expands mood rows via tasteConstants', () => {
    const t = expandTaste([{ kind: 'mood', sentiment: 'avoid', entity_id: 'superhero-fatigue', entity_name: 'superhero-fatigue' }])
    expect(t.avoidKeywords.has('superhero')).toBe(true)
    expect(t.avoidKeywords.has('based on comic')).toBe(true)
  })

  it('normalizes genre names and separates sentiments', () => {
    const t = expandTaste([
      { kind: 'genre', sentiment: 'love', entity_name: 'Science Fiction' },
      { kind: 'genre', sentiment: 'avoid', entity_name: 'Horror' },
      { kind: 'person', sentiment: 'love', entity_name: 'Greta Gerwig' },
      { kind: 'title', sentiment: 'love', entity_id: '27205', entity_name: 'Inception', media_type: 'movie' },
    ])
    expect(t.loveGenres.has('science fiction')).toBe(true)
    expect(t.avoidGenres.has('horror')).toBe(true)
    expect(t.lovePeople).toEqual(['Greta Gerwig'])
    expect(t.loveTitles).toEqual([{ tmdbId: 27205, mediaType: 'movie', title: 'Inception' }])
  })

  it('avoid wins when a category is both loved and avoided', () => {
    const t = expandTaste([
      { kind: 'genre', sentiment: 'love', entity_name: 'Horror' },
      { kind: 'genre', sentiment: 'avoid', entity_name: 'Horror' },
    ])
    expect(t.loveGenres.has('horror')).toBe(false)
    expect(t.avoidGenres.has('horror')).toBe(true)
  })
})

describe('applyTastePriors', () => {
  function profileFixture() {
    return {
      genreWeights: new Map([['Comedy', 0.2], ['Horror', 0.9]]),
      actorWeights: new Map([['Existing Actor', 0.3]]),
      directorWeights: new Map(),
      keywordWeights: new Map(),
    }
  }

  it('floors loved genres on existing display-cased keys', () => {
    const taste = expandTaste([{ kind: 'genre', sentiment: 'love', entity_name: 'Comedy' }])
    const p = applyTastePriors(profileFixture(), taste)
    expect(p.genreWeights.get('Comedy')).toBe(C.TASTE_LOVE_GENRE_WEIGHT)
  })

  it('floors loved people in both actor and director maps', () => {
    const taste = expandTaste([{ kind: 'person', sentiment: 'love', entity_name: 'New Fave' }])
    const p = applyTastePriors(profileFixture(), taste)
    expect(p.actorWeights.get('New Fave')).toBe(C.TASTE_LOVE_PERSON_WEIGHT)
    expect(p.directorWeights.get('New Fave')).toBe(C.TASTE_LOVE_PERSON_WEIGHT)
    expect(p.tastePeople.has('New Fave')).toBe(true)
  })

  it('attaches tasteAvoid for the affinity model without touching weights', () => {
    const taste = expandTaste([{ kind: 'genre', sentiment: 'avoid', entity_name: 'Horror' }])
    const p = applyTastePriors(profileFixture(), taste)
    expect(p.tasteAvoid.genres.has('horror')).toBe(true)
    // avoid does not zero the weight map — the dampener handles suppression
    expect(p.genreWeights.get('Horror')).toBe(0.9)
  })
})

describe('buildTasteOnlyProfile (cold start)', () => {
  it('returns a scorer-compatible profile from quiz data alone', async () => {
    const taste = expandTaste([
      { kind: 'genre', sentiment: 'love', entity_name: 'Comedy' },
      { kind: 'genre', sentiment: 'avoid', entity_name: 'Horror' },
      { kind: 'person', sentiment: 'love', entity_name: 'Some Person' },
    ])
    const p = await buildTasteOnlyProfile(taste)
    // Shape parity with buildPreferenceProfile
    for (const key of ['genreWeights', 'directorWeights', 'actorWeights', 'studioWeights',
      'decadeWeights', 'keywordWeights', 'collectionWeights', 'tmdbSimilarMap',
      'plexRelatedMap', 'interestSimilarMap', 'interestPlexRelatedMap',
      'directorTriggers', 'actorTriggers', 'studioTriggers']) {
      expect(p[key]).toBeInstanceOf(Map)
    }
    expect(p.dismissalProfile.genreWeights).toBeInstanceOf(Map)
    expect(p.isTasteOnly).toBe(true)
    expect(p.actorWeights.get('Some Person')).toBe(C.TASTE_LOVE_PERSON_WEIGHT)
    expect(p.tasteAvoid.genres.has('horror')).toBe(true)
  })
})
