// IMDb charts and public lists. IMDb itself sits behind an AWS WAF JS challenge,
// so this uses the public Servarr mirror (api.radarr.video) that Radarr's own
// IMDb import lists use. It returns TMDB ids directly. Movie-oriented: TV-only
// charts (toptv/tvmeter) are not available; TV entries in user lists may be
// missing from the mirror's output.
const MIRROR = 'https://api.radarr.video/v1/list/imdb';

const CHART_MAP = { top: 'top250', moviemeter: 'popular' };

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)imdb\.com$/.test(u.hostname)) return null;
  let m = u.pathname.match(/^\/chart\/([a-z]+)\/?/);
  if (m) return { kind: 'chart', chart: m[1] };
  m = u.pathname.match(/^\/list\/(ls\d+)\/?/);
  if (m) return { kind: 'list', listId: m[1] };
  return null;
}

async function fetchEntries(parsed, { limit = 500 } = {}) {
  let key;
  if (parsed.kind === 'chart') {
    key = CHART_MAP[parsed.chart];
    if (!key) throw new Error(`IMDb chart '${parsed.chart}' is not supported (movie charts only: top, moviemeter)`);
  } else {
    key = parsed.listId;
  }
  const res = await fetch(`${MIRROR}/${encodeURIComponent(key)}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`IMDb list mirror error ${res.status} for ${key}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('IMDb list returned no items (private list, or TV-only content the mirror does not carry)');
  }
  return rows.slice(0, limit).map(r => ({
    tmdbId: r.TmdbId || null,
    imdbId: r.ImdbId || null,
    title: r.Title || null,
    mediaType: 'movie',
  }));
}

module.exports = { parseUrl, fetchEntries };
