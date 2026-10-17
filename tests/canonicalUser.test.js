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

describe('linking moves Movie Night and Watch Together ownership', () => {
  it('re-keys groups, membership, personas, entries, votes, comments and parties', () => {
    db.seedKnownUser('111', 'plex', null, null)
    db.seedJellyfinUser('jf_owner', 'jelly', null)
    db.seedKnownUser('112', 'friend', null, null)

    const group = db.createMovieNightGroup({ name: 'Fridays', mode: 'rolling', createdBy: 'jf_owner' })
    db.addMovieNightMember(group.id, '112')
    const persona = db.addMovieNightPersona(group.id, 'Kids', null, 'jf_owner')
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 1, title: 'A', addedBy: 'jf_owner' })
    db.voteMovieNightEntry(entry.id, 'jf_owner', null, 1)
    db.addMovieNightComment(entry.id, 'jf_owner', 'pick this')
    const party = db.createWatchParty({ hostId: 'jf_owner', source: 'jellyfin', ratingKey: 'ep', title: 'T', durationMs: 1 })
    db.addWatchPartyMember(party.id, '112')

    db.linkJellyfinAccount('jf_owner', '111')

    expect(db.getMovieNightGroupsForUser('111').map(g => g.id)).toEqual([group.id])
    expect(db.getMovieNightGroupsForUser('jf_owner')).toEqual([])
    expect(db.isMovieNightHost(group.id, '111')).toBe(true)
    expect(db.prepare('SELECT created_by FROM movie_night_groups WHERE id = ?').get(group.id).created_by).toBe('111')
    expect(db.prepare('SELECT created_by FROM movie_night_personas WHERE id = ?').get(persona.id).created_by).toBe('111')
    expect(db.prepare('SELECT added_by FROM movie_night_entries WHERE id = ?').get(entry.id).added_by).toBe('111')
    expect(db.prepare('SELECT user_id FROM movie_night_votes WHERE entry_id = ?').all(entry.id).map(r => r.user_id)).toEqual(['111'])
    expect(db.prepare('SELECT user_id FROM movie_night_comments WHERE entry_id = ?').all(entry.id).map(r => r.user_id)).toEqual(['111'])
    expect(db.getWatchParty(party.id).host_id).toBe('111')
    expect(db.getOpenWatchPartiesForUser('111').map(p => p.id)).toEqual([party.id])
    expect(db.getWatchPartyMembers(party.id).map(m => `${m.user_id}:${m.role}`).sort()).toEqual(['111:host', '112:guest'])
  })

  it('keeps the existing membership and vote on collisions, but carries the host role over', () => {
    db.seedKnownUser('121', 'plex', null, null)
    db.seedJellyfinUser('jf_both', 'jelly', null)

    // jf_both hosts; the Plex account is already an ordinary member
    const group = db.createMovieNightGroup({ name: 'Collide', mode: 'rolling', createdBy: 'jf_both' })
    db.addMovieNightMember(group.id, '121')
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 2, title: 'B', addedBy: '121' })
    db.voteMovieNightEntry(entry.id, '121', null, 1)
    db.voteMovieNightEntry(entry.id, 'jf_both', null, -1)
    const party = db.createWatchParty({ hostId: 'jf_both', source: 'jellyfin', ratingKey: 'ep', title: 'T', durationMs: 1 })
    db.addWatchPartyMember(party.id, '121')

    db.linkJellyfinAccount('jf_both', '121')

    expect(db.prepare('SELECT user_id, role FROM movie_night_members WHERE group_id = ?').all(group.id).map(r => `${r.user_id}:${r.role}`)).toEqual(['121:host'])
    expect(db.prepare('SELECT user_id, vote FROM movie_night_votes WHERE entry_id = ?').all(entry.id).map(r => `${r.user_id}:${r.vote}`)).toEqual(['121:1'])
    expect(db.getWatchPartyMembers(party.id).map(m => `${m.user_id}:${m.role}`)).toEqual(['121:host'])
    expect(db.getWatchParty(party.id).host_id).toBe('121')
  })
})

describe('one Jellyfin account per Plex user', () => {
  it('refuses a second Jellyfin account and keeps re-linking the same pair idempotent', () => {
    db.seedKnownUser('500', 'plex', null, null)
    db.seedJellyfinUser('jf_first', 'one', null)
    db.seedJellyfinUser('jf_second', 'two', null)
    db.linkJellyfinAccount('jf_first', '500')
    expect(() => db.linkJellyfinAccount('jf_second', '500')).toThrow(/already linked/)
    expect(db.resolveCanonicalUserId('jf_second')).toBe('jf_second')
    expect(() => db.linkJellyfinAccount('jf_first', '500')).not.toThrow()
    expect(db.getLinkedJellyfinRow('500').user_id).toBe('jf_first')
    // Storage enforces it too, not only the helper
    expect(() => db.prepare("UPDATE known_users SET linked_user_id = '500' WHERE user_id = 'jf_second'").run()).toThrow()
  })

  it('repairs existing duplicate links by keeping the most recently seen account', () => {
    db.seedKnownUser('600', 'plex', null, null)
    for (const [id, seen] of [['jf_old', 10], ['jf_new', 99], ['jf_mid', 50]]) {
      db.seedJellyfinUser(id, id, null)
      db.prepare('UPDATE known_users SET seen_at = ? WHERE user_id = ?').run(seen, id)
    }
    db.prepare('DROP INDEX IF EXISTS uniq_known_users_linked_user').run()
    db.prepare("UPDATE known_users SET linked_user_id = '600' WHERE user_id IN ('jf_old', 'jf_new', 'jf_mid')").run()

    expect(db.enforceOneJellyfinLinkPerUser()).toBe(2)
    expect(db.getLinkedJellyfinRow('600').user_id).toBe('jf_new')
    expect(db.resolveCanonicalUserId('jf_old')).toBe('jf_old')
    expect(db.resolveCanonicalUserId('jf_mid')).toBe('jf_mid')
    expect(() => db.prepare("UPDATE known_users SET linked_user_id = '600' WHERE user_id = 'jf_old'").run()).toThrow()
  })
})
