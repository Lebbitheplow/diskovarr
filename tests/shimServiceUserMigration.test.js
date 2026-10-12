import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

// shim_service_user_request_v1: service users created before the shim enforced
// REQUEST had mask 0. On upgrade they get REQUEST (32) exactly once; other masks
// are left alone, and a mask set back to 0 afterwards is not re-granted.

const nodeRequire = createRequire(import.meta.url)
const DB_MODULE = nodeRequire.resolve('../server/db/database.js')
const DATA_DIR_MODULE = nodeRequire.resolve('../server/utils/dataDir.js')

let db = null
// Load the db module against `dir` (never the live data dir): the data dir is
// resolved at import time, so both modules are loaded fresh.
function openDb(dir) {
  db?.close()
  process.env.DISKOVARR_DATA_DIR = dir
  delete nodeRequire.cache[DB_MODULE]
  delete nodeRequire.cache[DATA_DIR_MODULE]
  db = nodeRequire(DB_MODULE)
  return db
}
afterAll(() => db?.close())

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-svc-migration-'))

// An install from before the migration: the shim tables with users of various masks
const upgradeDir = tmpDir()
{
  const seed = new DatabaseSync(path.join(upgradeDir, 'diskovarr.db'))
  seed.exec(`
    CREATE TABLE api_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0, notes TEXT
    );
    CREATE TABLE app_service_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER NOT NULL REFERENCES api_apps(id), overseerr_user_id INTEGER NOT NULL,
      user_id TEXT NOT NULL, api_key TEXT UNIQUE NOT NULL, email TEXT, username TEXT NOT NULL,
      permissions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO api_apps (id, name, api_key, type, enabled) VALUES (1, 'Agregarr', 'key-agregarr', 'agregarr', 1), (2, 'Old app', 'key-old', 'generic', 0);
  `)
  const insert = seed.prepare('INSERT INTO app_service_users (app_id, overseerr_user_id, user_id, api_key, username, permissions) VALUES (?, ?, ?, ?, ?, ?)')
  insert.run(1, 100, '__svc_1_100__', 'svc-zero', 'Zero', 0)
  insert.run(1, 101, '__svc_1_101__', 'svc-agregarr', 'Agregarr bot', 160)
  insert.run(1, 102, '__svc_1_102__', 'svc-manager', 'Manager', 16)
  insert.run(2, 100, '__svc_2_100__', 'svc-disabled', 'Disabled app bot', 0)
  seed.close()
}

const maskOf = username => db.prepare('SELECT permissions FROM app_service_users WHERE username = ?').get(username).permissions
const migrationRuns = () => db.prepare("SELECT COUNT(*) AS c FROM migrations WHERE name = 'shim_service_user_request_v1'").get().c

describe('shim_service_user_request_v1', () => {
  it('grants REQUEST to zero-mask service users only, in every app', () => {
    openDb(upgradeDir)
    expect(maskOf('Zero')).toBe(32)
    expect(maskOf('Disabled app bot')).toBe(32)
    expect(maskOf('Agregarr bot')).toBe(160)
    expect(maskOf('Manager')).toBe(16)
    expect(migrationRuns()).toBe(1)
  })

  it('never re-runs: a mask set back to 0 stays 0 across restarts', () => {
    db.prepare("UPDATE app_service_users SET permissions = 0 WHERE username = 'Zero'").run()
    openDb(upgradeDir)
    expect(maskOf('Zero')).toBe(0)
    expect(maskOf('Agregarr bot')).toBe(160)
    expect(migrationRuns()).toBe(1)
  })

  it('is recorded as a no-op on a fresh install', () => {
    openDb(tmpDir())
    expect(migrationRuns()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM app_service_users').get().c).toBe(0)
    // New service users start with REQUEST
    const app = db.createApiApp('Compat', 'compat')
    expect(db.createServiceUser(app.id, { username: 'New bot' }).permissions).toBe(32)
  })
})
