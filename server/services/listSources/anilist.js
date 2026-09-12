// AniList: user anime lists (pasted URL) and the site-wide popularity chart
// (preset), both via the public GraphQL API (no key needed).
//
// AniList has no TMDB ids of its own, so entries are mapped through the
// community anime-lists index (Fribb/anime-lists: anilist_id → themoviedb_id /
// tvdb_id), cached in memory for a day; anything it can't map falls back to a
// title+year TMDB search in resolveEntries(). Unresolved entries are counted
// and surfaced in the sync status.
const API = 'https://graphql.anilist.co';
const ID_MAP_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json';
const ID_MAP_TTL_MS = 24 * 60 * 60 * 1000;

function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)anilist\.co$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/user\/([^/]+)\/animelist(?:\/([^/]+))?\/?/);
  if (m) return { user: m[1], statusFilter: m[2] || null };
  return null;
}

const MEDIA_FIELDS = `id idMal title { romaji english } startDate { year } format`;

const USER_LIST_QUERY = `
query ($userName: String) {
  MediaListCollection(userName: $userName, type: ANIME) {
    lists {
      name
      status
      entries { media { ${MEDIA_FIELDS} } }
    }
  }
}`;

// Same format split Agregarr uses: movie libraries get MOVIE, TV libraries get
// everything episodic.
const POPULAR_QUERY = `
query ($page: Int, $perPage: Int, $formats: [MediaFormat]) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(type: ANIME, sort: POPULARITY_DESC, format_in: $formats, isAdult: false) { ${MEDIA_FIELDS} }
  }
}`;

const STATUS_MAP = {
  watching: 'CURRENT', completed: 'COMPLETED', paused: 'PAUSED',
  dropped: 'DROPPED', planning: 'PLANNING', rewatching: 'REPEATING',
};

// AniList's public rate limit is ~30 requests/minute (degraded from 90);
// paging a big chart is paced accordingly, and a 429 waits out Retry-After.
const PAGE_STAGGER_MS = 2100;
const MAX_429_RETRIES = 3;

async function graphql(query, variables, attempt = 0) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 429 && attempt < MAX_429_RETRIES) {
    const wait = Math.min(120, Math.max(5, parseInt(res.headers.get('retry-after')) || 60));
    await new Promise(r => setTimeout(r, wait * 1000));
    return graphql(query, variables, attempt + 1);
  }
  // AniList returns GraphQL errors with non-200 statuses (404 for unknown user),
  // so parse the body first for a real message.
  const json = await res.json().catch(() => null);
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  if (!res.ok) throw new Error(`AniList API error ${res.status}`);
  return json?.data;
}

// ── AniList id → TMDB/TVDB mapping ───────────────────────────────────────────

let idMap = null; // Map<anilistId, { tmdbTv, tmdbMovie, tvdb }>
let idMapFetchedAt = 0;
let idMapPromise = null;

async function loadIdMap() {
  if (idMap && Date.now() - idMapFetchedAt < ID_MAP_TTL_MS) return idMap;
  if (idMapPromise) return idMapPromise;
  idMapPromise = (async () => {
    const res = await fetch(ID_MAP_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`anime-lists mapping returned ${res.status}`);
    const rows = await res.json();
    const map = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r.anilist_id) continue;
      const tmdb = r.themoviedb_id && typeof r.themoviedb_id === 'object' ? r.themoviedb_id : {};
      map.set(Number(r.anilist_id), {
        tmdbTv: tmdb.tv ? Number(tmdb.tv) : null,
        tmdbMovie: tmdb.movie ? Number(tmdb.movie) : null,
        tvdb: r.tvdb_id ? Number(r.tvdb_id) : null,
      });
    }
    idMap = map;
    idMapFetchedAt = Date.now();
    return map;
  })().finally(() => { idMapPromise = null; });
  return idMapPromise;
}

function mediaEntry(media) {
  const title = media?.title?.english || media?.title?.romaji;
  if (!title) return null;
  return {
    anilistId: media.id,
    title,
    year: media.startDate?.year || null,
    mediaType: media.format === 'MOVIE' ? 'movie' : 'tv',
  };
}

// Attach tmdbId (and tvdbId) where the mapping knows the title; keep the
// AniList media type — a mapped id of the other type is ignored.
async function attachIds(entries) {
  let map = null;
  try { map = await loadIdMap(); } catch { map = idMap; }
  if (!map) return entries;
  return entries.map(e => {
    const hit = map.get(Number(e.anilistId));
    if (!hit) return e;
    const tmdbId = e.mediaType === 'movie' ? hit.tmdbMovie : hit.tmdbTv;
    return { ...e, ...(tmdbId ? { tmdbId } : {}), ...(hit.tvdb ? { tvdbId: hit.tvdb } : {}) };
  });
}

// ── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchEntries(parsed, { limit = 500 } = {}) {
  const data = await graphql(USER_LIST_QUERY, { userName: parsed.user });
  const lists = data?.MediaListCollection?.lists || [];
  const wantStatus = parsed.statusFilter ? STATUS_MAP[parsed.statusFilter.toLowerCase()] : null;
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (wantStatus && list.status !== wantStatus) continue;
    for (const entry of list.entries || []) {
      const item = mediaEntry(entry.media);
      if (!item || seen.has(item.title)) continue;
      seen.add(item.title);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return attachIds(out);
}

// Popularity chart (presets): pages of 50 until `limit` entries are collected.
async function fetchPopular({ mediaType = 'tv' }, { limit = 100 } = {}) {
  const formats = mediaType === 'movie' ? ['MOVIE'] : ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL'];
  const out = [];
  const seen = new Set();
  const perPage = 50;
  const maxPages = Math.min(200, Math.ceil(limit / perPage));
  for (let page = 1; page <= maxPages && out.length < limit; page++) {
    const data = await graphql(POPULAR_QUERY, { page, perPage, formats });
    const media = data?.Page?.media || [];
    for (const m of media) {
      const item = mediaEntry(m);
      if (!item || seen.has(item.anilistId)) continue;
      seen.add(item.anilistId);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (!data?.Page?.pageInfo?.hasNextPage || media.length === 0) break;
    if (page < maxPages) await new Promise(r => setTimeout(r, PAGE_STAGGER_MS));
  }
  return attachIds(out);
}

module.exports = { parseUrl, fetchEntries, fetchPopular, loadIdMap };
