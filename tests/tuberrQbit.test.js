import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Tuberr's qBittorrent-compatible API: session auth (S01) and path containment
// of uploaded torrents/categories (S02). Runs the real routers on an ephemeral
// loopback port with throwaway data/downloads dirs; download execution is
// stubbed so no yt-dlp is ever spawned.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tuberr-qbit-test-'))
process.env.TUBERR_DATA_DIR = path.join(TMP, 'data')
process.env.TUBERR_DOWNLOADS_DIR = path.join(TMP, 'downloads')
process.env.TUBERR_MAX_PENDING = '5'

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../tuberr/node_modules/express')
const config = nodeRequire('../tuberr/config.js')
const { db, getSetting, setSetting } = nodeRequire('../tuberr/db.js')
const torrent = nodeRequire('../tuberr/lib/torrent.js')
const downloader = nodeRequire('../tuberr/lib/downloader.js')
const paths = nodeRequire('../tuberr/lib/paths.js')
const runtime = nodeRequire('../tuberr/lib/state.js')

const enqueued = []
downloader.enqueue = (hash) => { enqueued.push(hash) }

let server
let base
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use(express.raw({ type: 'multipart/form-data', limit: '10mb' }))
  app.use('/api/v2', nodeRequire('../tuberr/routes/qbit.js'))
  app.use('/manage', nodeRequire('../tuberr/routes/manage.js'))
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => {
  server?.close()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const form = (obj) => new URLSearchParams(obj).toString()
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }

async function login(username = 'tuberr', password = getSetting('api_key')) {
  const res = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: FORM, body: form({ username, password }) })
  const body = await res.text()
  const sid = /SID=([^;]+)/.exec(res.headers.get('set-cookie') || '')?.[1] || null
  return { status: res.status, body, sid }
}

function call(pathname, { sid, method = 'GET', body, headers = {} } = {}) {
  return fetch(`${base}/api/v2${pathname}`, {
    method,
    headers: { ...(sid ? { Cookie: `SID=${sid}` } : {}), ...headers },
    body,
  })
}

// Sonarr uploads the .torrent as multipart with a category field
function addTorrent(sid, buffer, category = 'tv-youtube') {
  const boundary = '----tuberrTestBoundary'
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\n${category}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="x.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return call('/torrents/add', { sid, method: 'POST', body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } })
}

let videoSeq = 0
function makeTorrent(releaseTitle, videoId = `vid${String(++videoSeq).padStart(8, '0')}`) {
  return torrent.buildTorrent({ releaseTitle, sizeBytes: 1000, videoId })
}
const rowFor = (hash) => db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(hash)
const pendingCount = () => db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE state IN ('queued', 'downloading')").get().n

