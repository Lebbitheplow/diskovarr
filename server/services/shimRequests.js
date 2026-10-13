// Request/media queries behind the Overseerr shim (routes/overseerrShim.js).
//
// The shim only exposes requests an Overseerr consumer can act on: YouTube
// (Sonarr+Tuberr) requests must never reach DUMB pull mode, and TVDB-only rows
// carry the meaningless tmdb_id sentinel 0. That filter is applied in SQL so
// LIMIT/OFFSET pages and pageInfo totals agree with what is returned.
//
// Media identity is (tmdb_id, media_type): TMDB numbers movies and shows
// independently, so a bare numeric id can name two different titles.
const db = require('../db/database');

// Rows an Overseerr consumer may see at all
const CONSUMER_SQL = "(dr.downloader IS NULL OR dr.downloader != 'youtube') AND dr.tmdb_id != 0";
// Rows the shim exposes in its listings: also not "Notify me" follower rows
// (is_follow), which subscribe to another request rather than acquire anything,
// so a pull consumer must never pick them up as jobs of their own
const VISIBLE_SQL = `${CONSUMER_SQL} AND dr.is_follow = 0`;

const REQUEST_SELECT = `
  SELECT dr.*, COALESCE(ku.username, dr.user_id) AS username, ku.thumb AS user_thumb
  FROM discover_requests dr
  LEFT JOIN known_users ku ON ku.user_id = dr.user_id`;

// 'movie' | 'tv' from a client-supplied type ('show' is Riven's spelling), else null
function normalizeMediaType(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'movie') return 'movie';
  if (v === 'tv' || v === 'show') return 'tv';
  return null;
}

const libraryKey = (tmdbId, mediaType) => `${tmdbId}:${mediaType === 'tv' ? 'tv' : 'movie'}`;

// ── Media ids ─────────────────────────────────────────────────────────────────
// Overseerr's media.id is an internal key, not the TMDB id. Riven 0.x stores it
// and may later send it to DELETE /request/:id, where a bare TMDB id would name
// an unrelated request. So the shim emits the TMDB id moved into a range of its
// own, with the type folded in: movie = 1e9 + tmdb, tv = 1.5e9 + tmdb. That
// stays below 2^31 (Riven keeps it in a Postgres INTEGER) and above any request
// id or TMDB id, so an encoded id is never mistaken for either.
const MEDIA_ID_MIN = 1_000_000_000;
const MEDIA_ID_BASE = Object.freeze({ movie: MEDIA_ID_MIN, tv: 1_500_000_000 });
const MEDIA_ID_SPAN = 500_000_000; // TMDB ids encodable per type: 0 < tmdb < span
const MEDIA_ID_MAX = 2_000_000_000; // exclusive

// Encoded media id for a (TMDB id, type), or null when it can't be encoded
function encodeMediaId(tmdbId, mediaType) {
  const n = Number(tmdbId);
  const type = normalizeMediaType(mediaType);
  if (!type || !Number.isInteger(n) || n <= 0 || n >= MEDIA_ID_SPAN) return null;
  return MEDIA_ID_BASE[type] + n;
}

// { tmdbId, mediaType } for an encoded media id, else null (bare TMDB ids,
// request ids and anything at or past 2e9 included)
function decodeMediaId(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < MEDIA_ID_MIN || n >= MEDIA_ID_MAX) return null;
  const mediaType = n >= MEDIA_ID_BASE.tv ? 'tv' : 'movie';
  const tmdbId = n - MEDIA_ID_BASE[mediaType];
  return tmdbId > 0 ? { tmdbId, mediaType } : null;
}

// media.id for a response: the encoded id, or for a TMDB id outside the
// encodable range the bare id while it stays below the encoded range (else 0)
function mediaIdFor(tmdbId, mediaType) {
  const encoded = encodeMediaId(tmdbId, mediaType);
  if (encoded !== null) return encoded;
  const n = Number(tmdbId);
  return Number.isInteger(n) && n > 0 && n < MEDIA_ID_MIN ? n : 0;
}

// Fold a positive integer into [1, 1e9) so an id that isn't a TMDB title (a
// rating key, a hash) can never decode as an encoded media id
function foldMediaId(n) {
  if (!Number.isFinite(n) || n < 1) return 1;
  const i = Math.floor(n);
  return i < MEDIA_ID_MIN ? i : (i % (MEDIA_ID_MIN - 1)) + 1;
}

// Whether one request is fulfilled. A season-gated request (specific seasons
// of a show the library may already hold) only counts once the season-aware
// fulfillment check has stamped it — the title being present isn't enough.
function requestAvailable(row, libraryIds) {
  if (!libraryIds.has(libraryKey(row.tmdb_id, row.media_type))) return false;
  return !row.season_gated || !!row.notified_available_at;
}

