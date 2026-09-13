import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// The db module resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never open the live database.
process.env.DISKOVARR_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))

const require = createRequire(import.meta.url)
const { resolveUserTarget, buildAuthHeader, isValidTopic, isValidUrl } = require('../server/services/ntfyAgent')

const admin = { enabled: true, url: 'https://ntfy.example.com', topic: 'admin', authMethod: 'token', token: 'admintok' }

describe('ntfy per-user target resolution', () => {
  it('returns null when the user has not opted in or has no topic', () => {
    expect(resolveUserTarget({ ntfy_enabled: false, ntfy_topic: 'me' }, admin)).toBeNull()
    expect(resolveUserTarget({ ntfy_enabled: true, ntfy_topic: '' }, admin)).toBeNull()
    expect(resolveUserTarget({ ntfy_enabled: true, ntfy_topic: 'bad topic!' }, admin)).toBeNull()
    expect(resolveUserTarget(null, admin)).toBeNull()
  })

  it("falls back to the admin's server and credentials when the user sets none", () => {
    const t = resolveUserTarget({ ntfy_enabled: true, ntfy_topic: 'me-123' }, admin)
    expect(t).toEqual({ url: 'https://ntfy.example.com', topic: 'me-123', authHeader: 'Bearer admintok' })
  })

  it("uses the user's own credentials on the admin's server when provided", () => {
    const t = resolveUserTarget({ ntfy_enabled: true, ntfy_topic: 'me', ntfy_auth_method: 'basic', ntfy_username: 'u', ntfy_password: 'p' }, admin)
    expect(t.authHeader).toBe('Basic ' + Buffer.from('u:p').toString('base64'))
  })

  it("never leaks the admin's credentials to a user-chosen server", () => {
    const t = resolveUserTarget({ ntfy_enabled: true, ntfy_topic: 'me', ntfy_url: 'https://ntfy.sh' }, admin)
    expect(t).toEqual({ url: 'https://ntfy.sh', topic: 'me', authHeader: null })
  })

  it('returns null when neither side has a usable server URL', () => {
    expect(resolveUserTarget({ ntfy_enabled: true, ntfy_topic: 'me' }, { enabled: true, url: '' })).toBeNull()
    expect(resolveUserTarget({ ntfy_enabled: true, ntfy_topic: 'me', ntfy_url: 'ftp://x' }, { enabled: true, url: '' })).toBeNull()
  })

  it('validates topics and URLs the way ntfy does', () => {
    expect(isValidTopic('a-B_9')).toBe(true)
    expect(isValidTopic('has space')).toBe(false)
    expect(isValidTopic('x'.repeat(65))).toBe(false)
    expect(isValidUrl('http://ntfy.local:8080')).toBe(true)
    expect(isValidUrl('javascript:alert(1)')).toBe(false)
    expect(buildAuthHeader({ authMethod: 'none', token: 'ignored' })).toBeNull()
  })
})
