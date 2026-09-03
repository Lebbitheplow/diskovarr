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
const nfo = nodeRequire('../tuberr/lib/nfo.js')
const janitor = nodeRequire('../tuberr/lib/janitor.js')
const config = nodeRequire('../tuberr/config.js')

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
    expect(parsed.attempt).toBe(0)
    expect(parsed.infoHash).toBe(built.infoHash)
    expect(parsed.name).toBe('A.S01E02.720p.WEB-DL-TUBERR')
    expect(parsed.size).toBe(999)
  })

  it('different videos yield different infohashes', () => {
    const a = torrent.buildTorrent({ releaseTitle: 'T.S01E01.WEB-DL-TUBERR', sizeBytes: 100, videoId: 'video-one01' })
    const b = torrent.buildTorrent({ releaseTitle: 'T.S01E01.WEB-DL-TUBERR', sizeBytes: 100, videoId: 'video-two02' })
    expect(a.infoHash).not.toBe(b.infoHash)
  })

  it('changes the infohash per download attempt and still recovers the videoId', () => {
    const base = { releaseTitle: 'T.S01E01.WEB-DL-TUBERR', sizeBytes: 100, videoId: 'video-one01' }
    const first = torrent.buildTorrent(base)
    const retry = torrent.buildTorrent({ ...base, attempt: 1 })
    const retry2 = torrent.buildTorrent({ ...base, attempt: 2 })
    expect(retry.infoHash).not.toBe(first.infoHash)
    expect(retry2.infoHash).not.toBe(retry.infoHash)
    // attempt 0 is encoded exactly like a pre-counter torrent
    expect(torrent.buildTorrent({ ...base, attempt: 0 }).infoHash).toBe(first.infoHash)
    const parsed = torrent.parseTorrent(retry2.buffer)
    expect(parsed.videoId).toBe('video-one01')
    expect(parsed.attempt).toBe(2)
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

  it('builds the series+SxxExx prefix used for blocklist matching', () => {
    expect(naming.releasePrefix('Angry Video Game Nerd', 16, 6)).toBe('Angry.Video.Game.Nerd.S16E06')
    expect(naming.buildReleaseTitle('Angry Video Game Nerd', 16, 6, 'Garfield').startsWith(naming.releasePrefix('Angry Video Game Nerd', 16, 6) + '.')).toBe(true)
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

  it('matches generic TVDB titles ("Episode N") on number + date signals', () => {
    // e.g. FF7 Machinabridged: TVDB titles are just "Episode 1"…
    const ep = episode({ episode_title: 'Episode 5', episode: 5 })
    const rightVideo = video({ title: 'Final Fantasy 7: Machinabridged (FF7MA) - Ep. 5 - TeamFourStar' })
    const wrongNumber = video({ title: 'Final Fantasy 7: Machinabridged (FF7MA) - Ep. 9 - TeamFourStar' })
    const noNumber = video({ title: 'FF7MA Movie Bloopers - TeamFourStar' })
    expect(matcher.scorePair(ep, rightVideo, ctx)).toBeGreaterThan(matcher.AUTO_THRESHOLD)
    expect(matcher.scorePair(ep, wrongNumber, ctx)).toBeLessThan(matcher.AUTO_THRESHOLD)
    expect(matcher.scorePair(ep, noNumber, ctx)).toBeLessThan(matcher.AUTO_THRESHOLD)
  })

  it('strips branding from the episode title too, not just the video title', () => {
    // B&B TVDB titles repeat the hosts: "The Dock of Dreams with Trixie and Katya"
    const bbCtx = { ...ctx, seriesTitle: 'The Bald And The Beautiful', channelTitle: 'Trixie & Katya' }
    const ep = episode({ episode_title: 'The Dock of Dreams with Trixie and Katya', air_date: '2023-04-11' })
    const vid = video({
      title: 'The Dock of Dreams with Trixie and Katya | The Bald and the Beautiful with Trixie and Katya Podcast',
      published_at: '2023-04-11T17:15:11Z',
      duration_sec: 3466,
    })
    expect(matcher.scorePair(ep, vid, bbCtx)).toBeGreaterThan(matcher.AUTO_THRESHOLD)
  })

  it('matches when the episode title is contained in a noisier video title', () => {
    // AVGN "ToeJam & Earl (Sega Genesis)" vs the video with guest + series suffix
    const ep = episode({ episode_title: 'ToeJam & Earl (Sega Genesis)', episode: 19 })
    const noisy = video({ title: 'ToeJam & Earl with Scott the Woz (Sega Genesis) - Angry Video Game Nerd (AVGN)' })
    expect(matcher.scorePair(ep, noisy, { ...ctx, seriesTitle: 'Angry Video Game Nerd', channelTitle: 'Cinemassacre' }))
      .toBeGreaterThan(matcher.AUTO_THRESHOLD)
    // same containment but a decade-old upload date must stay below threshold
    const old = video({ title: 'ToeJam & Earl (Sega Genesis) James & Mike Mondays', published_at: '2014-03-24T15:00:00Z' })
    expect(matcher.scorePair(ep, old, { ...ctx, seriesTitle: 'Angry Video Game Nerd', channelTitle: 'Cinemassacre' }))
      .toBeLessThan(matcher.AUTO_THRESHOLD)
  })

  it('uses the absolute number from generic titles, not the per-season number', () => {
    // TVDB S02E01 titled "Episode 11" must match "Ep. 11", not "Part 1"/"Part 2"
    const ep = episode({ season: 2, episode: 1, episode_title: 'Episode 11' })
    const absolute = video({ title: 'My Web Series - Ep. 11' })
    const perSeason = video({ title: 'Some Other Thing (PART 1)' })
    expect(matcher.scorePair(ep, absolute, ctx)).toBeGreaterThan(matcher.AUTO_THRESHOLD)
    expect(matcher.scorePair(ep, perSeason, ctx)).toBeLessThan(matcher.AUTO_THRESHOLD)
  })
})

// Real titles from the 2026-09-02 audit — every case was < 0.70 before.
describe('matcher regressions (short titles, segments, counters)', () => {
  const T = matcher.AUTO_THRESHOLD
  const avgn = {
    seriesTitle: 'Angry Video Game Nerd', channelTitle: 'Cinemassacre', runtimeSec: 0, seasonIndexOf: new Map(),
    seasonCounts: new Map([[12, 9], [16, 6]]),
  }
  const botw = {
    seriesTitle: 'Best of the Worst', channelTitle: 'RedLetterMedia', runtimeSec: 0, seasonIndexOf: new Map(),
    seasonCounts: new Map([[2014, 14], [2017, 14]]),
  }
  const snapcube = {
    seriesTitle: 'SnapCubes Real Time Fandub', channelTitle: 'SnapCube', runtimeSec: 0, seasonIndexOf: new Map(),
    seasonCounts: new Map([[2020, 1]]),
  }
  const ep = (season, episode, episode_title, air_date) => ({ season, episode, episode_title, air_date, source: 'auto' })
  const vid = (title, published_at, duration_sec = 1500, over = {}) => ({
    video_id: title, title, description: '', published_at, duration_sec, playlist_id: null, position: -1, status: 'ok', ...over,
  })

  it('matches one-word AVGN titles through the "<title> - <series> (<acronym>)" segment', () => {
    const garfield = ep(16, 6, 'Garfield', '2022-12-22')
    expect(matcher.scorePair(garfield, vid('Garfield - Angry Video Game Nerd (AVGN)', '2022-12-22T18:30:24Z', 1576), avgn))
      .toBeGreaterThanOrEqual(T)
    expect(matcher.scorePair(garfield, vid('Garfield Kart - James and Mike Mondays', '2020-04-20T19:30:02Z', 1096), avgn))
      .toBeLessThan(T)
    expect(matcher.scorePair(garfield, vid("Garfield's Halloween Adventure (1980s) - Monster Madness 2023", '2023-10-12T19:31:14Z', 956), avgn))
      .toBeLessThan(T)

    const doom = ep(16, 5, 'DOOM', '2022-10-30')
    expect(matcher.scorePair(doom, vid('DOOM - Angry Video Game Nerd (AVGN)', '2022-10-30T23:02:39Z', 1749), avgn))
      .toBeGreaterThanOrEqual(T)
    expect(matcher.scorePair(doom, vid('DOOM: The Shores of Hell - James & Mike Mondays', '2016-07-18T04:44:43Z', 907), avgn))
      .toBeLessThan(T)
  })

  it('ignores platform tags and the series acronym', () => {
    expect(matcher.stripNoise('Earthbound (SNES) - Angry Video Game Nerd (AVGN)', 'Angry Video Game Nerd', 'Cinemassacre'))
      .toBe('earthbound')
    expect(matcher.stripNoise('Castlevania (Sega Genesis) [4K] Full Episode', 'Angry Video Game Nerd', 'Cinemassacre'))
      .toBe('castlevania')
    const earthbound = ep(12, 1, 'EarthBound', '2018-04-18')
    expect(matcher.scorePair(earthbound, vid('Earthbound (SNES) - Angry Video Game Nerd (AVGN)', '2018-04-25T18:45:34Z', 2371), avgn))
      .toBeGreaterThanOrEqual(T)
    expect(matcher.scorePair(earthbound, vid("Earthbound Scratch N' Sniff Nintendo Power Magazines (James & Mike)", '2018-04-30T10:10:02Z', 603), avgn))
      .toBeLessThan(T)
  })

  it('normalizes leading zeros so "#07" equals "#7"', () => {
    expect(matcher.normalize('Wheel of the Worst #07')).toBe('wheel of the worst 7')
    const wheel = ep(2014, 12, 'The Wheel of the Worst #07', '2014-12-18')
    expect(matcher.scorePair(wheel, vid('Best of the Worst: Wheel of the Worst #7', '2014-12-24T07:18:12Z', 3296), botw))
      .toBeGreaterThanOrEqual(T)
    expect(matcher.scorePair(wheel, vid('Best of the Worst: Wheel of the Worst #8', '2015-05-28T06:01:28Z', 3100), botw))
      .toBeLessThan(T)
  })

  it('treats a number beyond the season length as an absolute counter, not a mismatch', () => {
    const plinketto = ep(2017, 1, 'Plinketto #03', '2017-02-05')
    const v = vid('Best of the Worst: Episode 48: Plinketto #3', '2017-02-05T23:07:13Z', 3399)
    expect(matcher.scorePair(plinketto, v, botw)).toBeGreaterThanOrEqual(T)
    // without season counts the "Episode 48" still zeroes the number signal
    expect(matcher.scorePair(plinketto, v, { ...botw, seasonCounts: undefined }))
      .toBeLessThan(matcher.scorePair(plinketto, v, botw))
  })

  it('credits a video segment that equals one segment of a multi-part episode title', () => {
    const sonic = ep(2020, 1, "Sonic Riders: SnapCube's Real-Time Fandub and the Necessity of Change", '2020-03-14')
    expect(matcher.scorePair(sonic, vid('Sonic Riders | Real-Time Fandub Games', '2020-03-15T00:30:10Z', 4031), snapcube))
      .toBeGreaterThanOrEqual(T)
  })

  it('penalizes trailers/teasers/clips', () => {
    const sonic = ep(2020, 1, "Sonic Riders: SnapCube's Real-Time Fandub and the Necessity of Change", '2020-03-14')
    // long enough not to be filtered as a Short, published on the air date: only the penalty keeps it out
    const trailer = vid('Sonic Riders (TRAILER) | Real-Time Fandub Games', '2020-03-14T21:39:07Z', 300)
    expect(matcher.scorePair(sonic, trailer, snapcube)).toBeLessThan(T)
    const full = vid('Sonic Riders | Real-Time Fandub Games', '2020-03-14T21:39:07Z', 300)
    expect(matcher.scorePair(sonic, full, snapcube) - matcher.scorePair(sonic, trailer, snapcube)).toBeGreaterThan(0.25)
  })

  it('allows containment for a single long token but not a short one', () => {
    const garfield = ep(16, 6, 'Garfield', '2022-12-22')
    const noisy = vid('Garfield Kart Furious Racing Review', '2022-12-22T18:30:24Z', 1576)
    expect(matcher.titleScore(garfield.episode_title, noisy.title, avgn)).toBeGreaterThanOrEqual(0.95)
    expect(matcher.titleScore('DOOM', 'DOOM 64 (N64) Retrospective', avgn)).toBeLessThan(0.95)
  })

  it('accepts a generic-title episode on date alone when it is the only nearby upload', () => {
    const ctx = { seriesTitle: 'My Web Series', channelTitle: 'MyChannel', runtimeSec: 1200, seasonIndexOf: new Map() }
    const generic = ep(1, 5, 'Episode 5', '2024-06-01')
    const only = vid('A fun upload with no number in it', '2024-06-01T15:00:00Z', 1300, { video_id: 'only' })
    const other = vid('Another upload the same week', '2024-06-02T15:00:00Z', 1300, { video_id: 'other' })
    // without the index (old behaviour) the best a numberless video can do is 0.675
    expect(matcher.scorePair(generic, only, ctx)).toBeLessThan(T)
    const sole = { ...ctx, soleNearbyVideo: matcher.nearbyVideoIndex([generic], [only]) }
    expect(matcher.scorePair(generic, only, sole)).toBe(T)
    const ambiguous = { ...ctx, soleNearbyVideo: matcher.nearbyVideoIndex([generic], [only, other]) }
    expect(matcher.scorePair(generic, only, ambiguous)).toBeLessThan(T)
    // a trailer on the right date does not qualify
    const trailer = vid('Episode trailer', '2024-06-01T15:00:00Z', 1300, { video_id: 'only' })
    expect(matcher.scorePair(generic, trailer, sole)).toBeLessThan(T)
  })
})

describe('nfo', () => {
  it('builds a Kodi episodedetails document from yt-dlp info json', () => {
    const info = {
      id: 'QYlAed4EaPc', title: 'Garfield - Angry Video Game Nerd (AVGN)', channel: 'Cinemassacre',
      description: 'The Nerd plays Garfield <on NES> & more', upload_date: '20221222', duration: 1576,
      thumbnail: 'https://i.ytimg.com/vi/QYlAed4EaPc/maxresdefault.jpg',
    }
    const xml = nfo.buildEpisodeNfo(nfo.fromInfoJson(info, { showTitle: 'Angry Video Game Nerd', season: 16, episode: 6, title: 'Garfield' }))
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails>')).toBe(true)
    expect(xml).toContain('<title>Garfield</title>')
    expect(xml).toContain('<showtitle>Angry Video Game Nerd</showtitle>')
    expect(xml).toContain('<season>16</season>')
    expect(xml).toContain('<episode>6</episode>')
    expect(xml).toContain('<plot>The Nerd plays Garfield &lt;on NES&gt; &amp; more</plot>')
    expect(xml).toContain('<aired>2022-12-22</aired>')
    expect(xml).toContain('<runtime>26</runtime>')
    expect(xml).toContain('<thumb>https://i.ytimg.com/vi/QYlAed4EaPc/maxresdefault.jpg</thumb>')
    expect(xml).toContain('<uniqueid type="youtube" default="true">QYlAed4EaPc</uniqueid>')
    expect(xml.trim().endsWith('</episodedetails>')).toBe(true)
  })

  it('omits unknown fields instead of writing empty tags', () => {
    const xml = nfo.buildEpisodeNfo(nfo.fromInfoJson({ id: 'abc', title: 'T' }, {}))
    expect(xml).not.toContain('<season>')
    expect(xml).not.toContain('<aired>')
    expect(xml).not.toContain('<runtime>')
    expect(xml).toContain('<uniqueid type="youtube" default="true">abc</uniqueid>')
  })
})

describe('janitor safety', () => {
  it('only ever deletes paths strictly inside the downloads dir', () => {
    expect(janitor.insideDownloadsDir(path.join(config.downloadsDir, 'tv-youtube', 'Some.Release'))).toBe(true)
    expect(janitor.insideDownloadsDir(config.downloadsDir)).toBe(false)
    expect(janitor.insideDownloadsDir(config.downloadsDir + '-sibling/x')).toBe(false)
    expect(janitor.insideDownloadsDir(path.join(config.downloadsDir, '..', 'escape'))).toBe(false)
    expect(janitor.insideDownloadsDir('/NAS/YT Videos/Show/Season 1')).toBe(false)
    expect(janitor.insideDownloadsDir('')).toBe(false)
    expect(janitor.insideDownloadsDir(null)).toBe(false)
  })
})
