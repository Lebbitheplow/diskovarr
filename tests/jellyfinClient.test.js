import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.DISKOVARR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskovarr-jf-client-'))
const nodeRequire = createRequire(import.meta.url)
const db = nodeRequire('../server/db/database.js')
const client = nodeRequire('../server/services/jellyfin/client.js')

beforeEach(() => {
  db.setSetting('jellyfin_url', 'http://jellyfin:8096')
  db.setSetting('jellyfin_api_key', 'server-key')
})
afterEach(() => vi.unstubAllGlobals())

describe('Jellyfin authentication', () => {
  it.each([
    [{}, 'server-key'],
    [{ apiKey: 'test-connection-key' }, 'test-connection-key'],
    [{ token: 'user-token', apiKey: 'server-key' }, 'user-token'],
  ])('uses the current Authorization format for authenticated requests: %j', async (options, token) => {
    const fetch = vi.fn(async (_url, init) => {
      // Jellyfin 12 disables the old X-Emby-Token authentication by default.
      if (init.headers['X-Emby-Token'] || !init.headers.Authorization.includes(`Token="${token}"`)) {
        return new Response('Unauthorized', { status: 401 })
      }
      return Response.json({ ServerName: 'Test Jellyfin' })
    })
    vi.stubGlobal('fetch', fetch)
    await expect(client.jfFetch('/System/Info', options)).resolves.toEqual({ ServerName: 'Test Jellyfin' })
    expect(fetch.mock.calls[0][0]).toBe('http://jellyfin:8096/System/Info')
    expect(fetch.mock.calls[0][1].headers.Authorization).toMatch(/^MediaBrowser /)
  })

  it('keeps anonymous password authentication free of the server API key', async () => {
    const fetch = vi.fn(async () => Response.json({ User: { Id: 'user-1', Name: 'Viewer' }, AccessToken: 'user-token' }))
    vi.stubGlobal('fetch', fetch)
    await expect(client.authenticateByName('Viewer', 'example-password')).resolves.toMatchObject({ userId: 'user-1' })
    const headers = fetch.mock.calls[0][1].headers
    expect(headers.Authorization).not.toContain('Token=')
    expect(headers['X-Emby-Token']).toBeUndefined()
  })
})