describe('qBittorrent API authentication (S01)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('refuses every endpoint without a session, like qBittorrent (403 Forbidden)', async () => {
    for (const [p, method] of [['/app/webapiVersion', 'GET'], ['/app/preferences', 'GET'], ['/torrents/info', 'GET'], ['/torrents/categories', 'GET'], ['/torrents/createCategory', 'POST'], ['/torrents/delete', 'POST'], ['/torrents/pause', 'POST']]) {
      const res = await call(p, { method, headers: FORM, body: method === 'POST' ? form({ category: 'x', hashes: 'all' }) : undefined })
      expect(res.status, p).toBe(403)
      expect(await res.text()).toBe('Forbidden')
    }
    const t = makeTorrent('Show.S01E01.1080p.WEB-DL-TUBERR')
    expect((await addTorrent(null, t.buffer)).status).toBe(403)
    expect(rowFor(t.infoHash)).toBeUndefined()
    expect(JSON.parse(getSetting('qbit_categories', '{}'))).not.toHaveProperty('x')
  })

  it('records refused logins as a streak that a successful login ends (for Diskovarr\'s health alert)', async () => {
    const a = runtime.state.qbitAuth
    expect((await login('admin', 'adminadmin')).body).toBe('Fails.')
    expect(a.rejectedUser).toBe('admin')
    expect(a.rejectedFrom).toMatch(/127\.0\.0\.1/)
    const since = a.rejectingSince
    expect(since).toBeGreaterThan(0)
    expect((await login('tuberr', 'wrong')).body).toBe('Fails.')
    expect(a.rejectingSince).toBe(since) // same streak
    expect((await login()).body).toBe('Ok.')
    expect(a.rejectingSince).toBeNull()
    expect(a.lastLoginAt).toBeGreaterThanOrEqual(a.rejectedAt)
  })

  it('rejects wrong credentials with "Fails." and issues no cookie', async () => {
    for (const [u, p] of [['tuberr', 'tuberr'], ['tuberr', ''], ['admin', getSetting('api_key')], ['', ''], ['tuberr', getSetting('api_key') + 'x']]) {
      const r = await login(u, p)
      expect(r.status).toBe(200)
      expect(r.body).toBe('Fails.')
      expect(r.sid).toBeNull()
    }
  })

  it('grants nothing to the old fixed SID or an arbitrary one', async () => {
    for (const sid of ['tuberr', 'deadbeefdeadbeefdeadbeefdeadbeef', '']) {
      expect((await call('/app/preferences', { sid })).status).toBe(403)
    }
  })

  it('issues a random SID for valid credentials that then works on every endpoint', async () => {
    const a = await login()
    const b = await login()
    expect(a.body).toBe('Ok.')
    expect(a.sid).toMatch(/^[0-9a-f]{32}$/)
    expect(b.sid).not.toBe(a.sid)
    const prefs = await call('/app/preferences', { sid: a.sid })
    expect(prefs.status).toBe(200)
    expect((await prefs.json()).save_path).toBe(config.downloadsDir)
    expect(await (await call('/app/webapiVersion', { sid: b.sid })).text()).toBe('2.8.3')
  })

  it('logout ends the session', async () => {
    const { sid } = await login()
    await call('/auth/logout', { sid, method: 'POST' })
    expect((await call('/app/preferences', { sid })).status).toBe(403)
  })

  it('expires idle sessions (sliding TTL) so Sonarr must log in again', async () => {
    const { sid } = await login()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 50 * 60 * 1000)
    expect((await call('/app/preferences', { sid })).status).toBe(200) // refreshes the TTL
    vi.setSystemTime(Date.now() + 50 * 60 * 1000)
    expect((await call('/app/preferences', { sid })).status).toBe(200)
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    expect((await call('/app/preferences', { sid })).status).toBe(403)
  })

  it('rotating the management key revokes sessions and the old password', async () => {
    const oldKey = getSetting('api_key')
    const { sid } = await login()
    const rot = await fetch(`${base}/manage/regenerate-key`, { method: 'POST', headers: { 'X-Api-Key': oldKey } })
    const { apiKey } = await rot.json()
    expect(apiKey).toBeTruthy()
    expect(apiKey).not.toBe(oldKey)
    expect(fs.statSync(path.join(config.dataDir, 'api_key.txt')).mode & 0o777).toBe(0o600)
    expect((await call('/app/preferences', { sid })).status).toBe(403)
    expect((await login('tuberr', oldKey)).body).toBe('Fails.')
    expect((await login('tuberr', apiKey)).body).toBe('Ok.')
  })
})

