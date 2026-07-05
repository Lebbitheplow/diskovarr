const { db } = require('../db');
const sonarr = require('./sonarr');

// Pulls the episode list from Sonarr into episode_matches, preserving any
// existing match assignments (manual or auto) across refreshes.
async function syncEpisodesFromSonarr(mapping) {
  let seriesId = mapping.sonarr_series_id;
  if (!seriesId) {
    const series = await sonarr.getSeriesByTvdbId(mapping.tvdb_id);
    if (!series) throw new Error(`series tvdb:${mapping.tvdb_id} not found in Sonarr`);
    seriesId = series.id;
    db.prepare('UPDATE series_mappings SET sonarr_series_id = ? WHERE id = ?').run(seriesId, mapping.id);
  }
  const episodes = await sonarr.getEpisodes(seriesId);
  const upsert = db.prepare(`
    INSERT INTO episode_matches (mapping_id, season, episode, sonarr_episode_id, episode_title, air_date)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(mapping_id, season, episode) DO UPDATE SET
      sonarr_episode_id = excluded.sonarr_episode_id,
      episode_title = excluded.episode_title,
      air_date = excluded.air_date
  `);
  let count = 0;
  for (const e of episodes) {
    if (!e.seasonNumber || e.seasonNumber < 1) continue; // skip specials
    upsert.run(mapping.id, e.seasonNumber, e.episodeNumber, e.id, e.title || '',
      (e.airDateUtc || e.airDate || '').slice(0, 10) || null);
    count++;
  }
  return count;
}

function getMapping(id) {
  return db.prepare('SELECT * FROM series_mappings WHERE id = ?').get(Number(id));
}

function refreshMatchStatus(mappingId) {
  const { total, matched } = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN video_id IS NOT NULL AND broken = 0 THEN 1 ELSE 0 END) AS matched
    FROM episode_matches WHERE mapping_id = ?
  `).get(Number(mappingId));
  const status = total === 0 ? 'pending' : (matched >= total ? 'matched' : (matched > 0 ? 'partial' : 'pending'));
  db.prepare('UPDATE series_mappings SET match_status = ? WHERE id = ?').run(status, Number(mappingId));
  return { total, matched: matched || 0, status };
}

module.exports = { syncEpisodesFromSonarr, getMapping, refreshMatchStatus };
