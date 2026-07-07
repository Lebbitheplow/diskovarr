import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// plexCast pulls in plex.js → db; point the db at a throwaway directory and
// pin the Plex env BEFORE loading so tests never touch the live database.
process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-test-'))
process.env.PLEX_SERVER_ID = 'pms-machine-id'
process.env.PLEX_URL = 'http://192.168.1.10:32400'

const nodeRequire = createRequire(import.meta.url)
const plexCast = nodeRequire('../server/services/plexCast.js')

const conn = (uri, { local = false, relay = false, IPv6 = false, address = 'x', port = 32400, protocol = 'https' } = {}) =>
  ({ uri, local, relay, IPv6, address, port, protocol })

function playerResource(overrides = {}) {
  return {
    clientIdentifier: 'tv-1',
    owned: true,
    provides: 'player',
    name: 'Living Room TV',
    product: 'Plex for Android (TV)',
    connections: [
      conn('http://192.168.5.20:32500', { local: true }),
      conn('https://relay.plex.direct:8443', { relay: true }),
      conn('https://1-2-3-4.hash.plex.direct:32500', { local: false }),
      conn('https://192-168-5-20.hash.plex.direct:32500', { local: true }),
    ],
    ...overrides,
  }
}

describe('resolvePlayerConnections', () => {
  it('sorts for browser delivery: local https, remote https, relay https, plain http', () => {
    const player = plexCast.resolvePlayerConnections([playerResource()], 'tv-1')
    expect(player.name).toBe('Living Room TV')
    expect(player.connections.map(c => c.uri)).toEqual([
      'https://192-168-5-20.hash.plex.direct:32500',
      'https://1-2-3-4.hash.plex.direct:32500',
      'https://relay.plex.direct:8443',
      'http://192.168.5.20:32500',
    ])
  })

  it('returns null for unknown, unowned, or connection-less players', () => {
    expect(plexCast.resolvePlayerConnections([playerResource()], 'nope')).toBeNull()
    expect(plexCast.resolvePlayerConnections([playerResource({ owned: false })], 'tv-1')).toBeNull()
    // devices.xml-only players (e.g. some Roku builds) have no connections
    expect(plexCast.resolvePlayerConnections([playerResource({ connections: [] })], 'tv-1')).toBeNull()
    expect(plexCast.resolvePlayerConnections([playerResource({ connections: undefined })], 'tv-1')).toBeNull()
  })
})

describe('sortForServerDelivery', () => {
  it('puts relay connections first', () => {
    const sorted = plexCast.sortForServerDelivery([
      { uri: 'https://local', relay: false },
      { uri: 'https://relay', relay: true },
    ])
    expect(sorted.map(c => c.uri)).toEqual(['https://relay', 'https://local'])
  })
})

describe('resolveServerEndpoint', () => {
  const pms = (connections) => [{ clientIdentifier: 'pms-machine-id', provides: 'server', connections }]

  it('prefers the remote non-relay non-IPv6 connection, using the plex.direct hostname', () => {
    const endpoint = plexCast.resolveServerEndpoint(pms([
      conn('https://relay.plex.direct:8443', { relay: true, address: 'relay.plex.direct', port: 8443 }),
      conn('https://192-168-1-10.hash.plex.direct:32400', { local: true, address: '192.168.1.10' }),
      // ULA IPv6 published as "remote" — unroutable, must be skipped
      conn('https://fd33-aaaa.hash.plex.direct:32400', { local: false, address: 'fd33::aaaa', IPv6: true }),
      conn('https://5-6-7-8.hash.plex.direct:12345', { local: false, address: '5.6.7.8', port: 12345 }),
    ]))
    expect(endpoint).toEqual({ address: '5-6-7-8.hash.plex.direct', port: '12345', protocol: 'https' })
  })

  it('falls back to the local connection matching PLEX_URL when no remote exists', () => {
    const endpoint = plexCast.resolveServerEndpoint(pms([
      conn('https://172-19-0-1.hash.plex.direct:32400', { local: true, address: '172.19.0.1' }),
      conn('https://192-168-1-10.hash.plex.direct:32400', { local: true, address: '192.168.1.10' }),
    ]))
    expect(endpoint.address).toBe('192-168-1-10.hash.plex.direct')
  })

  it('falls back to PLEX_URL when plex.tv has no usable PMS entry', () => {
    expect(plexCast.resolveServerEndpoint([])).toEqual({ address: '192.168.1.10', port: '32400', protocol: 'http' })
  })

  it('never picks the relay connection', () => {
    const endpoint = plexCast.resolveServerEndpoint(pms([
      conn('https://relay.plex.direct:8443', { relay: true, address: 'relay.plex.direct', port: 8443 }),
    ]))
    expect(endpoint.address).toBe('192.168.1.10')
  })
})

describe('buildPlayMediaParams', () => {
  const endpoint = { address: '5-6-7-8.hash.plex.direct', port: '32400', protocol: 'https' }

  it('includes protocol, token, and containerKey when present', () => {
    const params = plexCast.buildPlayMediaParams({
      ratingKey: 42, containerKey: '/playQueues/7?window=200&own=1', endpoint, serverToken: 'user-server-token',
    })
    expect(params).toEqual({
      key: '/library/metadata/42',
      ratingKey: '42',
      machineIdentifier: 'pms-machine-id',
      address: '5-6-7-8.hash.plex.direct',
      port: '32400',
      protocol: 'https',
      offset: '0',
      type: 'video',
      token: 'user-server-token',
      containerKey: '/playQueues/7?window=200&own=1',
    })
  })

  it('omits containerKey when PlayQueue creation failed', () => {
    const params = plexCast.buildPlayMediaParams({ ratingKey: 42, containerKey: null, endpoint, serverToken: 't' })
    expect(params).not.toHaveProperty('containerKey')
  })
})

describe('friendlyCastError', () => {
  it('never leaks raw undici timeout text', () => {
    const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    expect(plexCast.friendlyCastError(err)).toMatch(/Timed out reaching the player/)
    expect(plexCast.friendlyCastError(new Error('fetch failed'))).toMatch(/Could not connect/)
    expect(plexCast.friendlyCastError(new Error('weird'))).toMatch(/Cast failed/)
  })
})
