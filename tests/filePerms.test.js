import { describe, it, expect, beforeAll, afterAll, afterEach, onTestFinished, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// Owner-only permissions for credential-bearing files (databases, WAL/SHM,
// backups, .env), applied to throwaway directories only.
const nodeRequire = createRequire(import.meta.url)
const filePerms = nodeRequire('../server/utils/filePerms.js')

const posix = process.platform !== 'win32'
const mode = (p) => fs.statSync(p).mode & 0o777
const readUmask = () => { const m = process.umask(0o022); process.umask(m); return m }

let originalUmask, root

function touch(p, m = 0o644) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
  fs.chmodSync(p, m)
}

function mkdir(p, m = 0o755) {
  fs.mkdirSync(p, { recursive: true })
  fs.chmodSync(p, m)
}

beforeAll(() => { originalUmask = readUmask() })
afterAll(() => { process.umask(originalUmask) })
afterEach(() => {
  vi.restoreAllMocks()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe.runIf(posix)('hardenDataDir', () => {
  function legacyInstall() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-perms-'))
    const data = path.join(root, 'data')
    mkdir(data)
    for (const f of ['diskovarr.db', 'diskovarr.db-wal', 'diskovarr.db-shm', 'sessions.db', 'sessions.db-wal', 'notes.txt']) touch(path.join(data, f))
    mkdir(path.join(data, 'og-cache'))
    mkdir(path.join(data, 'backups'))
    touch(path.join(data, 'backups', 'diskovarr-2026-10-01.db'))
    mkdir(path.join(data, 'backups', 'tuberr-2026-10-01'))
    touch(path.join(data, 'backups', 'tuberr-2026-10-01', 'api_key.txt'))
    // Docker nests Tuberr's data (and by default its downloads) in the volume
    mkdir(path.join(data, 'tuberr'))
    mkdir(path.join(data, 'tuberr', 'downloads'))
    touch(path.join(data, 'tuberr', 'downloads', 'episode.mp4'))
    touch(path.join(root, '.env'), 0o664)
    touch(path.join(root, 'elsewhere.txt'))
    fs.symlinkSync(path.join(root, 'elsewhere.txt'), path.join(data, 'sessions.db-shm'))
    return data
  }

  it('makes the data dir, databases, backups and .env owner-only', () => {
    const data = legacyInstall()
    const changed = filePerms.hardenDataDir(data, [path.join(root, '.env')])
    expect(mode(data)).toBe(0o700)
    for (const f of ['diskovarr.db', 'diskovarr.db-wal', 'diskovarr.db-shm', 'sessions.db', 'sessions.db-wal']) {
      expect(mode(path.join(data, f)), f).toBe(0o600)
    }
    expect(mode(path.join(data, 'og-cache'))).toBe(0o700)
    expect(mode(path.join(data, 'backups'))).toBe(0o700)
    expect(mode(path.join(data, 'backups', 'diskovarr-2026-10-01.db'))).toBe(0o600)
    expect(mode(path.join(data, 'backups', 'tuberr-2026-10-01'))).toBe(0o700)
    expect(mode(path.join(data, 'backups', 'tuberr-2026-10-01', 'api_key.txt'))).toBe(0o600)
    expect(mode(path.join(root, '.env'))).toBe(0o600)
    expect(changed).toContain(path.join(root, '.env'))
    // Untouched: unknown files, the nested Tuberr tree Sonarr reads, symlink targets
    expect(mode(path.join(data, 'notes.txt'))).toBe(0o644)
    expect(mode(path.join(data, 'tuberr'))).toBe(0o755)
    expect(mode(path.join(data, 'tuberr', 'downloads', 'episode.mp4'))).toBe(0o644)
    expect(mode(path.join(root, 'elsewhere.txt'))).toBe(0o644)
    // Idempotent
    expect(filePerms.hardenDataDir(data, [path.join(root, '.env')])).toEqual([])
  })

  it('switches to a private umask so new files (e.g. backups) are 0600', () => {
    const data = legacyInstall()
    filePerms.hardenDataDir(data)
    expect(readUmask()).toBe(0o077)
    fs.writeFileSync(path.join(data, 'backups', 'new.db'), 'x')
    expect(mode(path.join(data, 'backups', 'new.db'))).toBe(0o600)
  })

  it('restores the boot-time umask for files other users must read', () => {
    const data = legacyInstall()
    process.umask(originalUmask)
    filePerms.usePrivateUmask()
    const shared = filePerms.withSharedUmask(() => {
      fs.writeFileSync(path.join(data, 'shared.txt'), 'x')
      return readUmask()
    })
    expect(shared).not.toBe(0o077)
    expect(mode(path.join(data, 'shared.txt'))).toBe(0o666 & ~shared)
    expect(readUmask()).toBe(0o077)
  })

  it('leaves files owned by another account alone and never throws', () => {
    const data = legacyInstall()
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 12345)
    expect(filePerms.hardenDataDir(data, [path.join(root, '.env')])).toEqual([])
    expect(mode(path.join(data, 'diskovarr.db'))).toBe(0o644)
    expect(mode(data)).toBe(0o755)
    expect(() => filePerms.hardenDataDir(path.join(root, 'missing'))).not.toThrow()
  })
})

describe.runIf(posix)('Tuberr data permissions', () => {
  it('restricts secrets, and the data dir only when downloads live elsewhere', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tuberr-perms-'))
    const savedEnv = { data: process.env.TUBERR_DATA_DIR, downloads: process.env.TUBERR_DOWNLOADS_DIR }
    onTestFinished(() => {
      if (savedEnv.data === undefined) delete process.env.TUBERR_DATA_DIR; else process.env.TUBERR_DATA_DIR = savedEnv.data
      if (savedEnv.downloads === undefined) delete process.env.TUBERR_DOWNLOADS_DIR; else process.env.TUBERR_DOWNLOADS_DIR = savedEnv.downloads
    })
    const tuberrModules = ['../tuberr/config.js', '../tuberr/db.js']
    const load = (dataDir, downloadsDir) => {
      process.env.TUBERR_DATA_DIR = dataDir
      process.env.TUBERR_DOWNLOADS_DIR = downloadsDir
      for (const m of tuberrModules) delete nodeRequire.cache[nodeRequire.resolve(m)]
      nodeRequire('../tuberr/db.js').db.close()
    }
    process.umask(originalUmask)

    // Downloads outside the data dir: whole dir private
    const a = path.join(root, 'a')
    mkdir(a)
    touch(path.join(a, 'cookies.txt'))
    load(a, path.join(root, 'downloads'))
    expect(mode(a)).toBe(0o700)
    expect(mode(path.join(a, 'cookies.txt'))).toBe(0o600)
    expect(mode(path.join(a, 'api_key.txt'))).toBe(0o600)

    // Default layout (downloads nested): Sonarr must still traverse the dir;
    // the secret files are restricted on the next start
    const b = path.join(root, 'b')
    mkdir(b)
    touch(path.join(b, 'cookies.txt'))
    load(b, path.join(b, 'downloads'))
    load(b, path.join(b, 'downloads'))
    expect(mode(b)).toBe(0o755)
    expect(mode(path.join(b, 'cookies.txt'))).toBe(0o600)
    expect(mode(path.join(b, 'tuberr.db'))).toBe(0o600)
  })
})
