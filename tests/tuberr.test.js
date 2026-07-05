import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

// Tuberr resolves its data dir at import time; point it at a throwaway
// directory BEFORE loading so tests never touch a live database.
process.env.TUBERR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tuberr-test-'))

// Load through Node's CommonJS loader so every module shares the same db
// instance (Vitest's ESM import would create a second transformed copy).
const nodeRequire = createRequire(import.meta.url)
const bencode = nodeRequire('../tuberr/lib/bencode.js')
const torrent = nodeRequire('../tuberr/lib/torrent.js')
const naming = nodeRequire('../tuberr/lib/naming.js')
const matcher = nodeRequire('../tuberr/lib/matcher.js')

describe('bencode', () => {
  it('encodes with sorted dict keys', () => {
    const buf = bencode.encode({ zebra: 1, apple: 'x' })
    expect(buf.toString('utf8')).toBe('d5:apple1:x5:zebrai1ee')
  })

  it('roundtrips nested structures', () => {
    const value = { a: [1, 'two', { b: 3 }], s: 'str' }
    const { value: decoded } = bencode.decode(bencode.encode(value))
    expect(Number(decoded.a[0])).toBe(1)
    expect(decoded.a[1].toString('utf8')).toBe('two')
    expect(Number(decoded.a[2].b)).toBe(3)
  })

  it('computes infohash from the exact serialized info-dict bytes', () => {
    const buf = bencode.encode({ announce: 'http://x/', info: { name: 'n', length: 5 } })
    // independently hash the info dict substring
    const text = buf.toString('latin1')
    const start = text.indexOf('4:info') + 6
    const infoBytes = buf.subarray(start, buf.length - 1) // strip outer trailing 'e'
    const expected = crypto.createHash('sha1').update(infoBytes).digest('hex')
    expect(bencode.infoHashOf(buf)).toBe(expected)
  })
})

describe('torrent', () => {
  it('is deterministic for the same inputs', () => {
    const args = { releaseTitle: 'Show.S01E01.1080p.WEB-DL-TUBERR', sizeBytes: 1234567, videoId: 'dQw4w9WgXcQ' }
    expect(torrent.buildTorrent(args).infoHash).toBe(torrent.buildTorrent(args).infoHash)
  })

  it('recovers the videoId and parses infohash matching build', () => {
    const built = torrent.buildTorrent({ releaseTitle: 'A.S01E02.720p.WEB-DL-TUBERR', sizeBytes: 999, videoId: 'abc123DEF-_' })
    const parsed = torrent.parseTorrent(built.buffer)
    expect(parsed.videoId).toBe('abc123DEF-_')
    expect(parsed.infoHash).toBe(built.infoHash)
    expect(parsed.name).toBe('A.S01E02.720p.WEB-DL-TUBERR')
    expect(parsed.size).toBe(999)
  })

  it('different videos yield different infohashes', () => {
    const a = torrent.buildTorrent({ releaseTitle: 'T.S01E01.WEB-DL-TUBERR', sizeBytes: 100, videoId: 'video-one01' })
    const b = torrent.buildTorrent({ releaseTitle: 'T.S01E01.WEB-DL-TUBERR', sizeBytes: 100, videoId: 'video-two02' })
    expect(a.infoHash).not.toBe(b.infoHash)
  })
})

describe('naming', () => {
  it('builds a Sonarr-parseable release title', () => {
    expect(naming.buildReleaseTitle("Rhett & Link's Buddy System", 1, 5, 'The Ice Cream!'))
      .toBe('Rhett.and.Links.Buddy.System.S01E05.The.Ice.Cream.1080p.WEB-DL-TUBERR')
  })

  it('handles empty episode titles and pads numbers', () => {
    expect(naming.buildReleaseTitle('Show', 2, 3, ''))
      .toBe('Show.S02E03.1080p.WEB-DL-TUBERR')
  })

  it('estimates plausible sizes from duration', () => {
    const oneHour = naming.estimateSizeBytes(3600)
    expect(oneHour).toBe(3600 * 5_000_000 / 8)
    // unknown duration falls back to 45 min
    expect(naming.estimateSizeBytes(0)).toBe(45 * 60 * 5_000_000 / 8)
  })
})

describe('matcher scoring', () => {
  const ctx = { seriesTitle: 'My Web Series', channelTitle: 'MyChannel', runtimeSec: 1200, seasonIndexOf: new Map() }

  const episode = (over = {}) => ({
    season: 1, episode: 5, episode_title: 'The Grand Finale', air_date: '2024-06-01', source: 'auto', ...over,
  })
  const video = (over = {}) => ({
    video_id: 'v1', title: 'My Web Series - The Grand Finale (Ep. 5)', description: '',
    published_at: '2024-06-01T15:00:00Z', duration_sec: 1300, playlist_id: null, position: -1, status: 'ok', ...over,
  })

  it('scores an exact title+number+date match above the auto threshold', () => {
    expect(matcher.scorePair(episode(), video(), ctx)).toBeGreaterThan(matcher.AUTO_THRESHOLD)
  })

  it('penalizes wrong explicit episode numbers', () => {
    const right = matcher.scorePair(episode(), video(), ctx)
    const wrong = matcher.scorePair(episode(), video({ title: 'My Web Series - The Grand Finale (Ep. 9)' }), ctx)
    expect(wrong).toBeLessThan(right)
  })

  it('rejects Shorts via duration', () => {
    const short = matcher.scorePair(episode(), video({ duration_sec: 45 }), ctx)
    const full = matcher.scorePair(episode(), video(), ctx)
    expect(short).toBeLessThan(full)
  })

  it('gives ~zero score to private/removed videos', () => {
    expect(matcher.scorePair(episode(), video({ status: 'private' }), ctx)).toBe(0)
  })

  it('decays date score with distance from air date', () => {
    const near = matcher.dateScore('2024-06-02T00:00:00Z', '2024-06-01')
    const far = matcher.dateScore('2024-09-01T00:00:00Z', '2024-06-01')
    expect(near).toBeGreaterThan(0.9)
    expect(far).toBeLessThan(0.01)
  })

  it('extracts episode numbers from common title shapes', () => {
    expect(matcher.extractEpisodeNumber('Cool Show Ep. 12', '')).toEqual({ episode: 12 })
    expect(matcher.extractEpisodeNumber('Cool Show S2E3', '')).toEqual({ season: 2, episode: 3 })
    expect(matcher.extractEpisodeNumber('Something | 7', '')).toEqual({ episode: 7 })
    expect(matcher.extractEpisodeNumber('No numbers here', '')).toBeNull()
  })

  it('strips series/channel branding and numbering noise', () => {
    expect(matcher.stripNoise('My Web Series - The Pilot (Episode 1)', 'My Web Series', 'MyChannel'))
      .toBe('the pilot')
  })
})
