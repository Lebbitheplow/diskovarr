import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Movie Night: shared watch lists with +1/-1 votes (persona-aware), weekday
// themes, and the round-robin rotation cursor that picks "next up".
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-movie-night-test-'))
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const movieNight = nodeRequire('../server/services/movieNight.js')

beforeAll(() => {
  db.prepare("INSERT INTO known_users (user_id, username) VALUES ('u1','alice'),('u2','bob'),('u3','carol')").run()
})

function freshGroup({ mode = 'rolling', createdBy = 'u1', rotateMode = 0 } = {}) {
  const group = db.createMovieNightGroup({ name: `Night ${Date.now()}${Math.random()}`, mode, createdBy, rotateMode })
  db.addMovieNightMember(group.id, 'u2')
  return group
}

describe('group membership', () => {
  it('makes the creator host and keeps hosts removable-proof', () => {
    const group = freshGroup()
    expect(db.isMovieNightMember(group.id, 'u1')).toBe(true)
    expect(db.isMovieNightHost(group.id, 'u1')).toBe(true)
    expect(db.isMovieNightHost(group.id, 'u2')).toBe(false)
    expect(db.isMovieNightMember(group.id, 'u3')).toBe(false)
    // Hosts cannot be dropped, so a group is never left ownerless.
    db.removeMovieNightMember(group.id, 'u1')
    expect(db.isMovieNightHost(group.id, 'u1')).toBe(true)
    db.removeMovieNightMember(group.id, 'u2')
    expect(db.isMovieNightMember(group.id, 'u2')).toBe(false)
  })

  it('lists groups only for their members', () => {
    const group = freshGroup()
    expect(db.getMovieNightGroupsForUser('u1').map(g => g.id)).toContain(group.id)
    expect(db.getMovieNightGroupsForUser('u2').map(g => g.id)).toContain(group.id)
    expect(db.getMovieNightGroupsForUser('u3')).toEqual([])
  })
})

describe('entry dedupe', () => {
  it('returns the existing active entry instead of duplicating a title', () => {
    const group = freshGroup()
    const first = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 550, title: 'Fight Club', year: 1999, addedBy: 'u1' })
    const second = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 550, title: 'Fight Club', year: 1999, addedBy: 'u2' })
    expect(first.deduped).toBe(false)
    expect(second.deduped).toBe(true)
    expect(second.entry.id).toBe(first.entry.id)
    // A cancelled entry does not block re-adding the same title.
    db.setMovieNightEntryStatus(first.entry.id, 'cancelled')
    const third = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 550, title: 'Fight Club', year: 1999, addedBy: 'u1' })
    expect(third.deduped).toBe(false)
    expect(third.entry.id).not.toBe(first.entry.id)
  })

  it('treats the same tmdb id in the other media type as a different title', () => {
    const group = freshGroup()
    const movie = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 550, title: 'Fight Club', addedBy: 'u1' })
    const show = db.addMovieNightEntry({ groupId: group.id, mediaType: 'tv', tmdbId: 550, title: 'Fight Club Club', addedBy: 'u1' })
    expect(show.entry.id).not.toBe(movie.entry.id)
  })
})