describe('torrent and category path containment (S02)', () => {
  let sid
  beforeEach(async () => { sid = (await login()).sid })

  it('rejects release names that are not a single safe path segment', async () => {
    const bad = ['../../outside', '..', '.', '.hidden', 'a/b', 'a\\b', '/etc/cron.d/x', 'x\u0000y', 'x\ny', 'x%2f..%2fy', '..%5c..%5cy', '   ']
    for (const name of bad) {
      const t = makeTorrent(name)
      const res = await addTorrent(sid, t.buffer)
      expect(await res.text(), JSON.stringify(name)).toBe('Fails.')
      expect(rowFor(t.infoHash), JSON.stringify(name)).toBeUndefined()
    }
    expect(enqueued).toEqual([])
    expect(fs.existsSync(path.join(TMP, 'outside'))).toBe(false)
  })

  it('accepts ordinary Sonarr release names unchanged', async () => {
    const good = [
      'Channel.Name.S2024E0101.Some.Title.1080p.WEB-DL',
      'Rhett.and.Links.Buddy.System.S01E05.The.Ice.Cream.1080p.WEB-DL-TUBERR',
      'Show Name (2024) [1080p] S01E01 - Pilot',
      'Ünïcödé Shöw 日本語 S01E02 ~ Title!',
      'Name.With..Double.Dots.S01E03',
    ]
    for (const name of good) {
      const t = makeTorrent(name)
      expect(await (await addTorrent(sid, t.buffer)).text(), name).toBe('Ok.')
      const row = rowFor(t.infoHash)
      expect(row.release_title).toBe(name)
      expect(row.save_path).toBe(path.join(config.downloadsDir, 'tv-youtube'))
      expect(row.content_path).toBe(path.join(config.downloadsDir, 'tv-youtube', name))
      expect(paths.isInsideDownloads(row.content_path)).toBe(true)
      db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(t.infoHash) // keep the pending cap free
    }
    expect(enqueued).toHaveLength(good.length)
  })

  it('rejects torrents whose video id is not a YouTube-style id', async () => {
    const t = makeTorrent('Show.S01E04.1080p.WEB-DL-TUBERR', 'abc&list=x')
    expect(await (await addTorrent(sid, t.buffer)).text()).toBe('Fails.')
    expect(rowFor(t.infoHash)).toBeUndefined()
  })

  it('restricts category names and save paths to the downloads dir', async () => {
    const create = (category, savePath) => call('/torrents/createCategory', { sid, method: 'POST', headers: FORM, body: form(savePath === undefined ? { category } : { category, savePath }) })
    for (const category of ['../evil', 'tv/evil', '.hidden', '', 'x\\y']) {
      expect((await create(category)).status, category).toBe(400)
    }
    expect((await create('outside-abs', path.join(TMP, 'elsewhere'))).status).toBe(400)
    expect((await create('outside-rel', '../../elsewhere')).status).toBe(400)
    expect((await create('inside', path.join(config.downloadsDir, 'custom'))).status).toBe(200)
    expect((await create('relative', 'sub/dir')).status).toBe(200)
    const cats = await (await call('/torrents/categories', { sid })).json()
    expect(cats.inside.savePath).toBe(path.join(config.downloadsDir, 'custom'))
    expect(cats.relative.savePath).toBe(path.join(config.downloadsDir, 'sub', 'dir'))
    expect(cats).not.toHaveProperty('outside-abs')
    expect(cats).not.toHaveProperty('outside-rel')

    // torrents/add with a bad category is refused; a good one keeps a custom save path
    expect(await (await addTorrent(sid, makeTorrent('Show.S02E01.WEB-DL').buffer, '../evil')).text()).toBe('Fails.')
    const t = makeTorrent('Show.S02E02.WEB-DL')
    expect(await (await addTorrent(sid, t.buffer, 'inside')).text()).toBe('Ok.')
    expect(rowFor(t.infoHash).content_path).toBe(path.join(config.downloadsDir, 'custom', 'Show.S02E02.WEB-DL'))
    db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(t.infoHash)
  })

  it('ignores a pre-existing category save path outside the downloads dir', async () => {
    const cats = JSON.parse(getSetting('qbit_categories', '{}'))
    cats.legacy = { name: 'legacy', savePath: path.join(TMP, 'escaped') }
    setSetting('qbit_categories', JSON.stringify(cats))
    const t = makeTorrent('Show.S03E01.WEB-DL')
    expect(await (await addTorrent(sid, t.buffer, 'legacy')).text()).toBe('Ok.')
    expect(rowFor(t.infoHash).content_path).toBe(path.join(config.downloadsDir, 'legacy', 'Show.S03E01.WEB-DL'))
    db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(t.infoHash)
  })

  it('refuses a category directory that is a symlink out of the downloads dir', async () => {
    const outside = fs.mkdtempSync(path.join(TMP, 'symlink-target-'))
    fs.symlinkSync(outside, path.join(config.downloadsDir, 'linked'))
    const t = makeTorrent('Show.S04E01.WEB-DL')
    expect(await (await addTorrent(sid, t.buffer, 'linked')).text()).toBe('Fails.')
    expect(rowFor(t.infoHash)).toBeUndefined()
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('caps the pending queue but always accepts a re-add of a known torrent', async () => {
    const added = []
    while (pendingCount() < 5) {
      const t = makeTorrent(`Cap.S05E${String(added.length + 1).padStart(2, '0')}.WEB-DL`)
      expect(await (await addTorrent(sid, t.buffer)).text()).toBe('Ok.')
      added.push(t)
    }
    const over = makeTorrent('Cap.S05E99.WEB-DL')
    expect(await (await addTorrent(sid, over.buffer)).text()).toBe('Fails.')
    expect(rowFor(over.infoHash)).toBeUndefined()
    expect(await (await addTorrent(sid, added[0].buffer)).text()).toBe('Ok.')
  })

  it('deletes files only inside the downloads dir', async () => {
    const inside = path.join(config.downloadsDir, 'tv-youtube', 'Del.S01E01')
    const outside = fs.mkdtempSync(path.join(TMP, 'keep-'))
    fs.mkdirSync(inside, { recursive: true })
    const ins = db.prepare("INSERT INTO downloads (info_hash, video_id, release_title, save_path, content_path, state) VALUES (?, 'v', 'r', ?, ?, 'completed')")
    ins.run('a'.repeat(40), path.dirname(inside), inside)
    ins.run('b'.repeat(40), TMP, outside)
    const res = await call('/torrents/delete', { sid, method: 'POST', headers: FORM, body: form({ hashes: `${'a'.repeat(40)}|${'b'.repeat(40)}`, deleteFiles: 'true' }) })
    expect(await res.text()).toBe('Ok.')
    expect(fs.existsSync(inside)).toBe(false)
    expect(fs.existsSync(outside)).toBe(true)
    expect(rowFor('a'.repeat(40))).toBeUndefined()
    expect(rowFor('b'.repeat(40))).toBeUndefined()
  })
})
