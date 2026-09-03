import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Diskovarr-side Tuberr integration: TVDB-aware request fulfillment, Sonarr
// wiring verification, health-check alerting, child-process supervisor state.
// The db module runs migrations at require time — point it at a scratch dir.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-tuberr-test-'))
process.env.DISKOVARR_DATA_DIR = DATA_DIR
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const tuberr = nodeRequire('../server/services/tuberr.js')
const tuberrHealth = nodeRequire('../server/services/tuberrHealth.js')
const tuberrProcess = nodeRequire('../server/services/tuberrProcess.js')
const { DatabaseSync } = nodeRequire('node:sqlite')

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    for (const [needle, body] of Object.entries(routes)) {
      if (u.includes(needle)) return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
  }
}

describe('request fulfillment by TVDB id', () => {
  beforeAll(() => {
    const raw = new DatabaseSync(path.join(DATA_DIR, 'diskovarr.db'))
    raw.prepare("INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id, tvdb_id) VALUES ('100','10','Digital Circus','show',NULL,'440853')").run()
    raw.prepare("INSERT INTO library_items (rating_key, section_id, title, type, tmdb_id, tvdb_id) VALUES ('101','1','Some Movie','movie','555',NULL)").run()
    raw.prepare("INSERT INTO discover_requests (user_id, tmdb_id, media_type, title, service, status, tvdb_id, downloader) VALUES ('u1', 0, 'tv', 'Digital Circus', 'sonarr', 'approved', 440853, 'youtube')").run()
    raw.prepare("INSERT INTO discover_requests (user_id, tmdb_id, media_type, title, service, status) VALUES ('u1', 555, 'movie', 'Some Movie', 'radarr', 'approved')").run()
    raw.prepare("INSERT INTO discover_requests (user_id, tmdb_id, media_type, title, service, status, tvdb_id) VALUES ('u1', 0, 'tv', 'Missing Show', 'sonarr', 'approved', 999)").run()
    raw.close()
  })

  it('getLibraryTvdbKeys only returns shows with a tvdb id', () => {
    expect([...db.getLibraryTvdbKeys()]).toEqual(['440853:tv'])
  })

  it('requestIsInLibrary matches by tmdb or tvdb', () => {
    const tmdb = db.getLibraryTmdbKeys()
    const tvdb = db.getLibraryTvdbKeys()
    expect(db.requestIsInLibrary({ tmdb_id: 0, tvdb_id: 440853, media_type: 'tv' }, tmdb, tvdb)).toBe(true)
    expect(db.requestIsInLibrary({ tmdb_id: 555, tvdb_id: null, media_type: 'movie' }, tmdb, tvdb)).toBe(true)
    expect(db.requestIsInLibrary({ tmdb_id: 0, tvdb_id: 999, media_type: 'tv' }, tmdb, tvdb)).toBe(false)
    expect(db.requestIsInLibrary({ tmdb_id: 0, tvdb_id: 440853, media_type: 'movie' }, tmdb, tvdb)).toBe(false)
  })

  it('getUnnotifiedFulfilledRequests includes TVDB-only YouTube requests', () => {
    const titles = db.getUnnotifiedFulfilledRequests().map(r => r.title).sort()
    expect(titles).toEqual(['Digital Circus', 'Some Movie'])
  })
})

describe('verifySonarrWiring', () => {
  beforeAll(() => {
    db.setSetting('sonarr_url', 'http://sonarr:8989')
    db.setSetting('sonarr_api_key', 'sk')
    db.setSetting('tuberr_url', 'http://192.168.1.27:9832')
    db.setSetting('tuberr_api_key', 'tk')
  })

  const goodIndexer = { id: 7, name: 'Tuberr (YouTube)', enableRss: true, enableAutomaticSearch: true, downloadClientId: 5,
    fields: [{ name: 'baseUrl', value: 'http://192.168.1.27:9832/torznab' }, { name: 'apiKey', value: 'tk' }] }
  const goodClient = { id: 5, name: 'Tuberr (YouTube)', enable: true, fields: [{ name: 'host', value: '192.168.1.27' }, { name: 'port', value: 9832 }] }

  it('reports ok when indexer and client match the configured address/key', async () => {
    mockFetch({ '/api/v3/indexer': [goodIndexer], '/api/v3/downloadclient': [goodClient] })
    const r = await tuberr.verifySonarrWiring()
    expect(r).toMatchObject({ ok: true, indexer: true, downloadClient: true })
  })

  it('flags a stale API key and a missing download client', async () => {
    mockFetch({ '/api/v3/indexer': [{ ...goodIndexer, fields: [goodIndexer.fields[0], { name: 'apiKey', value: 'old' }] }], '/api/v3/downloadclient': [] })
    const r = await tuberr.verifySonarrWiring()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/API key is stale/)
    expect(r.message).toMatch(/download client missing/)
  })
})

describe('tuberrHealth.check', () => {
  it('is quiet when the integration is disabled', async () => {
    db.setSetting('youtube_enabled', '0')
    const s = await tuberrHealth.check({ force: true })
    expect(s.enabled).toBe(false)
    expect(s.alerts).toEqual([])
  })

  it('surfaces unreachable Tuberr and unhealthy fields as alerts', async () => {
    db.setSetting('youtube_enabled', '1')
    db.setSetting('tuberr_auto_wire', '0')
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED') }
    const s = await tuberrHealth.check({ force: true })
    expect(s.reachable).toBe(false)
    expect(s.alerts.some(a => /unreachable/.test(a))).toBe(true)

    mockFetch({
      '/manage/health': { ok: true, version: '0.1.0', sonarr: false, youtubeKey: true, cookies: true, ytDlp: '2026.08.19', ytDlpStatus: {} },
      '/manage/status': { lastRefreshError: 'quota', lastRefreshAt: Date.now() - 20 * 3600e3, quota: { exceededAt: Date.now() - 1000, lastError: 'quotaExceeded' }, recentFailures: [], staging: { bytes: 0 } },
      '/api/v3/indexer': [], '/api/v3/downloadclient': [],
    })
    const s2 = await tuberrHealth.check({ force: true })
    expect(s2.reachable).toBe(true)
    expect(s2.alerts.some(a => /no Sonarr credentials/.test(a))).toBe(true)
    expect(s2.alerts.some(a => /quota exceeded/.test(a))).toBe(true)
    expect(s2.alerts.some(a => /Sonarr wiring: indexer missing/.test(a))).toBe(true)
    expect(s2.sonarrWiring.ok).toBe(false)
  })
})

describe('tuberrProcess', () => {
  it('reports unmanaged state and an empty log ring without spawning', () => {
    expect(tuberrProcess.isManageable()).toBe(false)
    expect(tuberrProcess.getProcessInfo()).toMatchObject({ managed: false, running: false, pid: null })
    expect(tuberrProcess.getLogs()).toEqual([])
    tuberrProcess.sync() // no-op when unmanaged
    expect(tuberrProcess.getProcessInfo().running).toBe(false)
  })
})
