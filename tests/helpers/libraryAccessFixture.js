// Shared fixture for the per-user library access suites (services/libraryAccess):
// a throwaway database holding a small library — Plex sections 1 (movies), 2
// and 10 (shows) plus two Jellyfin folders — its known users, and a scripted
// fetch answering plex.tv, the Plex server and Jellyfin, so no real server is
// ever contacted. Suites steer the script through `state`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { beforeAll, beforeEach, afterAll, vi } from 'vitest'

export const PLEX = 'http://plex.test:32400'
export const JF = 'http://jf.test'
export const F1 = 'f1'.repeat(16) // Jellyfin folder ids (32-hex "N" form)
export const F2 = 'f2'.repeat(16)
const guid = (c) => c.repeat(32)
export const JF_ALL = guid('a'), JF_ONE = guid('b'), JF_BLOCK = guid('c'), JF_KID = guid('d'), JF_OFF = guid('e')

// ── plex.tv / PMS / Jellyfin script ─────────────────────────────────────────
const section = (id, key, shared) => `<Section id="${id}" key="${key}" title="S${key}" type="movie" shared="${shared}"/>`
export const shareXml = (userID, { accepted = '1600000000', all = '0', movies = '', sections = [] } = {}) =>
  `<SharedServer id="7${userID}" username="u${userID}" userID="${userID}" accessToken="LEAKED_${userID}" acceptedAt="${accepted}" allLibraries="${all}" filterAll="" filterMovies="${movies}" filterTelevision="">`
  + sections.map(([key, shared]) => section(`11818${key}`, key, shared)).join('') + '</SharedServer>'

const USERS_XML = `<?xml version="1.0" encoding="UTF-8"?><MediaContainer friendlyName="myPlex" size="6">
  ${['100', '200', '300', '400', '800'].map(id => `<User id="${id}" title="u${id}" home="0" restricted="0" filterAll="" filterMovies="" filterTelevision=""><Server id="1" machineIdentifier="srv-machine" pending="0"/></User>`).join('')}
  <User id="600" title="homey" home="1" restricted="0" filterAll="" filterMovies="" filterTelevision=""><Server id="2" machineIdentifier="srv-machine" pending="0"/></User>
</MediaContainer>`

export function defaultShares() {
  return [
    shareXml('100', { sections: [['1', '1'], ['2', '1'], ['10', '0']] }),
    shareXml('200', { sections: [['1', '1'], ['2', '1'], ['10', '1']] }),
    shareXml('300', { movies: 'contentRating=G%2CPG', sections: [['1', '1'], ['2', '1']] }),
    shareXml('400', { accepted: '0', all: '1' }),
    shareXml('800', { all: '1' }),
  ]
}

const SERVER_TOKENS = { CAROL_PLEX: 'CAROL_SRV', HOME_PLEX: 'HOME_SRV' }
const USER_SECTIONS = { CAROL_SRV: ['1', '2'], HOME_SRV: ['2'], ADMIN_TOKEN: ['1', '2', '10'] }
// Items each server token sees per section (suites may swap a list and restore it)
export const SECTION_ITEMS = {
  ADMIN_TOKEN: { 1: ['101', '102'], 2: ['201', '202', '203'], 10: ['1001', '1002'] },
  CAROL_SRV: { 1: ['101'], 2: ['201', '202', '203'] },
  HOME_SRV: { 2: ['201', '202', '203'] },
}

export const jfUser = (id, policy) => ({ Id: id, Name: `jf-${id.slice(0, 4)}`, Policy: {
  IsAdministrator: false, IsDisabled: false, EnableAllFolders: true, EnabledFolders: [], BlockedMediaFolders: [],
  MaxParentalRating: null, BlockUnratedItems: [], BlockedTags: [], AllowedTags: [], ...policy,
} })