// Paginated visible requests, newest first (id breaks same-second ties so pages
// never overlap). `total` counts every match, not just this page.
function listRequests({ limit, offset, status = null, userId = null }) {
  const clauses = [VISIBLE_SQL];
  const params = [];
  if (status) { clauses.push('dr.status = ?'); params.push(status); }
  if (userId) { clauses.push('dr.user_id = ?'); params.push(String(userId)); }
  const where = clauses.join(' AND ');
  const rows = db.prepare(`${REQUEST_SELECT} WHERE ${where} ORDER BY dr.requested_at DESC, dr.id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(limit), Number(offset));
  const total = db.prepare(`SELECT COUNT(*) AS c FROM discover_requests dr WHERE ${where}`).get(...params)?.c || 0;
  return { rows, total };
}

// Overseerr MediaStatus for a requested title: 5 AVAILABLE, 4 PARTIALLY_AVAILABLE
// (in the library, but approved requests for missing seasons are still open),
// 3 PROCESSING, 2 PENDING, 1 UNKNOWN (only declined requests).
function mediaStatus({ inLibrary, approved, pending, openSeasons = 0 }) {
  if (inLibrary) return openSeasons > 0 ? 4 : 5;
  if (approved > 0) return 3;
  if (pending > 0) return 2;
  return 1;
}

// One entry per requested title (not per request row), newest activity first.
function listRequestedMedia(libraryIds) {
  const rows = db.prepare(`
    SELECT dr.tmdb_id, dr.media_type,
           MIN(dr.requested_at) AS first_requested_at,
           MAX(dr.requested_at) AS last_requested_at,
           SUM(dr.status = 'approved') AS approved,
           SUM(dr.status = 'pending') AS pending,
           SUM(dr.status = 'approved' AND dr.season_gated = 1 AND dr.notified_available_at IS NULL) AS open_seasons
    FROM discover_requests dr
    WHERE ${VISIBLE_SQL}
    GROUP BY dr.tmdb_id, dr.media_type
    ORDER BY last_requested_at DESC, MAX(dr.id) DESC
  `).all();
  return rows.map(r => ({
    ...r,
    status: mediaStatus({
      inLibrary: libraryIds.has(libraryKey(r.tmdb_id, r.media_type)),
      approved: r.approved, pending: r.pending, openSeasons: r.open_seasons,
    }),
  }));
}

// Media types that have requests for a TMDB id, most recently requested first.
// `visibleOnly` limits to rows the listings expose; `status` to one request status.
function mediaTypesFor(tmdbId, { status = null, visibleOnly = true } = {}) {
  const clauses = ['dr.tmdb_id = ?'];
  const params = [Number(tmdbId)];
  if (visibleOnly) clauses.push(VISIBLE_SQL);
  if (status) { clauses.push('dr.status = ?'); params.push(status); }
  return db.prepare(`
    SELECT dr.media_type, MAX(dr.id) AS latest FROM discover_requests dr
    WHERE ${clauses.join(' AND ')} GROUP BY dr.media_type ORDER BY latest DESC
  `).all(...params).map(r => r.media_type);
}

// Pick one media type for a bare TMDB id. A valid hint wins (or matches nothing);
// without one, more than one candidate type is ambiguous.
function resolveMediaType(types, hint) {
  const wanted = normalizeMediaType(hint);
  if (wanted) return { mediaType: types.includes(wanted) ? wanted : null, ambiguous: false };
  return { mediaType: types[0] || null, ambiguous: types.length > 1 };
}

// Requests for one media identity, newest first.
function mediaRequests(tmdbId, mediaType, { status = null, visibleOnly = true } = {}) {
  const clauses = ['dr.tmdb_id = ?', 'dr.media_type = ?'];
  const params = [Number(tmdbId), mediaType];
  if (visibleOnly) clauses.push(VISIBLE_SQL);
  if (status) { clauses.push('dr.status = ?'); params.push(status); }
  return db.prepare(`${REQUEST_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY dr.requested_at DESC, dr.id DESC`)
    .all(...params);
}

// Followers go too: the requests they subscribed to are being removed (those
// matched by TVDB id only are pruned once no live request is left for the
// title). Returns the number of rows removed.
function deleteMediaRequests(tmdbId, mediaType) {
  const anchor = db.prepare(`SELECT * FROM discover_requests AS dr WHERE dr.tmdb_id = ? AND dr.media_type = ? AND dr.is_follow = 0 AND ${CONSUMER_SQL} LIMIT 1`)
    .get(Number(tmdbId), mediaType);
  const removed = db.prepare(`DELETE FROM discover_requests AS dr WHERE dr.tmdb_id = ? AND dr.media_type = ? AND ${CONSUMER_SQL}`)
    .run(Number(tmdbId), mediaType).changes;
  return removed + (anchor ? db.pruneOrphanFollowers(anchor) : 0);
}

// Overseerr /request/count over visible requests. `available` counts non-declined
// requests whose title is in the library; `processing` approved ones still missing.
function requestCounts(libraryIds) {
  const rows = db.prepare(`
    SELECT dr.tmdb_id, dr.media_type, dr.status, dr.season_gated, dr.notified_available_at IS NOT NULL AS notified_available_at, COUNT(*) AS cnt
    FROM discover_requests dr WHERE ${VISIBLE_SQL}
    GROUP BY dr.tmdb_id, dr.media_type, dr.status, dr.season_gated, dr.notified_available_at IS NOT NULL
  `).all();
  const out = { pending: 0, approved: 0, declined: 0, available: 0, processing: 0, failed: 0, total: 0, movie: 0, tv: 0 };
  for (const r of rows) {
    const inLib = requestAvailable(r, libraryIds);
    if (r.status === 'pending') out.pending += r.cnt;
    else if (r.status === 'approved') out.approved += r.cnt;
    else if (r.status === 'denied') out.declined += r.cnt;
    if (r.status !== 'denied') {
      if (r.media_type === 'movie') out.movie += r.cnt;
      else if (r.media_type === 'tv') out.tv += r.cnt;
      if (inLib) out.available += r.cnt;
    }
    if (r.status === 'approved' && !inLib) out.processing += r.cnt;
  }
  out.total = out.pending + out.approved + out.declined;
  return out;
}

module.exports = {
  CONSUMER_SQL,
  VISIBLE_SQL,
  normalizeMediaType,
  libraryKey,
  MEDIA_ID_MIN,
  MEDIA_ID_MAX,
  encodeMediaId,
  decodeMediaId,
  mediaIdFor,
  foldMediaId,
  requestAvailable,
  listRequests,
  mediaStatus,
  listRequestedMedia,
  mediaTypesFor,
  resolveMediaType,
  mediaRequests,
  deleteMediaRequests,
  requestCounts,
};
