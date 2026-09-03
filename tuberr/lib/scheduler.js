const { db, getSetting } = require('../db');
const mappingsLib = require('./mappings');
const matcher = require('./matcher');
const sonarr = require('./sonarr');
const youtube = require('./youtube');
const { state } = require('./state');

// Keeps mappings fresh without anyone clicking anything. Two loops:
//  - fast tick (30 min): discover yt-tagged series, then an incremental video
//    poll per active mapping; when new uploads appear, re-sync episodes from
//    Sonarr and re-match immediately. If a fresh upload has no TVDB episode
//    near its date, nudge Sonarr to refresh the series (rate-limited).
//  - full refresh (6 h): every active mapping re-syncs its episode list and
//    re-runs auto-match (video pool topped up incrementally, rebuilt weekly).
// Newly matched episodes surface in the Torznab RSS feed, which Sonarr polls.
// Manual matches are always preserved by autoMatch.

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FAST_TICK_INTERVAL_MS = 30 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000; // let Sonarr/network settle after a reboot
const TVDB_REFRESH_COOLDOWN_SEC = 6 * 3600;
const POST_TVDB_REFRESH_DELAY_MS = 2 * 60 * 1000;
const NEW_VIDEO_WINDOW_DAYS = 3;
const ZERO_PROGRESS_LIMIT = 3;

let running = false;
let ticking = false;

function activeMappings({ withChannel = false } = {}) {
  return db.prepare(`
    SELECT id FROM series_mappings
    WHERE COALESCE(state, 'active') = 'active' ${withChannel ? 'AND channel_id IS NOT NULL' : ''}
    ORDER BY id
  `).all();
}

// Admins sometimes tag a series 'yt' directly in Sonarr instead of requesting
// through Diskovarr. Discover those and create channel-less mappings so they
// show up in the review UI as "no channel set" instead of silently returning
// zero releases forever.
async function discoverTaggedSeries() {
  let tagged;
  try {
    tagged = await sonarr.seriesWithTag('yt');
  } catch (e) {
    console.error(`[scheduler] yt-tag discovery failed: ${e.message}`);
    return;
  }
  const insert = db.prepare(`
    INSERT INTO series_mappings (tvdb_id, sonarr_series_id, title, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(tvdb_id) DO NOTHING
  `);
  for (const s of tagged) {
    if (!s.tvdbId) continue;
    const { changes } = insert.run(s.tvdbId, s.id, s.title, Math.floor(Date.now() / 1000));
    if (changes > 0) console.log(`[scheduler] discovered yt-tagged series "${s.title}" (tvdb:${s.tvdbId}) — needs a channel`);
  }
}

// For each channel-less mapping: sync its episodes from Sonarr first
// (detection scores channels against them), then try channel detection —
// which runs a full auto-match itself on success.
async function discoverAndDetect() {
  await discoverTaggedSeries();
  const channelDetect = require('./channelDetect');
  for (const row of channelDetect.detectableMappings()) {
    const mapping = mappingsLib.getMapping(row.id);
    if (!mapping || (mapping.state && mapping.state !== 'active')) continue;
    try {
      await mappingsLib.syncEpisodesFromSonarr(mapping);
    } catch (e) {
      console.error(`[scheduler] episode sync failed for "${mapping.title}": ${e.message}`);
      continue;
    }
    if (!getSetting('youtube_api_key')) continue;
    try {
      await channelDetect.detectChannel(row.id);
    } catch (e) {
      console.error(`[scheduler] channel detection failed for "${mapping.title}": ${e.message}`);
    }
  }
}

// A mapping with a channel that keeps producing zero matches is not going to
// start working by itself (wrong channel, removed videos, members-only). After
// three such cycles it is parked as 'unavailable' so it stops burning quota
// and Sonarr searches. Any match at all keeps it active.
function trackProgress(mapping, result) {
  if (!result || !mapping.channel_id || !result.episodes) return;
  if (result.matched > 0) {
    db.prepare('UPDATE series_mappings SET zero_progress_runs = 0 WHERE id = ?').run(mapping.id);
    return;
  }
  const runs = (Number(mapping.zero_progress_runs) || 0) + 1;
  db.prepare('UPDATE series_mappings SET zero_progress_runs = ? WHERE id = ?').run(runs, mapping.id);
  if (runs >= ZERO_PROGRESS_LIMIT) {
    mappingsLib.setMappingState(mapping.id, 'unavailable', `no matches after ${ZERO_PROGRESS_LIMIT} refreshes`);
    console.warn(`[scheduler] "${mapping.title}" marked unavailable: 0/${result.episodes} matched for ${runs} consecutive refreshes`);
  }
}

