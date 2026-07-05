const { db } = require('../db');
const naming = require('./naming');
const torrentLib = require('./torrent');

// Turns a matched episode row into a grab-able release: builds the release
// title + torrent, records it in `grabs` so the download link and the fake
// qBittorrent can recover the videoId later.

function buildRelease(mapping, match) {
  const releaseTitle = naming.buildReleaseTitle(
    mapping.title, match.season, match.episode, match.episode_title);
  const video = db.prepare('SELECT duration_sec, published_at FROM videos WHERE video_id = ? AND mapping_id = ?')
    .get(match.video_id, mapping.id);
  const sizeBytes = naming.estimateSizeBytes(video ? video.duration_sec : 0);
  const { infoHash } = torrentLib.buildTorrent({ releaseTitle, sizeBytes, videoId: match.video_id });
  db.prepare(`
    INSERT INTO grabs (info_hash, video_id, mapping_id, season, episode, release_title, size_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(info_hash) DO UPDATE SET release_title = excluded.release_title, size_bytes = excluded.size_bytes
  `).run(infoHash, match.video_id, mapping.id, match.season, match.episode, releaseTitle, sizeBytes,
    Math.floor(Date.now() / 1000));
  return {
    infoHash,
    releaseTitle,
    sizeBytes,
    season: match.season,
    episode: match.episode,
    tvdbId: mapping.tvdb_id,
    pubDate: (video && video.published_at) ? new Date(video.published_at) : new Date(),
  };
}

function torrentFor(infoHash) {
  const grab = db.prepare('SELECT * FROM grabs WHERE info_hash = ?').get(String(infoHash).toLowerCase());
  if (!grab) return null;
  return torrentLib.buildTorrent({
    releaseTitle: grab.release_title,
    sizeBytes: grab.size_bytes,
    videoId: grab.video_id,
  }).buffer;
}

module.exports = { buildRelease, torrentFor };
