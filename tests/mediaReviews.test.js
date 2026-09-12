import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Reviews tab on the item detail modal: server reviews for one title (privacy
// aware) and TMDB review normalisation.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-media-reviews-test-'))
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const tmdb = nodeRequire('../server/services/tmdb.js')

describe('db.getReviewsForMedia', () => {
  beforeAll(() => {
    db.prepare("INSERT INTO known_users (user_id, username) VALUES ('u1','alice'),('u2','bob'),('u3','carol')").run()
    db.prepare("INSERT INTO user_request_limits (user_id, review_privacy) VALUES ('u2','private')").run()
    const ins = db.prepare("INSERT INTO reviews (user_id, media_type, tmdb_id, title, rating, review_text, watched_date, created_at) VALUES (?,?,?,?,?,?,?,?)")
    ins.run('u1', 'movie', 550, 'Fight Club', 4.5, 'great', 1, 100)
    ins.run('u2', 'movie', 550, 'Fight Club', 2.0, 'private opinion', 1, 200)
    ins.run('u3', 'movie', 550, 'Fight Club', 5.0, 'masterpiece', 1, 300)
    ins.run('u1', 'tv', 550, 'Not the same', 3.0, 'different media type', 1, 400)
    ins.run('u1', 'movie', 551, 'Other movie', 3.0, 'other', 1, 500)
  })

  it('returns public reviews of that title newest first, keyed by media type', () => {
    const rows = db.getReviewsForMedia('movie', 550, 'u3')
    expect(rows.map(r => r.user_id)).toEqual(['u3', 'u1'])
    expect(rows[0].username).toBe('carol')
  })

  it('includes the viewer’s own private review but nobody else’s', () => {
    const own = db.getReviewsForMedia('movie', 550, 'u2')
    expect(own.map(r => r.user_id)).toEqual(['u3', 'u2', 'u1'])
    const other = db.getReviewsForMedia('movie', 550, 'u1')
    expect(other.some(r => r.user_id === 'u2')).toBe(false)
  })

  it('returns nothing for an unreviewed title', () => {
    expect(db.getReviewsForMedia('tv', 999, 'u1')).toEqual([])
  })
})

describe('tmdb.normalizeReview', () => {
  it('maps TMDB’s shape, avatar variants and 0-10 rating', () => {
    const r = tmdb.normalizeReview({
      id: 'abc', author: 'Someone', content: 'Loved it', created_at: '2024-01-02T03:04:05.000Z', url: 'https://www.themoviedb.org/review/abc',
      author_details: { username: 'someone', rating: 8, avatar_path: '/xyz.jpg' },
    })
    expect(r).toEqual({
      id: 'abc', author: 'someone', avatar: 'https://image.tmdb.org/t/p/w64_and_h64_face/xyz.jpg', rating: 8,
      content: 'Loved it', createdAt: '2024-01-02T03:04:05.000Z', url: 'https://www.themoviedb.org/review/abc',
    })
    const gravatar = tmdb.normalizeReview({ id: 'g', author: 'G', author_details: { avatar_path: '/https://www.gravatar.com/avatar/1.jpg', rating: null } })
    expect(gravatar.avatar).toBe('https://www.gravatar.com/avatar/1.jpg')
    expect(gravatar.rating).toBeNull()
    expect(gravatar.url).toBe('https://www.themoviedb.org/review/g')
    expect(gravatar.content).toBe('')
  })
})
