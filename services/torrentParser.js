'use strict';

function parseTorrentName(name) {
  if (!name) return { type: 'movie' };
  const n = name.replace(/\./g, ' ').replace(/_/g, ' ');
  if (/season[s]?\s*\d+\s*[-–]\s*\d+/i.test(n) || /s\d\d?\s*[-–]\s*s\d\d?/i.test(n)) {
    const m = n.match(/s(\d\d?)\s*[-–]\s*s(\d\d?)/i) || n.match(/season[s]?\s*(\d+)\s*[-–]\s*(\d+)/i);
    return { type: 'season_range', from: parseInt(m[1]), to: parseInt(m[2]) };
  }
  if (/\b(complete|all[\s.-]*seasons?|all[\s.-]*episodes?)\b/i.test(n)) return { type: 'complete' };
  const epMatch = n.match(/\bs(\d\d?)e(\d\d?)\b/i) || n.match(/\b(\d\d?)x(\d\d?)\b/i);
  if (epMatch) return { type: 'episode', season: parseInt(epMatch[1]), episode: parseInt(epMatch[2]) };
  const seasonMatch = n.match(/\bs(\d\d?)\b(?![a-z])/i) || n.match(/\bseason\s*(\d+)\b/i);
  if (seasonMatch) return { type: 'season', season: parseInt(seasonMatch[1]) };
  return { type: 'movie' };
}

function parseFilename(filename) {
  if (!filename) return null;
  const m = filename.match(/[Ss](\d\d?)[Ee](\d\d?)/);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  return null;
}

function parseQuality(nameField) {
  if (!nameField) return 'Unknown';
  if (/\b(4K|2160p|UHD)\b/i.test(nameField)) return '4K';
  if (/\b1080p\b/i.test(nameField)) return '1080p';
  if (/\b720p\b/i.test(nameField)) return '720p';
  if (/\b480p\b/i.test(nameField)) return '480p';
  return 'Unknown';
}

function parseCodec(nameField) {
  if (!nameField) return null;
  if (/\b(HEVC|H\.?265|x265)\b/i.test(nameField)) return 'HEVC';
  if (/\b(H\.?264|x264|AVC)\b/i.test(nameField)) return 'H264';
  if (/\bAV1\b/i.test(nameField)) return 'AV1';
  return null;
}

function parseSizeMb(titleField) {
  if (!titleField) return null;
  const m = titleField.match(/💾\s*([\d.]+)\s*(GB|MB|TB)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'TB') return Math.round(val * 1024 * 1024);
  if (unit === 'GB') return Math.round(val * 1024);
  return Math.round(val);
}

function isSeasonPack(releaseName) {
  if (!releaseName) return false;
  const n = releaseName.replace(/\./g, ' ');
  const hasSeason = /\bs\d\d?\b/i.test(n) || /\bseason\s*\d/i.test(n) || /\bcomplete\b/i.test(n);
  const hasEpisode = /\bs\d\d?e\d\d?\b/i.test(n) || /\b\d+x\d\d\b/i.test(n);
  return hasSeason && !hasEpisode;
}

function extractInfohash(magnet) {
  if (!magnet) return null;
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

module.exports = { parseTorrentName, parseFilename, parseQuality, parseCodec, parseSizeMb, isSeasonPack, extractInfohash };
