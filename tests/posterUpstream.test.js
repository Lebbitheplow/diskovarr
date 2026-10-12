import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const { snapWidth, posterKind, parsePosterPath, upstreamUrl } = nodeRequire('../server/services/posterUpstream.js')

const PLEX = { plexUrl: 'http://plex:32400', plexToken: 'tok' }
const JF = { jellyfinUrl: 'http://jf:8096' }

describe('snapWidth', () => {
  it('rounds up to the next cached size', () => {
    expect(snapWidth('100')).toBe(120)
    expect(snapWidth(360)).toBe(360)
    expect(snapWidth('361')).toBe(540)
  })

  it('returns null (original size) for junk or anything past the largest size', () => {
    expect(snapWidth(undefined)).toBeNull()
    expect(snapWidth('abc')).toBeNull()
    expect(snapWidth('-5')).toBeNull()
    expect(snapWidth('5000')).toBeNull()
  })
})

describe('posterKind', () => {
  it('accepts only Plex library and Jellyfin image paths', () => {
    expect(posterKind('/library/metadata/1/thumb/2')).toBe('plex')
    expect(posterKind('/Items/abc-123/Images/Primary?tag=x')).toBe('jellyfin')
    expect(posterKind('/admin/users')).toBeNull()
    expect(posterKind('http://evil/library/x')).toBeNull()
    expect(posterKind(undefined)).toBeNull()
    expect(posterKind(['/library/1'])).toBeNull()
  })

  it('rejects traversal segments', () => {
    expect(posterKind('/library/../accounts')).toBeNull()
    expect(posterKind('/Items/abc/Images/../../Users')).toBeNull()
  })

  it('accepts every stored art shape', () => {
    for (const p of [
      '/library/metadata/123/thumb',             // grouped watch-history rows
      '/library/metadata/123/thumb/1699999999',  // items, seasons, episodes
      '/library/metadata/123/art/1699999999',
      '/library/metadata/123/banner/1699999999',
      '/library/metadata/123/clearLogo/1699999999',
      '/library/collections/45/composite/1699999999',
      '/library/collections/45/composite/1699999999?width=400&height=600',
    ]) expect(posterKind(p), p).toBe('plex')
    for (const p of [
      '/Items/0123456789abcdef0123456789abcdef/Images/Primary',
      '/Items/0123456789abcdef0123456789abcdef/Images/Primary?tag=9f8e7d',
      '/Items/0123456789abcdef0123456789abcdef/Images/Backdrop/0',
    ]) expect(posterKind(p), p).toBe('jellyfin')
  })

  it('rejects encoded traversal, however deeply encoded', () => {
    expect(posterKind('/library/%2e%2e/identity')).toBeNull()      // the audit's probe
    expect(posterKind('/library/%2E%2E/identity')).toBeNull()
    expect(posterKind('/library/%252e%252e/identity')).toBeNull()  // double-encoded
    expect(posterKind('/library/metadata/1/thumb/%2e%2e/%2e%2e/identity')).toBeNull()
    expect(posterKind('/Items/abc/Images/Primary/%2e%2e/%2e%2e/%2e%2e/System/Info')).toBeNull()
    expect(posterKind('/library/%E0%A4%A')).toBeNull()               // malformed escape
  })

  it('rejects non-image Plex endpoints that still sit under /library/', () => {
    for (const p of [
      '/library/sections',
      '/library/sections/1/all',
      '/library/sections/1/refresh',          // a GET that starts a scan
      '/library/metadata/123',                // metadata JSON
      '/library/metadata/123/children',
      '/library/metadata/123/theme/1699999999', // audio, not art
      '/library/parts/5/1699999999/file.mkv', // the media itself
      '/library/onDeck',
    ]) expect(posterKind(p), p).toBeNull()
  })

  it('rejects query/fragment smuggling and odd characters', () => {
    for (const p of [
      '/library/metadata/1/thumb/2?X-Plex-Token=other',
      '/library/metadata/1/thumb/2%3Fx%3D1',
      '/library/metadata/1/thumb/2%253Fx',
      '/library/metadata/1/thumb/2#frag',
      '/library/metadata/1/thumb/2%23frag',
      '/library\\metadata\\1\\thumb',
      '/library/metadata/1/thumb/2%5C..',
      '/library/metadata/1/thumb/2 ',
      '/library/metadata/1/thumb/2%0d%0aX: y',
      '//evil.example/library/metadata/1/thumb',
      '/Items/abc/Images/Primary?tag=x&api_key=y',
      '/Items/abc/Images/Primary?tag=x%26format=svg',
      '/Items/abc/Images/Primary?tag=../x',
      '/library/collections/45/composite/1?width=400&url=/identity',
      '/library/metadata/1/thumb/' + 'x'.repeat(1100),
    ]) expect(posterKind(p), p).toBeNull()
  })

  it('accepts a Plex transcode URL only around an allowed inner path', () => {
    const ok = parsePosterPath('/photo/:/transcode?width=300&height=450&url=%2Flibrary%2Fmetadata%2F1%2Fthumb%2F2')
    expect(ok).toMatchObject({ kind: 'plex', path: '/library/metadata/1/thumb/2', width: 300 })
    expect(posterKind('/photo/:/transcode?width=300&url=/library/sections')).toBeNull()
    expect(posterKind('/photo/:/transcode?width=300&url=%2Flibrary%2F%252e%252e%2Fidentity')).toBeNull()
    expect(posterKind('/photo/:/transcode?width=300&url=http://evil/x.jpg')).toBeNull()
    expect(posterKind('/photo/:/transcode?width=300&X-Plex-Token=t&url=/library/metadata/1/thumb')).toBeNull()
    expect(posterKind('/photo/:/transcode?width=300&url=/photo/:/transcode')).toBeNull()
    expect(posterKind('/photo/:/transcode?width=300')).toBeNull()
  })
})

