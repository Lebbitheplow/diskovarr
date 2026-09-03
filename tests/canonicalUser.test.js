import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-canon-'))

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')

describe('resolveCanonicalUserId', () => {
  it('is the identity for unknown and unlinked users', () => {
    expect(db.resolveCanonicalUserId('nobody')).toBe('nobody')
    expect(db.resolveCanonicalUserId(42)).toBe('42')
    db.seedKnownUser('100', 'plex-only', null, null)
    db.seedJellyfinUser('jf_solo', 'jf-only', null)
    expect(db.resolveCanonicalUserId('100')).toBe('100')
    expect(db.resolveCanonicalUserId('jf_solo')).toBe('jf_solo')
    expect(db.getKnownUserById('jf_solo')).toMatchObject({ auth_provider: 'jellyfin', linked_user_id: null })
  })

  it('follows a linked Jellyfin row to its Plex row and back after unlink', () => {
    db.seedKnownUser('200', 'plex', null, null)
    db.seedJellyfinUser('jf_linked', 'jelly', null)
    db.linkJellyfinAccount('jf_linked', '200')
    expect(db.resolveCanonicalUserId('jf_linked')).toBe('200')
    expect(db.resolveCanonicalUserId('200')).toBe('200')
    expect(db.getLinkedJellyfinRow('200')?.user_id).toBe('jf_linked')
    expect(db.getJellyfinUsers().map(u => u.user_id)).toContain('jf_linked')

    db.unlinkJellyfinAccount('jf_linked')
    expect(db.resolveCanonicalUserId('jf_linked')).toBe('jf_linked')
    expect(db.getLinkedJellyfinRow('200')).toBeNull()
  })
})

describe('linking merges per-user data', () => {
  it('re-keys rows onto the Plex id, keeps the target row on unique collisions, drops leftovers', () => {
    db.seedKnownUser('300', 'plex', null, null)
    db.seedJellyfinUser('jf_merge', 'jelly', null)

    db.addToWatchlistDb('jf_merge', 'jf-item', 'jellyfin')
    db.addToWatchlistDb('jf_merge', 'shared', 'jellyfin')
    db.addToWatchlistDb('300', 'shared', 'plex')      // collision → target row wins
    db.addToWatchlistDb('300', 'plex-item', 'plex')
    db.replaceWatchedBatch('jf_merge', ['w-1'], 'jellyfin')
    db.replaceWatchedBatch('300', ['w-2'], 'plex')
    db.upsertUserRatings('jf_merge', [{ ratingKey: 'r-1', userRating: 7.5 }, { ratingKey: 'both', userRating: 2.5 }])
    db.upsertUserRatings('300', [{ ratingKey: 'both', userRating: 9 }])
    db.upsertWatchHistoryBatch([{
      historyId: 'jf:jf_merge:m:1', userId: 'jf_merge', ratingKey: 'm', mediaType: 'movie',
      title: 'M', watchedAt: 1, source: 'jellyfin',
    }])

    db.linkJellyfinAccount('jf_merge', '300')

    expect(db.resolveCanonicalUserId('jf_merge')).toBe('300')
    expect(db.getWatchlistFromDb('300').sort()).toEqual(['jf-item', 'plex-item', 'shared'])
    expect(db.getWatchlistFromDb('jf_merge')).toEqual([])
    expect(db.getWatchlistFromDb('300', 'jellyfin')).toEqual(['jf-item']) // 'shared' kept the plex row
    expect([...db.getWatchedKeysFromDb('300')].sort()).toEqual(['w-1', 'w-2'])
    expect(db.getWatchedKeysFromDb('jf_merge').size).toBe(0)
    const ratings = db.getUserRatingsFromDb('300')
    expect(ratings.get('r-1')).toBe(7.5)
    expect(ratings.get('both')).toBe(9)
    expect(db.getUserRatingsFromDb('jf_merge').size).toBe(0)
    expect(db.prepare('SELECT user_id FROM watch_history WHERE history_id = ?').get('jf:jf_merge:m:1').user_id).toBe('300')
  })

  it('a second link to a different Plex id re-points and merges again', () => {
    db.seedKnownUser('400', 'plex-a', null, null)
    db.seedKnownUser('401', 'plex-b', null, null)
    db.seedJellyfinUser('jf_move', 'jelly', null)
    db.addToWatchlistDb('jf_move', 'x', 'jellyfin')
    db.linkJellyfinAccount('jf_move', '400')
    expect(db.getWatchlistFromDb('400')).toEqual(['x'])
    // Data already lives on 400; re-linking to 401 only moves rows still keyed on the jf id.
    db.addToWatchlistDb('jf_move', 'y', 'jellyfin')
    db.linkJellyfinAccount('jf_move', '401')
    expect(db.resolveCanonicalUserId('jf_move')).toBe('401')
    expect(db.getWatchlistFromDb('401')).toEqual(['y'])
    expect(db.getWatchlistFromDb('400')).toEqual(['x'])
  })
})
