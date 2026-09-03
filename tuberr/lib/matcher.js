const { db } = require('../db');
const youtube = require('./youtube');
const mappingsLib = require('./mappings');
const sonarr = require('./sonarr');
const scoring = require('./scoring');

// Scores every (episode, video) pair and greedily assigns best-first, each
// video used at most once. ≥ AUTO_THRESHOLD becomes the match; everything
// keeps its top candidates for the review UI. Manual matches are never touched
// and skipped episodes are left alone entirely.

const { AUTO_THRESHOLD, scorePair } = scoring;
const CANDIDATES_KEPT = 5;

// refresh: true/'full' → rebuild the video pool; 'incremental' → only fetch
// unseen uploads (full rebuild weekly); false → score the pool as-is.
async function autoMatch(mappingId, { refresh = true } = {}) {
  const mapping = mappingsLib.getMapping(mappingId);
  if (!mapping) throw new Error(`mapping ${mappingId} not found`);
  if (!mapping.channel_id && JSON.parse(mapping.playlist_ids || '[]').length === 0) return null;

  if (refresh) await youtube.refreshVideos(mapping, { incremental: refresh === 'incremental' });
  const videos = db.prepare("SELECT * FROM videos WHERE mapping_id = ? AND status = 'ok'").all(mapping.id);
  const episodes = db.prepare('SELECT * FROM episode_matches WHERE mapping_id = ? AND skipped = 0 ORDER BY season, episode')
    .all(mapping.id);
  if (videos.length === 0 || episodes.length === 0) return { matched: 0, episodes: episodes.length };

  let runtimeSec = 0;
  if (mapping.sonarr_series_id) {
    try {
      const series = await sonarr.sonarrFetch(`/series/${mapping.sonarr_series_id}`);
      runtimeSec = (series.runtime || 0) * 60;
    } catch { /* runtime is a soft signal */ }
  }
  const seasonIndexOf = new Map();
  const bySeason = new Map();
  for (const e of episodes) {
    if (!bySeason.has(e.season)) bySeason.set(e.season, 0);
    seasonIndexOf.set(`${e.season}:${e.episode}`, bySeason.get(e.season));
    bySeason.set(e.season, bySeason.get(e.season) + 1);
  }
  const seasonCounts = new Map();
  for (const r of db.prepare('SELECT season, COUNT(*) AS n FROM episode_matches WHERE mapping_id = ? GROUP BY season').all(mapping.id)) {
    seasonCounts.set(r.season, r.n);
  }
  const ctx = {
    seriesTitle: mapping.title,
    channelTitle: mapping.channel_title,
    runtimeSec,
    seasonIndexOf,
    seasonCounts,
    soleNearbyVideo: scoring.nearbyVideoIndex(episodes, videos),
  };

  const pairs = [];
  const candidatesByEp = new Map();
  for (const ep of episodes) {
    const scored = [];
    for (const v of videos) {
      const score = scorePair(ep, v, ctx);
      if (score > 0.2) scored.push({ videoId: v.video_id, title: v.title, publishedAt: v.published_at, score });
    }
    scored.sort((a, b) => b.score - a.score);
    candidatesByEp.set(`${ep.season}:${ep.episode}`, scored.slice(0, CANDIDATES_KEPT));
    for (const c of scored.slice(0, CANDIDATES_KEPT)) {
      pairs.push({ ep, videoId: c.videoId, score: c.score });
    }
  }

  pairs.sort((a, b) => b.score - a.score);
  const assignedEps = new Set();
  const assignedVideos = new Set();
  // Manually matched episodes keep their videos reserved
  for (const ep of episodes) {
    if (ep.source === 'manual' && ep.video_id) {
      assignedEps.add(`${ep.season}:${ep.episode}`);
      assignedVideos.add(ep.video_id);
    }
  }
  const assignment = new Map();
  for (const { ep, videoId, score } of pairs) {
    const key = `${ep.season}:${ep.episode}`;
    if (score < AUTO_THRESHOLD || assignedEps.has(key) || assignedVideos.has(videoId)) continue;
    assignment.set(key, { videoId, score });
    assignedEps.add(key);
    assignedVideos.add(videoId);
  }

  const update = db.prepare(`
    UPDATE episode_matches SET video_id = ?, confidence = ?, broken = 0, candidates_json = ?
    WHERE mapping_id = ? AND season = ? AND episode = ? AND source != 'manual'
  `);
  const updateCandidatesOnly = db.prepare(`
    UPDATE episode_matches SET candidates_json = ? WHERE mapping_id = ? AND season = ? AND episode = ?
  `);
  let matched = 0;
  for (const ep of episodes) {
    const key = `${ep.season}:${ep.episode}`;
    const candidates = JSON.stringify(candidatesByEp.get(key) || []);
    if (ep.source === 'manual') {
      updateCandidatesOnly.run(candidates, mapping.id, ep.season, ep.episode);
      if (ep.video_id) matched++;
      continue;
    }
    const hit = assignment.get(key) || { videoId: null, score: 0 };
    update.run(hit.videoId, hit.score, candidates, mapping.id, ep.season, ep.episode);
    if (hit.videoId) matched++;
  }
  const status = mappingsLib.refreshMatchStatus(mapping.id);
  console.log(`[matcher] mapping ${mapping.id} (${mapping.title}): ${matched}/${episodes.length} matched`);
  const searched = await searchMissingInSonarr(mapping);
  return { matched, episodes: episodes.length, searched, ...status };
}

