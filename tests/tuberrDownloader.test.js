import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Tuberr download lifecycle (F24) and write containment at download time
// (S02). yt-dlp is replaced by a fake script (YTDLP_PATH) that writes a
// partial file, starts a grandchild (standing in for ffmpeg) and then hangs,
// so cancellation can be checked against real processes. Throwaway dirs only.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tuberr-dl-test-'))
const PIDS = path.join(TMP, 'pids')
fs.mkdirSync(PIDS)
process.env.TUBERR_DATA_DIR = path.join(TMP, 'data')
process.env.TUBERR_DOWNLOADS_DIR = path.join(TMP, 'downloads')
process.env.YTDLP_PATH = path.join(TMP, 'fake-yt-dlp')
process.env.FAKE_YTDLP_PIDS = PIDS

fs.writeFileSync(process.env.YTDLP_PATH, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
const id = new URL(args[args.length - 1]).searchParams.get('v');
const mode = process.env.FAKE_YTDLP_MODE || 'hang';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(out.replace('%(ext)s', 'mp4.part'), 'partial');
console.log('PROG|10|100|5|9');
if (mode === 'late-complete') {
  // Finishes "successfully" when told to stop, like a merge that was already done
  process.on('SIGTERM', () => {
    fs.writeFileSync(out.replace('%(ext)s', 'mp4'), 'video');
    fs.writeFileSync(out.replace('%(ext)s', 'info.json'), JSON.stringify({ id, title: 'T' }));
    process.exit(0);
  });
}
fs.writeFileSync(path.join(process.env.FAKE_YTDLP_PIDS, id + '.json'), JSON.stringify({ pid: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o755 })

const nodeRequire = createRequire(import.meta.url)
const express = nodeRequire('../tuberr/node_modules/express')
const config = nodeRequire('../tuberr/config.js')
const { db, getSetting } = nodeRequire('../tuberr/db.js')
const downloader = nodeRequire('../tuberr/lib/downloader.js')
const runtime = nodeRequire('../tuberr/lib/state.js')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(20)
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const rowFor = (hash) => db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(hash)
const pidsFor = (videoId) => {
  const f = path.join(PIDS, `${videoId}.json`)
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

let seq = 0
function insertRow({ savePath = path.join(config.downloadsDir, 'tv-youtube'), title } = {}) {
  seq++
  const hash = String(seq).padStart(40, '0')
  const videoId = `fakevid${String(seq).padStart(4, '0')}`
  const releaseTitle = title ?? `Fake.Show.S01E${String(seq).padStart(2, '0')}.1080p.WEB-DL-TUBERR`
  db.prepare(`INSERT INTO downloads (info_hash, video_id, release_title, category, save_path, content_path, state, size_bytes, added_on)
    VALUES (?, ?, ?, 'tv-youtube', ?, ?, 'queued', 100, 0)`).run(hash, videoId, releaseTitle, savePath, path.join(savePath, releaseTitle))
  return { hash, videoId, outDir: path.join(savePath, releaseTitle) }
}

const spawned = []
afterAll(() => {
  downloader.stopAll()
  for (const p of spawned) for (const pid of [p.pid, p.child]) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => { process.env.FAKE_YTDLP_MODE = 'hang' })

describe('cancelling an active download (F24)', () => {
  let server
  let base
  beforeAll(async () => {
    const app = express()
    app.use(express.urlencoded({ extended: true }))
    app.use('/api/v2', nodeRequire('../tuberr/routes/qbit.js'))
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => server?.close())

  it('torrents/delete kills yt-dlp and its children, then removes files and the row for good', async () => {
    const { hash, videoId, outDir } = insertRow()
    downloader.enqueue(hash)
    const pids = await waitFor(() => pidsFor(videoId))
    spawned.push(pids)
    expect(alive(pids.pid)).toBe(true)
    expect(rowFor(hash).state).toBe('downloading')
    expect(fs.readdirSync(outDir).some(f => f.endsWith('.part'))).toBe(true)

    const login = await fetch(`${base}/api/v2/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'tuberr', password: getSetting('api_key') }) })
    const sid = /SID=([^;]+)/.exec(login.headers.get('set-cookie'))[1]
    const res = await fetch(`${base}/api/v2/torrents/delete`, {
      method: 'POST',
      headers: { Cookie: `SID=${sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hash, deleteFiles: 'true' }),
    })
    expect(await res.text()).toBe('Ok.')
    await waitFor(() => !alive(pids.pid) && !alive(pids.child))
    expect(downloader.isActive(hash)).toBe(false)
    await sleep(200) // nothing may come back afterwards
    expect(fs.existsSync(outDir)).toBe(false)
    expect(rowFor(hash)).toBeUndefined()
  })

  it('ignores a download that completes after it was cancelled', async () => {
    process.env.FAKE_YTDLP_MODE = 'late-complete'
    const { hash, videoId, outDir } = insertRow()
    downloader.enqueue(hash)
    const pids = await waitFor(() => pidsFor(videoId))
    spawned.push(pids)
    expect(await downloader.cancel(hash)).toBe(true)
    expect(alive(pids.pid)).toBe(false)
    // the fake wrote its "finished" files on SIGTERM and exited 0 …
    expect(fs.existsSync(path.join(outDir, `${path.basename(outDir)}.mp4`))).toBe(true)
    // … but the cancelled job neither completed the row nor wrote metadata
    expect(rowFor(hash).state).toBe('downloading')
    expect(fs.existsSync(path.join(outDir, `${path.basename(outDir)}.nfo`))).toBe(false)
    db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(hash)
  })

  it('drops a cancelled download that was still waiting in the queue', async () => {
    process.env.TUBERR_MAX_CONCURRENT = '1'
    try {
      const running = insertRow()
      const waiting = insertRow()
      downloader.enqueue(running.hash)
      downloader.enqueue(waiting.hash)
      spawned.push(await waitFor(() => pidsFor(running.videoId)))
      expect(await downloader.cancel(waiting.hash)).toBe(false) // was not running yet
      expect(await downloader.cancel(running.hash)).toBe(true) // frees the slot …
      await sleep(200)
      expect(pidsFor(waiting.videoId)).toBeNull() // … which the cancelled one must not take
      expect(downloader.isActive(waiting.hash)).toBe(false)
      db.prepare('DELETE FROM downloads WHERE info_hash IN (?, ?)').run(running.hash, waiting.hash)
    } finally {
      delete process.env.TUBERR_MAX_CONCURRENT
    }
  })
})

describe('download-time failures and containment', () => {
  // A failure outside yt-dlp is handled like a yt-dlp failure: the row is
  // removed (so Sonarr returns the episode to wanted — it never fails a qbit
  // item by state) and the failure is recorded for /manage/status.
  const failureFor = (hash, videoId) => waitFor(() => !rowFor(hash)
    && runtime.state.recentFailures.find(f => f.videoId === videoId))

  it('removes the row and records the failure when the output dir cannot be created (no unhandled rejection)', async () => {
    const blocker = path.join(config.downloadsDir, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    const { hash, videoId } = insertRow({ savePath: blocker })
    downloader.enqueue(hash)
    const failure = await failureFor(hash, videoId)
    expect(failure.error).toMatch(/ENOTDIR|EEXIST|not a directory/i)
    expect(downloader.isActive(hash)).toBe(false)
  })

  it('refuses rows whose download dir resolves outside the downloads dir', async () => {
    const outside = fs.mkdtempSync(path.join(TMP, 'outside-'))
    const escaping = [
      insertRow({ savePath: outside }),
      insertRow({ title: '../../escape' }),
      insertRow({ title: '.hidden' }),
    ]
    fs.symlinkSync(outside, path.join(config.downloadsDir, 'linkcat'))
    escaping.push(insertRow({ savePath: path.join(config.downloadsDir, 'linkcat') }))
    for (const { hash } of escaping) downloader.enqueue(hash)
    for (const { hash, videoId } of escaping) {
      const failure = await failureFor(hash, videoId)
      expect(failure.error).toMatch(/outside the downloads dir|unsafe release name/)
    }
    expect(fs.readdirSync(outside)).toEqual([])
    expect(fs.existsSync(path.join(TMP, 'escape'))).toBe(false)
    expect(fs.readdirSync(PIDS).length).toBe(spawned.length) // no yt-dlp was started for them
  })

  it('removes the row and records the failure when the cookie jar cannot be copied', async () => {
    const jar = path.join(config.dataDir, 'cookies.txt')
    fs.mkdirSync(jar) // copyFileSync on a directory throws
    try {
      const { hash, videoId } = insertRow()
      downloader.enqueue(hash)
      const failure = await failureFor(hash, videoId)
      expect(failure.error).toBeTruthy()
      expect(pidsFor(videoId)).toBeNull()
      expect(fs.readdirSync(config.dataDir).filter(f => f.startsWith('.cookies-'))).toEqual([])
    } finally {
      fs.rmdirSync(jar)
    }
  })
})
