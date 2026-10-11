import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const { snapWidth, posterKind, upstreamUrl } = nodeRequire('../server/services/posterUpstream.js')

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
  })
})
