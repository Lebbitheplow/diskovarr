const { db } = require('../db');
const youtube = require('./youtube');
const matcher = require('./matcher');
const mappingsLib = require('./mappings');

// Auto-detects the source channel for a channel-less mapping (series tagged
// 'yt' in Sonarr without going through Diskovarr's request flow). Searches
// YouTube for the series title, then probes each candidate channel's uploads
// with the real matcher: the right channel's videos match many episode titles,
// a wrong channel's match almost none. Only commits when the evidence is
// strong; otherwise the mapping stays "needs channel" for manual review.

const MAX_CANDIDATE_CHANNELS = 3;
const MAX_DETECT_ATTEMPTS = 3;

function probeScore(mapping, channel, videos, episodes) {
  const ctx = {
    seriesTitle: mapping.title,
    channelTitle: channel.title,
    runtimeSec: 0,
    seasonIndexOf: null,
  };
  let matched = 0;
  const usedVideos = new Set();
  for (const ep of episodes) {
    let best = 0;
    let bestVid = null;
    for (const v of videos) {
      const score = matcher.scorePair(
        { season: ep.season, episode: ep.episode, episode_title: ep.episode_title, air_date: ep.air_date },
        // durations aren't fetched during probing (saves a videos.list pass per
        // channel); duration_sec 0 keeps that sub-score neutral in scorePair
        { title: v.title, description: v.description, published_at: v.publishedAt, duration_sec: 0, playlist_id: null, position: -1, status: 'ok' },
        ctx,
      );
      if (score > best) { best = score; bestVid = v.videoId; }
    }
    if (best >= matcher.AUTO_THRESHOLD && bestVid && !usedVideos.has(bestVid)) {
      matched++;
      usedVideos.add(bestVid);
    }
  }
  return matched;
}

async function detectChannel(mappingId) {
  const mapping = mappingsLib.getMapping(mappingId);
  if (!mapping) throw new Error(`mapping ${mappingId} not found`);
  if (mapping.channel_id) return { detected: false, reason: 'channel already set' };
  const episodes = db.prepare('SELECT * FROM episode_matches WHERE mapping_id = ?').all(mapping.id);
  if (episodes.length === 0) return { detected: false, reason: 'no episodes synced from Sonarr yet' };

  db.prepare('UPDATE series_mappings SET detect_attempts = detect_attempts + 1 WHERE id = ?').run(mapping.id);

  const candidates = (await youtube.searchChannels(mapping.title)).slice(0, MAX_CANDIDATE_CHANNELS);
  if (candidates.length === 0) return { detected: false, reason: 'no candidate channels found' };

  let best = null;
  for (const channel of candidates) {
    const uploads = youtube.uploadsPlaylistOf(channel.channelId);
    if (!uploads) continue;
    let videos;
    try {
      videos = await youtube.listPlaylistVideos(uploads);
    } catch {
      continue; // channel with hidden/empty uploads — skip
    }
    const matched = probeScore(mapping, channel, videos, episodes);
    console.log(`[detect] "${mapping.title}": candidate "${channel.title}" matched ${matched}/${episodes.length}`);
    if (!best || matched > best.matched) best = { ...channel, matched };
  }

  // Confidence gate: a handful of solid matches and a meaningful share of the
  // series. A wrong channel essentially never clears this.
  const required = Math.min(episodes.length, 3);
  if (!best || best.matched < required || best.matched / episodes.length < 0.3) {
    const reason = best
      ? `best candidate "${best.title}" only matched ${best.matched}/${episodes.length} episodes`
      : 'no probeable candidate channels';
    console.log(`[detect] "${mapping.title}": not confident — ${reason}`);
    return { detected: false, reason, best: best ? { channelId: best.channelId, title: best.title, matched: best.matched } : null };
  }

  db.prepare('UPDATE series_mappings SET channel_id = ?, channel_title = ?, uploads_playlist_id = ? WHERE id = ?')
    .run(best.channelId, best.title, youtube.uploadsPlaylistOf(best.channelId), mapping.id);
  console.log(`[detect] "${mapping.title}" → channel "${best.title}" (${best.matched}/${episodes.length} probe matches) — running full match`);
  const result = await matcher.autoMatch(mapping.id);
  return { detected: true, channel: { channelId: best.channelId, title: best.title }, ...result };
}

function detectableMappings() {
  return db.prepare(`
    SELECT id FROM series_mappings
    WHERE channel_id IS NULL AND detect_attempts < ?
  `).all(MAX_DETECT_ATTEMPTS);
}

module.exports = { detectChannel, detectableMappings };
