import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRequire } from 'node:module'

// Installed version + GitHub release notes: env beats git, drafts and
// prereleases are skipped, and the changelog never shows unreleased-for-us notes.
const nodeRequire = createRequire(import.meta.url)
const appVersion = nodeRequire('../server/services/appVersion.js')

const realFetch = globalThis.fetch
const realEnv = process.env.DISKOVARR_VERSION

const RELEASES = [
  { tag_name: 'v3.5.0-beta', prerelease: true, published_at: '2026-10-07T00:00:00Z', body: 'beta' },
  { tag_name: 'v3.4.0', published_at: '2026-10-05T23:22:37Z', html_url: 'u340', body: '## What\'s new\n\n- A' },
  { tag_name: 'v3.10.0', draft: true, body: 'draft' },
  { tag_name: 'v3.3.5', published_at: '2026-09-24T02:04:41Z', body: 'b' },
  { tag_name: 'v3.3.4', published_at: '2026-09-23T19:44:38Z', body: 'c' },
  { tag_name: 'v3.3.3', published_at: '2026-09-21T20:16:30Z', body: 'd' },
]

function mockReleases(payload, status = 200) {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: status < 400, status, json: async () => payload }
  }
  return () => calls
}

beforeEach(() => appVersion._resetCaches())
afterEach(() => {
  globalThis.fetch = realFetch
  if (realEnv === undefined) delete process.env.DISKOVARR_VERSION
  else process.env.DISKOVARR_VERSION = realEnv
})

describe('appVersion', () => {
  it('prefers DISKOVARR_VERSION and strips a leading v', () => {
    process.env.DISKOVARR_VERSION = 'v9.8.7'
    expect(appVersion.currentVersion()).toBe('9.8.7')
  })

  it('falls back to a git tag or package.json when the env is empty', () => {
    process.env.DISKOVARR_VERSION = ''
    expect(appVersion.currentVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('compares versions numerically', () => {
    expect(appVersion.isNewerVersion('3.10.0', '3.9.9')).toBe(true)
    expect(appVersion.isNewerVersion('3.4.0', '3.4.0')).toBe(false)
    expect(appVersion.isNewerVersion(null, '3.4.0')).toBe(false)
  })

  it('reports the newest published release as latest, ignoring drafts and prereleases', async () => {
    process.env.DISKOVARR_VERSION = '3.3.5'
    mockReleases(RELEASES)
    expect(await appVersion.getUpdateStatus()).toEqual({ current: '3.3.5', latest: '3.4.0', updateAvailable: true })
  })

  it('returns the installed release and the two before it', async () => {
    process.env.DISKOVARR_VERSION = '3.3.5'
    mockReleases(RELEASES)
    const { current, releases } = await appVersion.getChangelog(3)
    expect(current).toBe('3.3.5')
    expect(releases.map(r => r.version)).toEqual(['3.3.5', '3.3.4', '3.3.3'])
    expect(releases[0].date).toBe('2026-09-24')
  })

  it('caches the GitHub response, and a failed check reports no update', async () => {
    process.env.DISKOVARR_VERSION = '3.4.0'
    const calls = mockReleases(RELEASES)
    await appVersion.getReleases()
    await appVersion.getChangelog()
    expect(calls()).toBe(1)

    appVersion._resetCaches()
    mockReleases({ message: 'rate limited' }, 403)
    const status = await appVersion.getUpdateStatus()
    expect(status).toEqual({ current: '3.4.0', latest: null, updateAvailable: false })
  })
})
