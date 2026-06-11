import { describe, it, expect, vi, afterEach } from 'vitest'
import { timeAgo, formatReleaseDate } from '../src/utils/format'
import { posterUrl } from '../src/utils/media'

afterEach(() => vi.useRealTimers())

describe('timeAgo', () => {
  it('returns empty string for falsy input', () => {
    expect(timeAgo(0)).toBe('')
    expect(timeAgo(null)).toBe('')
  })

  it('formats minutes, hours, and days with correct pluralization', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-11T12:00:00Z'))
    const now = Math.floor(Date.now() / 1000)
    expect(timeAgo(now - 30)).toBe('1 min ago') // clamps to at least 1 min
    expect(timeAgo(now - 120)).toBe('2 mins ago')
    expect(timeAgo(now - 3600)).toBe('1 hour ago')
    expect(timeAgo(now - 2 * 3600)).toBe('2 hours ago')
    expect(timeAgo(now - 86400)).toBe('1 day ago')
    expect(timeAgo(now - 3 * 86400)).toBe('3 days ago')
  })
})

describe('formatReleaseDate', () => {
  it('formats YYYY-MM-DD as a readable date', () => {
    expect(formatReleaseDate('2026-06-11')).toBe('Jun 11, 2026')
  })

  it('returns null for empty or invalid input', () => {
    expect(formatReleaseDate('')).toBeNull()
    expect(formatReleaseDate('not-a-date')).toBeNull()
  })
})

describe('posterUrl', () => {
  it('passes absolute URLs through unchanged', () => {
    expect(posterUrl('https://image.tmdb.org/t/p/w500/x.jpg')).toBe('https://image.tmdb.org/t/p/w500/x.jpg')
    expect(posterUrl('http://example.com/p.jpg')).toBe('http://example.com/p.jpg')
  })

  it('proxies Plex paths through /api/poster with encoding', () => {
    expect(posterUrl('/library/metadata/123/thumb/456')).toBe(
      '/api/poster?path=' + encodeURIComponent('/library/metadata/123/thumb/456')
    )
  })

  it('returns null for falsy input', () => {
    expect(posterUrl(null)).toBeNull()
    expect(posterUrl('')).toBeNull()
  })
})
