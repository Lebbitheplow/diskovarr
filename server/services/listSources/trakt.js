// Trakt lists and charts. Public data only needs a client id (free, created at
// trakt.tv/oauth/applications) sent as the trakt-api-key header — no OAuth.
const db = require('../../db/database');

const API = 'https://api.trakt.tv';
const CHARTS = ['trending', 'popular', 'anticipated', 'watched', 'collected', 'favorited'];

function getClientId() {
  return db.getSetting('trakt_client_id', null) || process.env.TRAKT_CLIENT_ID || null;
}

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)trakt\.tv$/.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  // https://trakt.tv/users/{user}/lists/{slug}
  if (parts[0] === 'users' && parts[2] === 'lists' && parts[3]) {
    return { kind: 'user_list', user: parts[1], slug: parts[3] };
  }
  // https://trakt.tv/lists/{id-or-slug} (official/trending lists)
  if (parts[0] === 'lists' && parts[1]) {
    return { kind: 'official_list', id: parts[1] };
  }
  // https://trakt.tv/movies/trending, https://trakt.tv/shows/popular
  if ((parts[0] === 'movies' || parts[0] === 'shows') && CHARTS.includes(parts[1])) {
    return { kind: 'chart', mediaType: parts[0] === 'movies' ? 'movie' : 'tv', chart: parts[1] };
  }
  return null;
}

async function traktFetch(path) {
  const clientId = getClientId();
  if (!clientId) throw new Error('Trakt client ID not configured (Automation → list source credentials)');
  const res = await fetch(`${API}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Trakt API error ${res.status} for ${path}`);
  return res.json();
}

function normalizeItem(row) {
  // List/chart rows wrap the media object ({ movie: {...} } / { show: {...} });
  // /movies/popular returns bare movie objects.
  const movie = row.movie || (row.title && row.ids && !row.aired_episodes ? row : null);
  const show = row.show || null;
  const media = movie || show;
  if (!media || !media.ids) return null;
  return {
    tmdbId: media.ids.tmdb || null,
    imdbId: media.ids.imdb || null,
    title: media.title,
    year: media.year || null,
    mediaType: show || row.show ? 'tv' : 'movie',
  };
}

async function fetchEntries(parsed, { limit = 500 } = {}) {
  let path;
  if (parsed.kind === 'user_list') {
    path = `/users/${encodeURIComponent(parsed.user)}/lists/${encodeURIComponent(parsed.slug)}/items?limit=${limit}`;
  } else if (parsed.kind === 'official_list') {
    path = `/lists/${encodeURIComponent(parsed.id)}/items?limit=${limit}`;
  } else {
    path = `/${parsed.mediaType === 'tv' ? 'shows' : 'movies'}/${parsed.chart}?limit=${Math.min(limit, 100)}`;
  }
  const rows = await traktFetch(path);
  if (!Array.isArray(rows)) return [];
  const chartType = parsed.kind === 'chart' ? parsed.mediaType : null;
  return rows.map(row => {
    const item = normalizeItem(row);
    if (item && chartType) item.mediaType = chartType;
    return item;
  }).filter(Boolean).slice(0, limit);
}

module.exports = { parseUrl, fetchEntries };
