// AniList user anime lists via the public GraphQL API (no key needed). AniList
// has no TMDB mapping, so entries resolve by title+year search — best effort,
// unresolved entries are counted and surfaced in the sync status.
function parseUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)anilist\.co$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/user\/([^/]+)\/animelist(?:\/([^/]+))?\/?/);
  if (m) return { user: m[1], statusFilter: m[2] || null };
  return null;
}

const QUERY = `
query ($userName: String) {
  MediaListCollection(userName: $userName, type: ANIME) {
    lists {
      name
      status
      entries {
        media {
          title { romaji english }
          startDate { year }
          format
        }
      }
    }
  }
}`;

const STATUS_MAP = {
  watching: 'CURRENT', completed: 'COMPLETED', paused: 'PAUSED',
  dropped: 'DROPPED', planning: 'PLANNING', rewatching: 'REPEATING',
};

async function fetchEntries(parsed, { limit = 500 } = {}) {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { userName: parsed.user } }),
    signal: AbortSignal.timeout(20000),
  });
  // AniList returns GraphQL errors with non-200 statuses (404 for unknown user),
  // so parse the body first for a real message.
  const json = await res.json().catch(() => null);
  if (json?.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  if (!res.ok) throw new Error(`AniList API error ${res.status}`);
  const lists = json?.data?.MediaListCollection?.lists || [];
  const wantStatus = parsed.statusFilter ? STATUS_MAP[parsed.statusFilter.toLowerCase()] : null;
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (wantStatus && list.status !== wantStatus) continue;
    for (const entry of list.entries || []) {
      const media = entry.media;
      const title = media?.title?.english || media?.title?.romaji;
      if (!title || seen.has(title)) continue;
      seen.add(title);
      out.push({
        title,
        year: media.startDate?.year || null,
        mediaType: media.format === 'MOVIE' ? 'movie' : 'tv',
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { parseUrl, fetchEntries };
