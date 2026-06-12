// TMDB user lists (themoviedb.org/list/{id}) plus chart/discover paths used by
// presets. Uses the app's existing TMDB key via tmdbFetchPublic.
const tmdbService = require('../tmdb');

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)themoviedb\.org$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/list\/(\d+)/);
  if (m) return { listId: m[1] };
  return null;
}

function normalizeItem(row) {
  const mediaType = row.media_type === 'tv' || row.first_air_date ? 'tv' : 'movie';
  return {
    tmdbId: row.id,
    title: row.title || row.name || null,
    year: parseInt((row.release_date || row.first_air_date || '').slice(0, 4)) || null,
    mediaType,
  };
}

async function fetchEntries(parsed, { limit = 500 } = {}) {
  const out = [];
  // v3 list endpoint paginates via ?page= and reports total_pages.
  for (let page = 1; page <= 25 && out.length < limit; page++) {
    const json = await tmdbService.tmdbFetchPublic(`/list/${parsed.listId}?page=${page}`);
    if (!json) {
      if (page === 1) throw new Error('TMDB list not found (private lists are not accessible)');
      break;
    }
    const items = json.items || [];
    out.push(...items.map(normalizeItem));
    if (page >= (json.total_pages || 1) || items.length === 0) break;
  }
  return out.slice(0, limit);
}

// Used by presets: a chart/discover path like '/movie/popular' or
// '/discover/tv?with_networks=213&sort_by=popularity.desc'.
async function fetchChart(path, mediaType, { limit = 20 } = {}) {
  const out = [];
  for (let page = 1; page <= 5 && out.length < limit; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const json = await tmdbService.tmdbFetchPublic(`${path}${sep}page=${page}`);
    const results = json?.results || [];
    out.push(...results.map(r => ({ ...normalizeItem(r), mediaType })));
    if (page >= (json?.total_pages || 1) || results.length === 0) break;
  }
  return out.slice(0, limit);
}

module.exports = { parseUrl, fetchEntries, fetchChart };
