// Where a notification leads when opened outside the app (push, email, chat
// buttons). The in-app bell has the matching table in
// src/utils/notificationRoutes.js; keep the two in step when adding an event.
const { canonicalType } = require('./types');

function parseData(data) {
  if (!data) return {};
  if (typeof data === 'object') return data;
  try { return JSON.parse(data) || {}; } catch { return {}; }
}

const enc = encodeURIComponent;
const idParam = (value) => (value !== undefined && value !== null && value !== '' ? `?id=${enc(value)}` : '');

// Returns an app-relative path, or null when the event has no destination.
function notificationPath(type, rawData) {
  const data = parseData(rawData);
  const event = canonicalType(String(type || ''));
  if (event.startsWith('request_') || event === 'autorequest') return `/queue${idParam(data.requestId)}`;
  if (event.startsWith('issue_')) return `/issues${idParam(data.issueId)}`;
  if (event.startsWith('movie_night_')) return data.groupId ? `/movie-night/${enc(data.groupId)}` : '/movie-night';
  if (event === 'watch_party_invite') return data.partyId ? `/watch-party/${enc(data.partyId)}` : '/movie-night';
  if (event === 'monitor_match') {
    if (data.tmdbId && data.mediaType) {
      return `/search?q=${enc(data.title || '')}&selectedTmdbId=${enc(data.tmdbId)}&selectedType=${enc(data.mediaType)}`;
    }
    return '/search';
  }
  if (event === 'tuberr_alert') return '/admin#youtube';
  if (event === 'deletion') return '/admin#automation';
  return null;
}

// Absolute link for external channels; null without a configured public URL.
function notificationUrl(appUrl, type, data) {
  const base = String(appUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  const path = notificationPath(type, data);
  return path ? `${base}${path}` : null;
}

module.exports = { notificationPath, notificationUrl };