function defaultJfUsers() {
  return [
    jfUser(JF_ALL), jfUser(JF_ONE, { EnableAllFolders: false, EnabledFolders: [F1.toUpperCase().replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')] }),
    jfUser(JF_BLOCK, { BlockedMediaFolders: [F2] }), jfUser(JF_KID, { MaxParentalRating: 10 }), jfUser(JF_OFF, { IsDisabled: true }),
  ]
}

const json = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const xml = (body) => new Response(body, { headers: { 'Content-Type': 'application/xml' } })

/**
 * Registers the suite hooks and returns the modules plus `state`, reset before
 * each test: shares (shared_servers rows), jfUsers (GET /Users), calls (every
 * outbound request), fail (url needle → status) and gate ({ needle, promise }:
 * matching calls wait for the promise).
 */
export function setupLibraryAccessFixture() {
  // The db module resolves its data dir at require time: a throwaway one
  process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-library-access-'))
  process.env.TUBERR_MANAGED = '0'
  process.env.PLEX_SERVER_ID = 'srv-machine'

  const nodeRequire = createRequire(import.meta.url)
  const db = nodeRequire('../../server/db/database.js')
  const libraryAccess = nodeRequire('../../server/services/libraryAccess/index.js')
  const plexAccess = nodeRequire('../../server/services/libraryAccess/plex.js')
  const state = { shares: [], jfUsers: [], calls: [], fail: {}, gate: null }

  function seedLibrary() {
    const ins = db.prepare('INSERT INTO library_items (rating_key, section_id, title, year, type, tmdb_id, source) VALUES (?, ?, ?, 2020, ?, ?, ?)')
    for (const [rk, sec, title, type, tmdb, source = 'plex'] of [
      ['101', '1', 'Movie A', 'movie', '11'], ['102', '1', 'Movie B', 'movie', '12'],
      ['201', '2', 'Show A', 'show', '21'], ['202', '2', 'Show B', 'show', '22'], ['203', '2', 'Twin', 'show', '99'],
      ['1001', '10', 'Tube A', 'show', '31'], ['1002', '10', 'Twin', 'show', '99'],
      ['aaaa1111', `jf_${F1}`, 'JF Movie', 'movie', '41', 'jellyfin'],
      ['bbbb2222', `jf_${F2}`, 'JF Show', 'show', '42', 'jellyfin'],
    ]) ins.run(rk, sec, title, type, tmdb, source)
    for (const s of ['1', '2']) db.setSyncTime(`library_${s}`)
  }

  async function respond(url, opts = {}) {
    const u = new URL(url)
    const token = opts.headers?.['X-Plex-Token'] || opts.headers?.['X-Emby-Token'] || null
    state.calls.push({ url: String(url), path: u.pathname, token })
    if (state.gate && String(url).includes(state.gate.needle)) await state.gate.promise
    for (const [needle, status] of Object.entries(state.fail)) {
      if (String(url).includes(needle)) return new Response('nope', { status })
    }
    if (u.origin === 'https://plex.tv') {
      if (u.pathname === '/api/servers/srv-machine/shared_servers') {
        return xml(`<?xml version="1.0"?><MediaContainer friendlyName="myPlex" machineIdentifier="srv-machine" size="${state.shares.length}">${state.shares.join('')}</MediaContainer>`)
      }
      if (u.pathname === '/api/users') return xml(USERS_XML)
      if (u.pathname === '/api/v2/user') return json({ id: 1, username: 'owner' })
      if (u.pathname === '/api/v2/resources') {
        const srv = SERVER_TOKENS[token]
        return json(srv ? [{ clientIdentifier: 'other' }, { clientIdentifier: 'srv-machine', accessToken: srv }] : [])
      }
    }
    if (u.origin === PLEX) {
      if (u.pathname === '/library/sections') {
        return json({ MediaContainer: { Directory: (USER_SECTIONS[token] || []).map(key => ({ key, title: `S${key}`, type: key === '1' ? 'movie' : 'show' })) } })
      }
      const m = /^\/library\/sections\/(\d+)\/all$/.exec(u.pathname)
      if (m) {
        const items = SECTION_ITEMS[token]?.[m[1]] || []
        const start = Number(u.searchParams.get('X-Plex-Container-Start'))
        const size = Number(u.searchParams.get('X-Plex-Container-Size'))
        return json({ MediaContainer: { totalSize: items.length, size: Math.min(size, items.length), Metadata: items.slice(start, start + size).map(ratingKey => ({ ratingKey })) } })
      }
    }
    if (u.origin === JF) {
      if (u.pathname === '/Users') return json(state.jfUsers)
      if (u.pathname === '/Library/VirtualFolders') {
        return json([{ ItemId: F1, Name: 'Films', CollectionType: 'movies' }, { ItemId: F2, Name: 'Series', CollectionType: 'tvshows' }])
      }
      if (u.pathname === '/Items') {
        const visible = u.searchParams.get('userId') === JF_KID ? ['aaaa1111'] : []
        return json({ Items: visible.map(Id => ({ Id })), TotalRecordCount: visible.length })
      }
    }
    throw new Error(`unexpected outbound request: ${url}`)
  }

  const realFetch = globalThis.fetch
  beforeAll(() => {
    db.setSetting('plex_url', PLEX)
    db.setSetting('plex_token', 'ADMIN_TOKEN')
    db.setSetting('jellyfin_url', JF)
    db.setSetting('jellyfin_api_key', 'JF_KEY')
    db.setSetting('jellyfin_enabled', '1')
    seedLibrary()
    for (const [id, name, token] of [['1', 'owner', 'OWNER_PLEX'], ['100', 'alice', 'A'], ['200', 'bob', 'B'],
      ['300', 'carol', 'CAROL_PLEX'], ['400', 'dave', 'D'], ['500', 'erin', 'E'], ['600', 'homey', 'HOME_PLEX'], ['800', 'frank', 'F']]) {
      db.upsertKnownUser(id, name, null, token)
    }
    db.seedKnownUser('__svc_1_2__', 'svc', null, null)
    globalThis.fetch = vi.fn(respond)
  })
  afterAll(() => { globalThis.fetch = realFetch })
  beforeEach(() => {
    state.calls = []
    state.fail = {}
    state.gate = null
    state.shares = defaultShares()
    state.jfUsers = defaultJfUsers()
    plexAccess.resetBatch()
    libraryAccess.invalidate()
    db.setSetting('library_access_enforced', '1')
  })

  return {
    nodeRequire, db, libraryAccess, plexAccess, state, realFetch,
    // Known Jellyfin identities for the JF_* policies
    seedJellyfinUsers: () => {
      for (const g of [JF_ALL, JF_ONE, JF_BLOCK, JF_KID, JF_OFF]) db.seedJellyfinUser(`jf_${g}`, `jf-${g.slice(0, 4)}`, null)
    },
    // Rating keys `access` sees of one source, sorted
    keysFor: (access, source = 'plex') => db.getLibraryItemsBySource(source, null, access).map(i => i.ratingKey).sort(),
    row: (id, source = 'plex') => db.prepare('SELECT * FROM user_library_access WHERE user_id = ? AND source = ?').get(id, source),
  }
}
