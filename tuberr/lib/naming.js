// Release-title construction. Titles must parse cleanly in Sonarr:
// Series.Name.S01E05.Episode.Title.1080p.WEB-DL-TUBERR → WEBDL-1080p quality,
// release group TUBERR.

const RELEASE_SUFFIX = '1080p.WEB-DL-TUBERR';

// ~5 Mbps merged AV — lands inside Sonarr's default WEBDL-1080p size window
const ESTIMATE_BITRATE_BPS = 5_000_000;
const FALLBACK_DURATION_SEC = 45 * 60;

function sanitizeToken(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildReleaseTitle(seriesTitle, season, episode, episodeTitle) {
  const parts = [sanitizeToken(seriesTitle), `S${pad2(season)}E${pad2(episode)}`];
  const epToken = sanitizeToken(episodeTitle);
  if (epToken) parts.push(epToken);
  parts.push(RELEASE_SUFFIX);
  return parts.filter(Boolean).join('.');
}

function estimateSizeBytes(durationSec) {
  const seconds = Number(durationSec) > 0 ? Number(durationSec) : FALLBACK_DURATION_SEC;
  return Math.round(seconds * ESTIMATE_BITRATE_BPS / 8);
}

module.exports = { sanitizeToken, buildReleaseTitle, estimateSizeBytes, RELEASE_SUFFIX };
