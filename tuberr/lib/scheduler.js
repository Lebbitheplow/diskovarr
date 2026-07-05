const { db } = require('../db');
const mappingsLib = require('./mappings');
const matcher = require('./matcher');

// Keeps mappings fresh without anyone clicking anything: every cycle each
// mapping re-syncs its episode list from Sonarr (new TVDB episodes appear
// after Sonarr's own series refresh) and re-runs auto-match against a fresh
// video pool. Newly matched episodes then surface in the Torznab RSS feed,
// which Sonarr's RSS sync polls — so monitored series auto-grab new episodes
// end to end. Manual matches are always preserved by autoMatch.

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 90 * 1000; // let Sonarr/network settle after a reboot

let running = false;

async function refreshAll() {
  if (running) return;
  running = true;
  try {
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
