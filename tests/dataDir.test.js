import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

// Everything runtime-written or -read lives under DISKOVARR_DATA_DIR: the
// manual Plex watched sync must find tokens without opening server/data, and
// the share-card cache must write into the configured directory.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-data-dir-'))
process.env.DISKOVARR_DATA_DIR = DATA_DIR
process.env.TUBERR_MANAGED = '0'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../server/node_modules/express')
const db = nodeRequire('../server/db/database.js')
const dataDirUtil = nodeRequire('../server/utils/dataDir.js')
const plexService = nodeRequire('../server/services/plex.js')
const reviewCardCache = nodeRequire('../server/services/reviewCardCache.js')

const REPO_SESSIONS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'data', 'sessions.db')
let server, base, repoSessionsExisted

function post(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + urlPath, { method: 'POST' }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }))
    })
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  repoSessionsExisted = fs.existsSync(REPO_SESSIONS)
  const app = express()
  app.use((req, res, next) => { req.session = { isAdmin: true }; next() })
  app.use('/admin', nodeRequire('../server/routes/admin.js'))
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => server?.close())
afterEach(() => vi.restoreAllMocks())

describe('data dir helper', () => {
  it('resolves to DISKOVARR_DATA_DIR and is what the db module exports', () => {
    expect(dataDirUtil.dataDir).toBe(DATA_DIR)
    expect(db.dataDir).toBe(DATA_DIR)
    expect(db.dataPath('sessions.db')).toBe(path.join(DATA_DIR, 'sessions.db'))
    expect(fs.existsSync(path.join(DATA_DIR, 'diskovarr.db'))).toBe(true)
  })

  it('keeps the share-card cache under the configured data dir', async () => {
    expect(reviewCardCache.CACHE_DIR).toBe(path.join(DATA_DIR, 'og-cache'))
    const png = Buffer.from('fake png')
    await reviewCardCache.getOrCreate('dd-test', 1, 'og', async () => png)
    expect(fs.readFileSync(path.join(DATA_DIR, 'og-cache', 'dd-test-1-og.png'))).toEqual(png)
  })
})

describe('manual Plex watched sync token lookup', () => {
  const waitForCall = async (spy) => {
    for (let i = 0; i < 50 && spy.mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 10))
  }

  it('uses the stored known_users token when no session store exists', async () => {
    expect(fs.existsSync(path.join(DATA_DIR, 'sessions.db'))).toBe(false)
    db.upsertKnownUser('p1', 'plexuser', null, 'KNOWN_TOKEN')
    const sync = vi.spyOn(plexService, 'syncUserWatched').mockResolvedValue(0)
    const res = await post('/admin/sync/watched/p1')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    await waitForCall(sync)
    expect(sync).toHaveBeenCalledWith('p1', 'KNOWN_TOKEN')
    // Never opened (or created) a session DB inside the source tree
    expect(fs.existsSync(REPO_SESSIONS)).toBe(repoSessionsExisted)
  })

  it('falls back to a live session in the configured session store', async () => {
    const sessDb = new DatabaseSync(path.join(DATA_DIR, 'sessions.db'))
    sessDb.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL)')
    const future = Math.floor(Date.now() / 1000) + 3600
    sessDb.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s1', JSON.stringify({ plexUser: { id: 'p2', token: 'SESSION_TOKEN' } }), future)
    sessDb.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('s0', JSON.stringify({ plexUser: { id: 'p3', token: 'EXPIRED' } }), 1)
    sessDb.close()
    db.upsertKnownUser('p2', 'no-token-user', null, null)
    const sync = vi.spyOn(plexService, 'syncUserWatched').mockResolvedValue(0)
    const res = await post('/admin/sync/watched/p2')
    expect(res.body.success).toBe(true)
    await waitForCall(sync)
    expect(sync).toHaveBeenCalledWith('p2', 'SESSION_TOKEN')
  })

  it('reports a missing token instead of failing', async () => {
    const sync = vi.spyOn(plexService, 'syncUserWatched').mockResolvedValue(0)
    const res = await post('/admin/sync/watched/p3') // only an expired session
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(false)
    expect(sync).not.toHaveBeenCalled()
  })
})
