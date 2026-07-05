const { db } = require('../db');
const youtube = require('./youtube');
const mappingsLib = require('./mappings');
const sonarr = require('./sonarr');

// Scores every (episode, video) pair and greedily assigns best-first, each
// video used at most once. ≥ AUTO_THRESHOLD becomes the match; everything
// keeps its top candidates for the review UI. Manual matches are never touched.

const AUTO_THRESHOLD = 0.70;
const CANDIDATES_KEPT = 5;
const MIN_DURATION_SEC = 120; // filters Shorts/teasers

const WEIGHTS = { title: 0.45, number: 0.20, date: 0.20, position: 0.10, duration: 0.05 };

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strips series/channel branding and episode-numbering noise from a video
// title so what remains is comparable to the TVDB episode title.
function stripNoise(videoTitle, seriesTitle, channelTitle) {
  let t = ` ${normalize(videoTitle)} `;
  for (const brand of [seriesTitle, channelTitle]) {
    const b = normalize(brand);
    if (b) t = t.split(` ${b} `).join(' ');
  }
  t = t.replace(/\b(?:ep|episode|part|pt|chapter)\s*\d+\b/g, ' ')
    .replace(/\bs\d{1,2}\s*e\d{1,3}\b/g, ' ')
    .replace(/#\s*\d+\b/g, ' ')
    .replace(/\b(?:official|full episode|4k|hd)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

function tokenSetScore(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function diceBigram(a, b) {
  const grams = (s) => {
    const out = new Map();
    const t = s.replace(/\s+/g, ' ');
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of ga) { inter += Math.min(n, gb.get(g) || 0) * 2; total += n; }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : inter / total;
}

function extractEpisodeNumber(videoTitle, description) {
  const sources = [videoTitle, (description || '').slice(0, 200)];
  for (const src of sources) {
    const t = String(src || '');
    let m = /\bs(\d{1,2})\s*[.e]\s*(\d{1,3})\b/i.exec(t);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
    m = /\b(?:ep|episode|part|pt|chapter)\.?\s*(\d{1,3})\b/i.exec(t);
    if (m) return { episode: Number(m[1]) };
    m = /[|\-–—]\s*#?(\d{1,3})\s*$/.exec(t.trim());
    if (m) return { episode: Number(m[1]) };
  }
  return null;
}

function dateScore(publishedAt, airDate) {
  if (!publishedAt || !airDate) return 0.5;
  const pub = Date.parse(publishedAt);
  const air = Date.parse(airDate + 'T12:00:00Z');
  if (!Number.isFinite(pub) || !Number.isFinite(air)) return 0.5;
  const days = Math.abs(pub - air) / 86400000;
  return Math.exp(-((days / 7) ** 2));
}

function scorePair(episode, video, ctx) {
  if (video.status !== 'ok') return 0;
  const cleanVideo = stripNoise(video.title, ctx.seriesTitle, ctx.channelTitle);
  const cleanEp = normalize(episode.episode_title);
  const title = cleanEp
    ? Math.max(tokenSetScore(cleanEp, cleanVideo), diceBigram(cleanEp, cleanVideo))
    : 0.5;

  const extracted = extractEpisodeNumber(video.title, video.description);
  let number = 0.5;
  if (extracted) {
    if (extracted.season !== undefined && extracted.season !== episode.season) number = 0;
    else number = extracted.episode === episode.episode ? 1 : 0;
  }

  const date = dateScore(video.published_at, episode.air_date);

  let position = 0.5;
  if (video.playlist_id && video.position >= 0 && ctx.seasonIndexOf) {
    const idx = ctx.seasonIndexOf.get(`${episode.season}:${episode.episode}`);
    position = idx !== undefined && idx === video.position ? 1 : 0;
  }

  let duration = 1;
  if (video.duration_sec > 0) {
    if (video.duration_sec < MIN_DURATION_SEC) duration = 0;
    else if (ctx.runtimeSec > 0) {
      const ratio = video.duration_sec / ctx.runtimeSec;
      duration = ratio >= 0.4 && ratio <= 2.5 ? 1 : 0;
    }
  }

  return WEIGHTS.title * title + WEIGHTS.number * number + WEIGHTS.date * date +
    WEIGHTS.position * position + WEIGHTS.duration * duration;
}

async function autoMatch(mappingId, { refresh = true } = {}) {
  const mapping = mappingsLib.getMapping(mappingId);
  if (!mapping) throw new Error(`mapping ${mappingId} not found`);
  if (!mapping.channel_id && JSON.parse(mapping.playlist_ids || '[]').length === 0) return null;

  if (refresh) await youtube.refreshVideos(mapping);
  const videos = db.prepare("SELECT * FROM videos WHERE mapping_id = ? AND status = 'ok'").all(mapping.id);
  const episodes = db.prepare('SELECT * FROM episode_matches WHERE mapping_id = ? ORDER BY season, episode')
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
  const ctx = { seriesTitle: mapping.title, channelTitle: mapping.channel_title, runtimeSec, seasonIndexOf };

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
  return { matched, episodes: episodes.length, ...status };
}

module.exports = { autoMatch, scorePair, normalize, stripNoise, extractEpisodeNumber, dateScore, AUTO_THRESHOLD };