describe('votes', () => {
  it('tallies +1/-1 across users and toggles the same vote off', () => {
    const group = freshGroup()
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 1, title: 'A', addedBy: 'u1' })
    expect(db.voteMovieNightEntry(entry.id, 'u1', null, 1)).toBe(1)
    expect(db.voteMovieNightEntry(entry.id, 'u2', null, 1)).toBe(2)
    expect(db.voteMovieNightEntry(entry.id, 'u1', null, -1)).toBe(0) // flip
    expect(db.voteMovieNightEntry(entry.id, 'u2', null, 1)).toBe(-1) // same vote removes
    expect(db.voteMovieNightEntry(entry.id, 'u1', null, 0)).toBe(0)  // explicit clear
  })

  it('keeps persona votes separate from the casting user', () => {
    const group = freshGroup()
    const kid = db.addMovieNightPersona(group.id, 'Kids', '🧒', 'u1')
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 2, title: 'B', addedBy: 'u1' })
    expect(db.voteMovieNightEntry(entry.id, 'u1', null, 1)).toBe(1)
    expect(db.voteMovieNightEntry(entry.id, 'u1', kid.id, -1)).toBe(0)
    expect(db.voteMovieNightEntry(entry.id, 'u1', kid.id, 1)).toBe(2) // flips the persona, not the user
    const votes = db.prepare('SELECT user_id, persona_id, vote FROM movie_night_votes WHERE entry_id = ?').all(entry.id)
    expect(votes).toHaveLength(2)
    expect(votes.find(v => v.persona_id === kid.id).vote).toBe(1)
  })

  it('reports the caller vote and net tally with comments count', () => {
    const group = freshGroup()
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 3, title: 'C', addedBy: 'u1', thumb: '/p.jpg' })
    db.voteMovieNightEntry(entry.id, 'u2', null, 1)
    db.addMovieNightComment(entry.id, 'u2', 'watch it')
    const [row] = db.getMovieNightEntries(group.id, { userId: 'u1' })
    expect(row.net_votes).toBe(1)
    expect(row.user_vote).toBeNull()
    expect(row.comment_count).toBe(1)
    expect(row.added_by_username).toBe('alice')
    const [asBob] = db.getMovieNightEntries(group.id, { userId: 'u2' })
    expect(asBob.user_vote).toBe(1)
  })

  it('sorts by net votes then earliest added, and hides cancelled from the default list', () => {
    const group = freshGroup()
    const low = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 10, title: 'Low', addedBy: 'u1' }).entry
    const high = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 11, title: 'High', addedBy: 'u1' }).entry
    db.voteMovieNightEntry(high.id, 'u1', null, 1)
    db.voteMovieNightEntry(high.id, 'u2', null, 1)
    db.setMovieNightEntryStatus(low.id, 'watched')
    expect(db.getMovieNightEntries(group.id, { userId: 'u1' }).map(e => e.title)).toEqual(['High'])
    expect(db.getMovieNightEntries(group.id, { userId: 'u1', status: 'all' }).map(e => e.title)).toEqual(['High', 'Low'])
  })
})

describe('rotation', () => {
  it('orders members before personas, stably', () => {
    const group = freshGroup()
    const kid = db.addMovieNightPersona(group.id, 'Kids', '🧒', 'u1')
    const identities = db.getMovieNightIdentities(group.id)
    expect(identities.map(i => [i.kind, i.id])).toEqual([['user', 'u1'], ['user', 'u2'], ['persona', kid.id]])
  })

  it('picks the cursor identity top entry and advances the cursor', () => {
    const group = freshGroup({ rotateMode: 1 })
    const kid = db.addMovieNightPersona(group.id, 'Kids', '🧒', 'u1')
    const aliceLow = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 20, title: 'Alice low', addedBy: 'u1' }).entry
    const aliceHigh = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 21, title: 'Alice high', addedBy: 'u1' }).entry
    db.voteMovieNightEntry(aliceHigh.id, 'u2', null, 1)
    db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 22, title: 'Kids pick', addedBy: 'u1', personaId: kid.id }).entry

    let next = db.getMovieNightNextPick(group.id)
    expect(next.identity.id).toBe('u1')
    expect(next.entry.title).toBe('Alice high') // top-voted among the cursor identity's entries
    expect(next.fallback).toBe(false)

    db.bumpRotationCursor(group.id)
    next = db.getMovieNightNextPick(group.id)
    expect(next.identity.id).toBe('u2')
    // bob queued nothing → falls through to the group-wide top pick
    expect(next.entry.title).toBe('Alice high')
    expect(next.fallback).toBe(true)

    db.bumpRotationCursor(group.id)
    next = db.getMovieNightNextPick(group.id)
    expect(next.identity.kind).toBe('persona')
    expect(next.entry.title).toBe('Kids pick')

    // wraps back to the first member
    db.bumpRotationCursor(group.id)
    expect(db.getMovieNightNextPick(group.id).identity.id).toBe('u1')
    expect(aliceLow.id).toBeTruthy()
  })

  it('breaks ties by earliest added and survives an empty list', () => {
    const identities = [{ kind: 'user', id: 'u1', name: 'alice' }, { kind: 'user', id: 'u2', name: 'bob' }]
    const entries = [
      { id: 2, added_by: 'u2', persona_id: null, net_votes: 1, added_at: 200 },
      { id: 1, added_by: 'u1', persona_id: null, net_votes: 1, added_at: 100 },
    ]
    const pick = movieNight.resolveNextPick ? movieNight.resolveNextPick(identities, 0, entries) : db.resolveMovieNightNextPick(identities, 0, entries)
    expect(pick.entry.id).toBe(1)
    expect(pick.fallback).toBe(false)
    expect(db.resolveMovieNightNextPick(identities, 1, [])).toEqual({ identity: identities[1], entry: null, fallback: false })
  })
})

