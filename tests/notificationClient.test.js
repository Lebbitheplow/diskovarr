import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { notificationDestination, notificationPath, opensRequestEditor } from '../src/utils/notificationRoutes'
import {
  SHARED_NOTIFICATION_TYPES, PUSHOVER_NOTIFICATION_TYPES,
  DEFAULT_AGENT_TYPES, DEFAULT_WEBHOOK_TYPES, DEFAULT_BOT_TYPES, DEFAULT_PUSHOVER_TYPES,
  normalizeTypeSelection, initialTypeSelection, isTypeOptionChecked, toggleTypeOption,
} from '../src/components/admin/notifications/constants'

// Pure server module (no db): the canonical event list the providers match on.
const nodeRequire = createRequire(import.meta.url)
const { TYPE_MAP } = nodeRequire('../server/services/notificationAgents/types.js')
const serverLinks = nodeRequire('../server/services/notificationAgents/links.js')

describe('F07 — bell click destinations', () => {
  const go = (type, data) => notificationDestination({ id: 1, type, data: data === undefined ? null : JSON.stringify(data) })

  it('keeps request_available on the queue (documented product decision)', () => {
    expect(go('request_available', { requestId: 4, tmdbId: 1, mediaType: 'movie' })).toEqual({ kind: 'navigate', path: '/queue' })
    expect(go('request_denied', { requestId: 4 })).toEqual({ kind: 'navigate', path: '/queue' })
  })

  it('a /queue?id= link opens the Edit dialog only for rows that can still be edited', () => {
    expect(opensRequestEditor({ id: 1, status: 'pending', is_follow: 0 })).toBe(true)
    expect(opensRequestEditor({ id: 1, status: 'approved', is_follow: 0, notified_available_at: null })).toBe(true)
    // Declined, already available, and notify-only rows just show the list
    expect(opensRequestEditor({ id: 1, status: 'denied', is_follow: 0 })).toBe(false)
    expect(opensRequestEditor({ id: 1, status: 'approved', is_follow: 0, notified_available_at: 1700000000 })).toBe(false)
    expect(opensRequestEditor({ id: 1, status: 'approved', is_follow: 1, notified_available_at: null })).toBe(false)
    expect(opensRequestEditor(null)).toBe(false)
  })

  it('routes every Movie Night event to its group, with a list fallback', () => {
    for (const type of ['movie_night_invite', 'movie_night_added', 'movie_night_comment', 'movie_night_tonight', 'notify_movie_night_added']) {
      expect(go(type, { groupId: 9, entryId: 3 })).toEqual({ kind: 'navigate', path: '/movie-night/9' })
    }
    expect(go('movie_night_invite', {})).toEqual({ kind: 'navigate', path: '/movie-night' })
  })

  it('routes parties, issues, monitors and admin events', () => {
    expect(go('watch_party_invite', { partyId: 5 }).path).toBe('/watch-party/5')
    expect(go('issue_comment_added_user', { issueId: 8 }).path).toBe('/issues?id=8')
    expect(go('monitor_match', { tmdbId: 7, mediaType: 'tv', title: 'Dark' }).path).toBe('/search?q=Dark&selectedTmdbId=7&selectedType=tv')
    expect(go('tuberr_alert').path).toBe('/admin#youtube')
    expect(go('deletion').path).toBe('/admin#automation')
  })

  it('opens the broadcast modal, and ignores unknown or malformed rows', () => {
    expect(go('broadcast')).toEqual({ kind: 'broadcast' })
    expect(go('something_new')).toBeNull()
    expect(notificationDestination({ id: 1, type: 'issue_new', data: '{not json' })).toEqual({ kind: 'navigate', path: '/issues' })
    expect(notificationDestination(null)).toBeNull()
  })

  it('in-app and external links agree for every non-request event', () => {
    const samples = [
      ['movie_night_comment', { groupId: 2 }], ['watch_party_invite', { partyId: 3 }], ['issue_updated', { issueId: 4 }],
      ['monitor_match', { tmdbId: 5, mediaType: 'movie', title: 'X' }], ['tuberr_alert', {}], ['deletion', {}],
    ]
    for (const [type, data] of samples) expect(notificationPath(type, data)).toBe(serverLinks.notificationPath(type, data))
  })
})

describe('F03 — provider type checkboxes', () => {
  const issueComments = SHARED_NOTIFICATION_TYPES.find(t => t.value === 'issue_comments')

  it('every option is a group of event ids the server knows', () => {
    for (const option of SHARED_NOTIFICATION_TYPES) {
      expect(option.events.length).toBeGreaterThan(0)
      for (const event of option.events) expect(TYPE_MAP[event], event).toBeTruthy()
    }
  })

  it('lists monitor matches and deletion notices for every provider (Pushover included)', () => {
    for (const list of [SHARED_NOTIFICATION_TYPES, PUSHOVER_NOTIFICATION_TYPES]) {
      const events = list.flatMap(t => t.events)
      expect(events).toContain('monitor_match')
      expect(events).toContain('deletion')
    }
  })

  it('defaults are flat canonical ids', () => {
    for (const list of [DEFAULT_AGENT_TYPES, DEFAULT_WEBHOOK_TYPES, DEFAULT_BOT_TYPES, DEFAULT_PUSHOVER_TYPES]) {
      for (const event of list) {
        expect(event).not.toContain(',')
        expect(TYPE_MAP[event], event).toBeTruthy()
      }
    }
  })

  it('ticking a group adds all its events; unticking removes them all', () => {
    const on = toggleTypeOption(['request_pending'], issueComments)
    expect(on).toEqual(['request_pending', 'issue_comment_added_admin', 'issue_comment_added_user'])
    expect(isTypeOptionChecked(on, issueComments)).toBe(true)
    expect(toggleTypeOption(on, issueComments)).toEqual(['request_pending'])
  })

  it('reads old composite selections as ticked groups', () => {
    const loaded = initialTypeSelection(['issue_comment_added_admin,issue_comment_added_user'], DEFAULT_AGENT_TYPES)
    expect(loaded).toEqual(['issue_comment_added_admin', 'issue_comment_added_user'])
    expect(isTypeOptionChecked(loaded, issueComments)).toBe(true)
    expect(initialTypeSelection([], DEFAULT_AGENT_TYPES)).toEqual(DEFAULT_AGENT_TYPES)
    expect(normalizeTypeSelection(['a,b', 'b', 3])).toEqual(['a', 'b'])
  })
})
