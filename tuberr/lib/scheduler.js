const { db } = require('../db');
const mappingsLib = require('./mappings');
const matcher = require('./matcher');
const sonarr = require('./sonarr');

// Keeps mappings fresh without anyone clicking anything: every cycle each
// mapping re-syncs its episode list from Sonarr (new TVDB episodes appear
// after Sonarr's own series refresh) and re-runs auto-match against a fresh
// video pool. Newly matched episodes then surface in the Torznab RSS feed,
// which Sonarr's RSS sync polls — so monitored series auto-grab new episodes
// end to end. Manual matches are always preserved by autoMatch.

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000; // let Sonarr/network settle after a reboot

let running = false;

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

// Channel-less mappings (from Sonarr-side tagging) get a few automatic
// detection attempts; undetectable ones stay flagged for manual review.
async function detectMissingChannels() {
  const { getSetting } = require('../db');
  if (!getSetting('youtube_api_key')) return;
  const channelDetect = require('./channelDetect');
  for (const row of channelDetect.detectableMappings()) {
    try {
      await channelDetect.detectChannel(row.id);
    } catch (e) {
      console.error(`[scheduler] channel detection failed for mapping ${row.id}: ${e.message}`);
    }
  }
}

async function refreshAll() {
  if (running) return;
  running = true;
  try {
    await discoverTaggedSeries();
    await detectMissingChannels();
    const rows = db.prepare('SELECT id FROM series_mappings').all();
    for (const row of rows) {
      const mapping = mappingsLib.getMapping(row.id);
      if (!mapping) continue;
      try {
        await mappingsLib.syncEpisodesFromSonarr(mapping);
      } catch (e) {
        console.error(`[scheduler] episode sync failed for "${mapping.title}": ${e.message}`);
      }
      try {
        await matcher.autoMatch(mapping.id); // no-op for mappings without a channel
      } catch (e) {
        console.error(`[scheduler] auto-match failed for "${mapping.title}": ${e.message}`);
      }
    }
    if (rows.length) console.log(`[scheduler] refreshed ${rows.length} mapping(s)`);
  } finally {
    running = false;
  }
}

function start() {
  setTimeout(refreshAll, BOOT_DELAY_MS).unref();
  setInterval(refreshAll, REFRESH_INTERVAL_MS).unref();
}

module.exports = { start, refreshAll };