describe('upstreamUrl', () => {
  it('fetches the original Plex art when no width is asked for', () => {
    expect(upstreamUrl('/library/metadata/1/thumb/2', { ...PLEX })).toBe(
      'http://plex:32400/library/metadata/1/thumb/2?X-Plex-Token=tok'
    )
  })

  it('routes sized Plex requests through the photo transcoder', () => {
    const url = new URL(upstreamUrl('/library/metadata/1/thumb/2', { ...PLEX, width: '300' }))
    expect(url.pathname).toBe('/photo/:/transcode')
    expect(url.searchParams.get('width')).toBe('360')
    expect(url.searchParams.get('height')).toBe('1440')
    expect(url.searchParams.get('upscale')).toBe('0')
    expect(url.searchParams.get('url')).toBe('/library/metadata/1/thumb/2')
    expect(url.searchParams.get('X-Plex-Token')).toBe('tok')
  })

  it('adds maxWidth to Jellyfin paths with or without a query string', () => {
    expect(upstreamUrl('/Items/abc/Images/Primary', { ...JF, width: 240 })).toBe(
      'http://jf:8096/Items/abc/Images/Primary?maxWidth=240&quality=85'
    )
    expect(upstreamUrl('/Items/abc/Images/Primary?tag=t1', { ...JF, width: 240 })).toBe(
      'http://jf:8096/Items/abc/Images/Primary?tag=t1&maxWidth=240&quality=85'
    )
    expect(upstreamUrl('/Items/abc/Images/Primary?tag=t1', { ...JF })).toBe(
      'http://jf:8096/Items/abc/Images/Primary?tag=t1'
    )
  })

  it('refuses paths that fail validation', () => {
    expect(upstreamUrl('/web/index.html', { ...PLEX, width: 240 })).toBeNull()
    expect(upstreamUrl('/library/%2e%2e/identity', { ...PLEX })).toBeNull()
    expect(upstreamUrl('/library/sections', { ...PLEX, width: 240 })).toBeNull()
  })

  it('rebuilds the URL from the parsed path, so it stays on the configured server', () => {
    // An encoded-but-harmless path is sent in its canonical form
    expect(upstreamUrl('/library/metadata/%31/thumb/2', { ...PLEX })).toBe(
      'http://plex:32400/library/metadata/1/thumb/2?X-Plex-Token=tok'
    )
    // A transcode path is re-issued as our own transcode of the inner image
    const url = new URL(upstreamUrl('/photo/:/transcode?width=300&upscale=1&url=/library/metadata/1/thumb/2', { ...PLEX }))
    expect(url.origin).toBe('http://plex:32400')
    expect(url.searchParams.get('url')).toBe('/library/metadata/1/thumb/2')
    expect(url.searchParams.get('width')).toBe('360')
    expect(url.searchParams.get('upscale')).toBe('0')
    // Collection composites keep their canvas size and append the token correctly
    expect(upstreamUrl('/library/collections/4/composite/9?width=400&height=600', { ...PLEX })).toBe(
      'http://plex:32400/library/collections/4/composite/9?width=400&height=600&X-Plex-Token=tok'
    )
    // No configured server → nothing to fetch
    expect(upstreamUrl('/library/metadata/1/thumb/2', { plexUrl: null, plexToken: 'tok' })).toBeNull()
  })
})