describe('themes', () => {
  it('looks a pinned theme up by weekday and ignores pool themes', () => {
    const group = freshGroup({ mode: 'recurring' })
    db.addMovieNightTheme(group.id, { weekday: 5, name: 'Horror Friday', genreFilter: 'Horror' })
    db.addMovieNightTheme(group.id, { weekday: null, name: 'Pool' })
    expect(db.getTonightMovieNightTheme(group.id, 5).name).toBe('Horror Friday')
    expect(db.getTonightMovieNightTheme(group.id, 6)).toBeNull()
    const pool = db.getMovieNightThemes(group.id).find(th => th.name === 'Pool')
    expect(pool.weekday).toBeNull()
  })

  it('deactivating a theme removes it from tonight', () => {
    const group = freshGroup({ mode: 'recurring' })
    const theme = db.addMovieNightTheme(group.id, { weekday: 0, name: 'Sunday specials' })
    expect(db.getTonightMovieNightTheme(group.id, 0)).toBeTruthy()
    db.updateMovieNightTheme(theme.id, { active: false })
    expect(db.getTonightMovieNightTheme(group.id, 0)).toBeNull()
  })
})

describe('nightly reminders', () => {
  it('collects recurring groups whose theme is today and scheduled ones starting soon', () => {
    const recurring = freshGroup({ mode: 'recurring' })
    const scheduled = freshGroup({ mode: 'scheduled' })
    const rolling = freshGroup({ mode: 'rolling' })
    const now = new Date()
    db.addMovieNightTheme(recurring.id, { weekday: now.getDay(), name: 'Tonight' })
    db.updateMovieNightGroup(scheduled.id, { eventAt: Math.floor(now.getTime() / 1000) + 600 })
    const ids = movieNight.getTonightGroups(now).map(n => n.group.id)
    expect(ids).toEqual(expect.arrayContaining([recurring.id, scheduled.id]))
    expect(ids).not.toContain(rolling.id)
  })

  it('sends one reminder per member per night and dedupes re-runs', () => {
    const group = freshGroup({ mode: 'recurring' })
    const now = new Date()
    db.addMovieNightTheme(group.id, { weekday: now.getDay(), name: 'Tonight' })
    movieNight.runNightReminders(now) // flush groups left over from earlier tests
    db.prepare("DELETE FROM notifications WHERE type = 'movie_night_tonight' AND data LIKE ?")
      .run(`%"groupId":${group.id}%`)
    const first = movieNight.runNightReminders(now)
    const rows = db.prepare("SELECT * FROM notifications WHERE type = 'movie_night_tonight' AND data LIKE ?").all(`%"groupId":${group.id}%`)
    expect(rows.length).toBe(2) // alice + bob
    expect(rows.every(r => r.bundle_key)).toBe(true)
    const second = movieNight.runNightReminders(now)
    const after = db.prepare("SELECT * FROM notifications WHERE type = 'movie_night_tonight' AND data LIKE ?").all(`%"groupId":${group.id}%`)
    expect(after.length).toBe(rows.length)
    expect(second.sent).toBe(0)
    expect(first.sent).toBe(2)
  })
})

describe('comments', () => {
  it('attributes comments to a persona when given one', () => {
    const group = freshGroup()
    const kid = db.addMovieNightPersona(group.id, 'Kids', '🧒', 'u1')
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 30, title: 'D', addedBy: 'u2' })
    const byPersona = db.addMovieNightComment(entry.id, 'u1', 'we want this one', kid.id)
    expect(byPersona.persona_id).toBe(kid.id)
    const [row] = db.getMovieNightComments(entry.id)
    expect(row.persona_name).toBe('Kids')
    expect(row.username).toBe('alice')
    db.deleteMovieNightComment(byPersona.id)
    expect(db.getMovieNightComments(entry.id)).toEqual([])
  })

  it('deletes a group and everything under it', () => {
    const group = freshGroup()
    const { entry } = db.addMovieNightEntry({ groupId: group.id, mediaType: 'movie', tmdbId: 40, title: 'E', addedBy: 'u1' })
    db.voteMovieNightEntry(entry.id, 'u1', null, 1)
    db.addMovieNightComment(entry.id, 'u1', 'nice')
    db.addMovieNightTheme(group.id, { weekday: 3, name: 'Wednesday' })
    db.deleteMovieNightGroup(group.id)
    expect(db.getMovieNightGroup(group.id)).toBeNull()
    expect(db.getMovieNightEntry(entry.id)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) c FROM movie_night_votes WHERE entry_id = ?').get(entry.id).c).toBe(0)
    expect(db.getMovieNightThemes(group.id)).toEqual([])
  })
})
