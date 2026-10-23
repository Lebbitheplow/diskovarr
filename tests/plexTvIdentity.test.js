import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'

// plex.tv copies a request's identity headers onto the token's device. When
// the admin token is the Plex server's own, Diskovarr must send the server's
// real version, never its own 'Web' / '1.0.0'.
const nodeRequire = createRequire(import.meta.url)
const guard = nodeRequire('../server/services/plexTvIdentity.js')

const SERVER = {
  machineIdentifier: 'srv-1', version: '1.43.5.11029-6bf8af3f0',
  platform: 'Linux', platformVersion: '24.04.5 LTS (Noble Numbat)',
}
const DISKOVARR_HEADERS = {
  'X-Plex-Client-Identifier': 'diskovarr-app', 'X-Plex-Product': 'Diskovarr',
  'X-Plex-Version': '1.0.0', 'X-Plex-Platform': 'Web',
}

// A fake plex.tv + PMS. `serverToken` is the token plex.tv binds to the
// server device; any request with it stamps its identity headers onto the
// server's record, as plex.tv does.
function fakePlex({ serverToken, plexTvUp = true }) {
  const record = { clientIdentifier: SERVER.machineIdentifier, productVersion: SERVER.version, platform: SERVER.platform, platformVersion: SERVER.platformVersion }
  const calls = []
  const impl = async (url, init = {}) => {
    const headers = new Headers(init.headers || {})
    const u = new URL(url)
    const token = headers.get('X-Plex-Token') || u.searchParams.get('X-Plex-Token')
    calls.push({ url, headers })
    const json = body => ({ ok: true, status: 200, json: async () => body })
    if (u.hostname === 'pms.local') return json({ MediaContainer: SERVER })
    if (!plexTvUp) throw new Error('offline')
    if (token === serverToken) {
      if (headers.has('X-Plex-Version')) record.productVersion = headers.get('X-Plex-Version')
      if (headers.has('X-Plex-Platform')) record.platform = headers.get('X-Plex-Platform')
      if (headers.has('X-Plex-Platform-Version')) record.platformVersion = headers.get('X-Plex-Platform-Version')
    }
    if (u.pathname === '/api/v2/resources') return json([{ ...record }])
    return json({})
  }
  return { impl, record, calls }
}

function installWith(fake, token) {
  return guard.install({ fetchImpl: fake.impl, getToken: () => token, getUrl: () => 'http://pms.local:32400' })
}

afterEach(() => guard._reset())

describe('plexTvIdentity', () => {
  it('keeps the server record correct when the admin token is the server token', async () => {
    const fake = fakePlex({ serverToken: 'server-tok' })
    const f = installWith(fake, 'server-tok')
    await f('https://discover.provider.plex.tv/library/sections/watchlist/all', { headers: { ...DISKOVARR_HEADERS, 'X-Plex-Token': 'server-tok' } })
    await f('https://plex.tv/api/v2/resources?X-Plex-Token=server-tok&X-Plex-Version=1.0.0', { headers: DISKOVARR_HEADERS })
    expect(fake.record.productVersion).toBe(SERVER.version)
    expect(fake.record.platform).toBe('Linux')
    expect(fake.record.platformVersion).toBe(SERVER.platformVersion)
    const last = fake.calls.at(-1)
    expect(last.headers.get('X-Plex-Version')).toBe(SERVER.version)
    expect(new URL(last.url).searchParams.get('X-Plex-Version')).toBeNull()
  })

  it('repairs a record an older Diskovarr already relabelled', async () => {
    const fake = fakePlex({ serverToken: 'server-tok' })
    Object.assign(fake.record, { productVersion: '1.0.0', platform: 'Web' })
    const f = installWith(fake, 'server-tok')
    await f('https://plex.tv/api/v2/user', { headers: { ...DISKOVARR_HEADERS, 'X-Plex-Token': 'server-tok' } })
    expect(fake.record.productVersion).toBe(SERVER.version)
    expect(fake.record.platform).toBe('Linux')
  })

  it('leaves Diskovarr headers alone for its own token', async () => {
    const fake = fakePlex({ serverToken: 'server-tok' })
    const f = installWith(fake, 'own-tok')
    await f('https://plex.tv/api/v2/user', { headers: { ...DISKOVARR_HEADERS, 'X-Plex-Token': 'own-tok' } })
    expect(fake.record.productVersion).toBe(SERVER.version)
    expect(fake.calls.at(-1).headers.get('X-Plex-Version')).toBe('1.0.0')
  })

  it('strips identity headers while the probe cannot tell', async () => {
    const fake = fakePlex({ serverToken: 'server-tok', plexTvUp: false })
    const f = installWith(fake, 'server-tok')
    await f('https://plex.tv/api/v2/user', { headers: { ...DISKOVARR_HEADERS, 'X-Plex-Token': 'server-tok' } }).catch(() => {})
    const last = fake.calls.at(-1)
    expect(last.headers.has('X-Plex-Version')).toBe(false)
    expect(last.headers.has('X-Plex-Platform')).toBe(false)
  })

  it('does not touch non-plex.tv requests or other users\' tokens', async () => {
    const fake = fakePlex({ serverToken: 'server-tok' })
    const f = installWith(fake, 'server-tok')
    await f('http://pms.local:32400/library/sections', { headers: { ...DISKOVARR_HEADERS, 'X-Plex-Token': 'server-tok' } })
    await f('https://plex.tv/api/v2/user', { headers: { ...DISKOVARR_HEADERS, 'X-Plex-Token': 'friend-tok' } })
    expect(fake.calls.map(c => c.headers.get('X-Plex-Version'))).toEqual(['1.0.0', '1.0.0'])
  })
})
