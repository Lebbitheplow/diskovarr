// MDBList lists via the official JSON API (free api key from mdblist.com/preferences).
const db = require('../../db/database');

function getApiKey() {
  return db.getSetting('mdblist_api_key', null) || process.env.MDBLIST_API_KEY || null;
}

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)mdblist\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  // https://mdblist.com/lists/{user}/{slug}
  if (parts[0] === 'lists' && parts[1] && parts[2]) {
    return { user: parts[1], slug: parts[2] };
  }
  return null;
}

function normalizeItem(row, fallbackType) {
  const mediaType = (row.mediatype || row.media_type || fallbackType) === 'show' ? 'tv'
    : (row.mediatype || row.media_type || fallbackType) === 'tv' ? 'tv' : 'movie';
  return {
    // MDBList's `id` is the TMDB id on API items; imdb_id is the safety net.
    tmdbId: row.tmdb_id || row.tmdbid || null,
    imdbId: row.imdb_id || row.imdbid || null,
    title: row.title || null,
    year: row.release_year || row.year || null,
    mediaType,
  };
}

async function fetchEntries(parsed, { limit = 500 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('MDBList API key not configured (Automation → list source credentials)');
  const url = `https://api.mdblist.com/lists/${encodeURIComponent(parsed.user)}/${encodeURIComponent(parsed.slug)}/items?apikey=${encodeURIComponent(apiKey)}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`MDBList API error ${res.status}`);
  const json = await res.json();
  // Two response shapes exist: a flat array, or { movies: [...], shows: [...] }.
  let entries = [];
  if (Array.isArray(json)) {
    entries = json.map(r => normalizeItem(r, null));
  } else if (json && (json.movies || json.shows)) {
    entries = [
      ...(json.movies || []).map(r => normalizeItem(r, 'movie')),
      ...(json.shows || []).map(r => normalizeItem(r, 'tv')),
    ];
  } else if (json && json.error) {
    throw new Error(`MDBList: ${json.error}`);
  }
  return entries.filter(e => e.tmdbId || e.imdbId || e.title).slice(0, limit);
}

module.exports = { parseUrl, fetchEntries };