// Sonarr never searches its back-catalog by itself — RSS sync only covers
// newly published releases. So after every match run, ask Sonarr to search
// every episode that is matched here AND monitored + missing there. Idempotent:
// imported episodes drop out via hasFile, failed videos drop out via broken.
// Capped per run: episode searches also fan out to the admin's untagged
// regular indexers (Sonarr tags can't exclude them), so a 200-episode burst
// rate-limits Prowlarr and clogs Sonarr's command queue. The remainder is
// picked up by subsequent scheduler cycles.
const SEARCH_BATCH_LIMIT = 25;

async function searchMissingInSonarr(mapping) {
  if (!mapping.sonarr_series_id) return 0;
  try {
    const sonarrEpisodes = await sonarr.getEpisodes(mapping.sonarr_series_id);
    const byId = new Map(sonarrEpisodes.map(e => [e.id, e]));
    const rows = db.prepare(`
      SELECT sonarr_episode_id FROM episode_matches
      WHERE mapping_id = ? AND video_id IS NOT NULL AND broken = 0 AND skipped = 0 AND sonarr_episode_id IS NOT NULL
      ORDER BY season DESC, episode DESC
    `).all(mapping.id);
    const searchIds = [];
    for (const row of rows) {
      const e = byId.get(row.sonarr_episode_id);
      if (e && e.monitored && !e.hasFile) searchIds.push(e.id);
    }
    const batch = searchIds.slice(0, SEARCH_BATCH_LIMIT);
    if (batch.length) {
      await sonarr.episodeSearch(batch);
      console.log(`[matcher] "${mapping.title}": asked Sonarr to search ${batch.length}/${searchIds.length} missing monitored episode(s)`);
    }
    return batch.length;
  } catch (e) {
    console.error(`[matcher] Sonarr search request failed for "${mapping.title}": ${e.message}`);
    return 0;
  }
}

module.exports = {
  autoMatch, searchMissingInSonarr,
  // scoring re-exports (tests and channelDetect use these)
  scorePair, titleScore: scoring.titleScore, normalize: scoring.normalize, stripNoise: scoring.stripNoise,
  extractEpisodeNumber: scoring.extractEpisodeNumber, dateScore: scoring.dateScore,
  nearbyVideoIndex: scoring.nearbyVideoIndex, isGenericEpisodeTitle: scoring.isGenericEpisodeTitle,
  AUTO_THRESHOLD,
};