async function refreshAll() {
  if (running) return;
  running = true;
  const started = Date.now();
  let lastError = null;
  try {
    await discoverAndDetect();
    const rows = activeMappings();
    for (const row of rows) {
      const mapping = mappingsLib.getMapping(row.id);
      if (!mapping) continue;
      try {
        await mappingsLib.syncEpisodesFromSonarr(mapping);
      } catch (e) {
        lastError = `${mapping.title}: episode sync failed: ${e.message}`;
        console.error(`[scheduler] episode sync failed for "${mapping.title}": ${e.message}`);
      }
      try {
        // incremental: unseen uploads only, automatic full rebuild once a week
        const result = await matcher.autoMatch(mapping.id, { refresh: 'incremental' }); // null without a channel
        trackProgress(mapping, result);
      } catch (e) {
        lastError = `${mapping.title}: auto-match failed: ${e.message}`;
        console.error(`[scheduler] auto-match failed for "${mapping.title}": ${e.message}`);
      }
    }
    if (rows.length) console.log(`[scheduler] refreshed ${rows.length} mapping(s) in ${Date.now() - started}ms`);
  } catch (e) {
    lastError = e.message;
    console.error(`[scheduler] refresh failed: ${e.message}`);
  } finally {
    state.lastRefreshAt = Date.now();
    state.lastRefreshDurationMs = Date.now() - started;
    state.lastRefreshError = lastError;
    running = false;
  }
}

function resyncAndMatch(mappingId, why) {
  const mapping = mappingsLib.getMapping(mappingId);
  if (!mapping) return Promise.resolve();
  return mappingsLib.syncEpisodesFromSonarr(mapping)
    .then(() => matcher.autoMatch(mapping.id, { refresh: false }))
    .catch(e => console.error(`[scheduler] ${why} re-match failed for "${mapping.title}": ${e.message}`));
}

// New upload with no TVDB episode within ±3 days of its publish date → the
// TVDB entry probably doesn't exist yet or Sonarr hasn't pulled it. Ask Sonarr
// to refresh the series (at most once per 6h per mapping), then re-match.
async function maybeRefreshSeriesInSonarr(mapping) {
  if (!mapping.sonarr_series_id) return false;
  const sinceIso = new Date(Date.now() - NEW_VIDEO_WINDOW_DAYS * 86400000).toISOString();
  const fresh = db.prepare("SELECT published_at FROM videos WHERE mapping_id = ? AND status = 'ok' AND published_at >= ?")
    .all(mapping.id, sinceIso);
  if (fresh.length === 0) return false;
  const airDates = db.prepare('SELECT air_date FROM episode_matches WHERE mapping_id = ? AND air_date IS NOT NULL')
    .all(mapping.id).map(r => Date.parse(r.air_date + 'T12:00:00Z')).filter(Number.isFinite);
  const windowMs = NEW_VIDEO_WINDOW_DAYS * 86400000;
  const orphan = fresh.some(v => {
    const pub = Date.parse(v.published_at);
    return Number.isFinite(pub) && !airDates.some(air => Math.abs(air - pub) <= windowMs);
  });
  if (!orphan) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - (Number(mapping.last_tvdb_refresh_at) || 0) < TVDB_REFRESH_COOLDOWN_SEC) return false;
  try {
    await sonarr.refreshSeries(mapping.sonarr_series_id);
    db.prepare('UPDATE series_mappings SET last_tvdb_refresh_at = ? WHERE id = ?').run(now, mapping.id);
    console.log(`[scheduler] "${mapping.title}": new upload without a TVDB episode — asked Sonarr to refresh the series`);
    setTimeout(() => resyncAndMatch(mapping.id, 'post-TVDB-refresh'), POST_TVDB_REFRESH_DELAY_MS).unref();
    return true;
  } catch (e) {
    console.error(`[scheduler] RefreshSeries failed for "${mapping.title}": ${e.message}`);
    return false;
  }
}

async function fastTick() {
  if (running || ticking) return; // the full refresh already covers this
  ticking = true;
  try {
    await discoverAndDetect();
    if (getSetting('youtube_api_key')) {
      for (const row of activeMappings({ withChannel: true })) {
        if (state.quota.exceededAt) break; // no point hammering a dead quota
        const mapping = mappingsLib.getMapping(row.id);
        if (!mapping) continue;
        let result;
        try {
          result = await youtube.refreshVideos(mapping, { incremental: true });
        } catch (e) {
          console.error(`[scheduler] incremental refresh failed for "${mapping.title}": ${e.message}`);
          continue;
        }
        if (!result.added) continue;
        await resyncAndMatch(mapping.id, 'new-upload');
        await maybeRefreshSeriesInSonarr(mappingsLib.getMapping(mapping.id) || mapping);
      }
    }
  } catch (e) {
    console.error(`[scheduler] fast tick failed: ${e.message}`);
  } finally {
    state.lastFastTickAt = Date.now();
    ticking = false;
  }
}

function start() {
  setTimeout(refreshAll, BOOT_DELAY_MS).unref();
  setInterval(refreshAll, REFRESH_INTERVAL_MS).unref();
  setInterval(fastTick, FAST_TICK_INTERVAL_MS).unref();
}

function isRunning() {
  return running;
}

module.exports = { start, refreshAll, fastTick, discoverAndDetect, isRunning, trackProgress, ZERO_PROGRESS_LIMIT };
