/**
 * Diskovarr Wrapped — per-user yearly recap stats.
 *
 * Everything is computed from the locally synced `watch_history` table (see
 * tautulli.syncWatchHistory), never from Tautulli live, and cached in the
 * `wrapped_stats` / `wrapped_global` tables. One compute pass handles ALL users
 * for a year at once because the leaderboard, percentiles and "show buddy" need
 * cross-user aggregates anyway (the whole table is a few thousand rows).
 *
 * Accuracy: a play only counts if Tautulli marked it watched OR the session ran
 * ≥5 minutes AND reached ≥20% — this is the fix for wrapperr-style recaps that
 * count 30-second accidental plays. Completion rate deliberately uses ALL plays
 * in the window as its denominator so abandoned plays count against it.
 *
 * The math (streaks, binge, decade, percentiles, buddy) lives in pure functions
 * over plain row arrays so it can be unit-tested without a database.
 */
const crypto = require('crypto');
const db = require('../db/database');
const { computePersonality } = require('./wrappedPersonality');

const TOP_N = 5;
const CURRENT_YEAR_TTL = 24 * 60 * 60; // re-compute the in-progress year daily
// v2: + personality, + reviews detail. Payloads with an older v are recomputed
// once at read time so archived years pick the new slides up automatically.
const PAYLOAD_VERSION = 2;

// ── Pure predicates / gating ─────────────────────────────────────────────────

/** A play qualifies for Wrapped stats (mirrors the WHERE-side of nothing: applied in JS). */
function playQualifies(p) {
  if (p.watched_status === 'complete') return true;
  return (p.duration || 0) >= 300 && (p.percent_complete || 0) >= 20;
}

/** Wrapped for a year unlocks December 1 (local time) of that year. */
function isYearUnlocked(year, now = new Date()) {
  return now >= new Date(year, 11, 1);
}

function yearWindow(year) {
  return [
    Math.floor(new Date(year, 0, 1).getTime() / 1000),
    Math.floor(new Date(year + 1, 0, 1).getTime() / 1000),
  ];
}

// ── Pure aggregation helpers (unit-tested) ───────────────────────────────────

/** Local-date key (YYYY-MM-DD) for a unix-seconds timestamp. */
function localDateKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Roll qualifying plays up to entities (movies by rating_key, shows by
 * grandparent key — the join key the caller already computed as `entity_key`).
 * Returns a Map entityKey → { title, year, thumb, mediaType, genres, seconds, plays }.
 */
function aggregateEntities(plays) {
  const map = new Map();
  for (const p of plays) {
    if (!p.entity_key) continue;
    let e = map.get(p.entity_key);
    if (!e) {
      e = {
        key: p.entity_key,
        mediaType: p.media_type === 'episode' ? 'show' : 'movie',
        title: p.li_title || (p.media_type === 'episode' ? p.parent_title : p.title) || 'Unknown',
        year: p.li_year || (p.media_type === 'episode' ? null : p.year) || null,
        thumb: p.li_thumb || p.thumb || null,
        genres: parseGenres(p.li_genres),
        inLibrary: !!p.li_title,
        seconds: 0,
        plays: 0,
      };
      map.set(p.entity_key, e);
    }
    e.seconds += p.duration || 0;
    e.plays += 1;
  }
  return map;
}

function parseGenres(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.map((g) => (typeof g === 'string' ? g : g && g.tag)).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * History rows keep the rating key from watch time, so items deleted and
 * re-added to Plex miss the library join (rating-key drift): they lose their
 * poster/genres AND split into two entities when re-watched under the new key
 * (e.g. a show appearing at #1 and #5 of the same top list). Remap drifted
 * plays to the current library item by title (+year for movies) BEFORE any
 * aggregation, so per-user tops and cross-user maps all merge on one key.
 * Mutates the play rows in place.
 */
function resolveDriftedPlays(plays) {
  const stmt = db.prepare(
    'SELECT rating_key, title, year, thumb, genres FROM library_items WHERE type = ? AND title = ? COLLATE NOCASE LIMIT 5'
  );
  const cache = new Map();
  for (const p of plays) {
    if (p.li_title || !p.entity_key) continue; // present in library, or unkeyed
    const isShow = p.media_type === 'episode';
    const title = (isShow ? p.parent_title : p.title) || '';
    if (!title) continue;
    const cacheKey = `${isShow ? 'show' : 'movie'}|${title.toLowerCase()}|${isShow ? '' : p.year || ''}`;
    if (!cache.has(cacheKey)) {
      const rows = stmt.all(isShow ? 'show' : 'movie', title);
      // Movies with a known year must match it (remakes share titles).
      const match = !isShow && p.year ? rows.find((r) => r.year === p.year) : rows[0];
      cache.set(cacheKey, match || null);
    }
    const match = cache.get(cacheKey);
    if (!match) continue;
    p.entity_key = String(match.rating_key);
    p.li_title = match.title;
    p.li_year = match.year;
    p.li_thumb = match.thumb;
    p.li_genres = match.genres;
  }
}

function topEntities(entities, mediaType) {
  const list = [...entities.values()].filter((e) => e.mediaType === mediaType);
  const pick = (arr) => arr.slice(0, TOP_N).map((e) => ({
    // Drifted plays were remapped to current library keys before aggregation,
    // so inLibrary ⇔ the key is one Plex still knows (playlist-eligible).
    ratingKey: e.key, libraryKey: e.inLibrary ? e.key : null,
    title: e.title, year: e.year, thumb: e.thumb,
    seconds: e.seconds, plays: e.plays,
  }));
  return {
    bySeconds: pick([...list].sort((a, b) => b.seconds - a.seconds || b.plays - a.plays)),
    byPlays: pick([...list].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds)),
  };
}

/** Seconds-weighted top genres + percentage mix from an entity map. */
function computeGenres(entities) {
  const totals = new Map();
  let weighted = 0;
  for (const e of entities.values()) {
    for (const g of e.genres) {
      totals.set(g, (totals.get(g) || 0) + e.seconds);
      weighted += e.seconds;
    }
  }
  if (!weighted) return [];
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, seconds]) => ({ name, seconds, pct: Math.round((seconds / weighted) * 100) }));
}

/**
 * Hour/weekday/month histograms plus biggest binge day and longest streak of
 * consecutive local dates with at least one qualifying play.
 */
function computeTimeStats(plays) {
  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0); // 0 = Sunday
  const months = new Array(12).fill(0); // seconds per month
  const byDay = new Map(); // dateKey → { seconds, plays }
  for (const p of plays) {
    const d = new Date(p.watched_at * 1000);
    hours[d.getHours()] += 1;
    weekdays[d.getDay()] += 1;
    months[d.getMonth()] += p.duration || 0;
    const key = localDateKey(p.watched_at);
    const day = byDay.get(key) || { seconds: 0, plays: 0 };
    day.seconds += p.duration || 0;
    day.plays += 1;
    byDay.set(key, day);
  }

  let bingeDay = null;
  for (const [date, day] of byDay) {
    if (!bingeDay || day.seconds > bingeDay.seconds) bingeDay = { date, ...day };
  }

  // Longest run of consecutive dates. Dates are local-day keys; walk sorted
  // unique days and compare calendar distance via Date math (UTC-safe: keys
  // are reconstructed as local dates the same way they were produced).
  const days = [...byDay.keys()].sort();
  let streak = null;
  let runStart = null;
  let prev = null;
  const dayMs = 24 * 60 * 60 * 1000;
  for (const key of days) {
    const cur = new Date(`${key}T12:00:00`); // noon dodges DST edges
    if (prev && Math.round((cur - prev) / dayMs) === 1) {
      // run continues
    } else {
      runStart = key;
    }
    prev = cur;
    const length = Math.round((cur - new Date(`${runStart}T12:00:00`)) / dayMs) + 1;
    if (!streak || length > streak.days) streak = { days: length, start: runStart, end: key };
  }

  const peak = (arr) => arr.indexOf(Math.max(...arr));
  return {
    hours,
    weekdays,
    months,
    peakHour: plays.length ? peak(hours) : null,
    peakWeekday: plays.length ? peak(weekdays) : null,
    bingeDay,
    streak,
  };
}

// Birth decade, percentiles and show buddy live in wrappedStatsExtras.js
// (pure functions, split for the 500-line file limit).
const { computeBirthDecade, percentileOfRank, pickShowBuddy } = require('./wrappedStatsExtras');

// ── Compute (all users for one year) ─────────────────────────────────────────

function fetchPlays(year) {
  const [start, end] = yearWindow(year);
  return db.prepare(`
    SELECT wh.user_id, wh.user_name, wh.user_thumb, wh.media_type,
           wh.title, wh.parent_title, wh.year, wh.thumb, wh.watched_at,
           wh.duration, wh.percent_complete, wh.watched_status,
           CASE WHEN wh.media_type = 'episode' THEN wh.grandparent_rating_key ELSE wh.rating_key END AS entity_key,
           li.title AS li_title, li.year AS li_year, li.thumb AS li_thumb, li.genres AS li_genres
    FROM watch_history wh
    LEFT JOIN library_items li
      ON li.rating_key = CASE WHEN wh.media_type = 'episode' THEN wh.grandparent_rating_key ELSE wh.rating_key END
    WHERE wh.watched_at >= ? AND wh.watched_at < ? AND wh.user_id IS NOT NULL
  `).all(start, end);
}

/** Per-user app activity (requests, reviews, reactions received) for the window. */
function fetchActivity(year) {
  const [start, end] = yearWindow(year);
  const activity = new Map();
  const get = (uid) => {
    if (!activity.has(uid)) activity.set(uid, { requests: 0, reviews: 0, avgRating: null, reactionsReceived: 0 });
    return activity.get(uid);
  };
  for (const r of db.prepare(
    'SELECT user_id, COUNT(*) AS c FROM discover_requests WHERE requested_at >= ? AND requested_at < ? GROUP BY user_id'
  ).all(start, end)) get(String(r.user_id)).requests = r.c;
  for (const r of db.prepare(
    'SELECT user_id, COUNT(*) AS c, AVG(rating) AS avg FROM reviews WHERE created_at >= ? AND created_at < ? GROUP BY user_id'
  ).all(start, end)) {
    const a = get(String(r.user_id));
    a.reviews = r.c;
    a.avgRating = r.avg != null ? Math.round(r.avg * 10) / 10 : null;
  }
  for (const r of db.prepare(`
    SELECT rv.user_id AS user_id, COUNT(*) AS c
    FROM review_reactions rr JOIN reviews rv ON rv.id = rr.review_id
    WHERE rr.created_at >= ? AND rr.created_at < ? GROUP BY rv.user_id
  `).all(start, end)) get(String(r.user_id)).reactionsReceived = r.c;
  return activity;
}

/** Per-user review highlights for the "Critic" slide. Map userId → detail. */
function fetchReviewDetails(year) {
  const [start, end] = yearWindow(year);
  const byUser = new Map();
  for (const r of db.prepare(
    'SELECT user_id, title, year, rating, reaction_count FROM reviews WHERE created_at >= ? AND created_at < ?'
  ).all(start, end)) {
    const uid = String(r.user_id);
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }
  const details = new Map();
  for (const [uid, rows] of byUser) {
    const pick = (arr) => ({ title: arr.title, year: arr.year, rating: arr.rating, reactions: arr.reaction_count });
    const mostLoved = [...rows].sort((a, b) => b.reaction_count - a.reaction_count || b.rating - a.rating)[0];
    const highest = [...rows].sort((a, b) => b.rating - a.rating)[0];
    const lowest = [...rows].sort((a, b) => a.rating - b.rating)[0];
    details.set(uid, {
      count: rows.length,
      avgRating: Math.round((rows.reduce((s, r) => s + r.rating, 0) / rows.length) * 10) / 10,
      mostLoved: mostLoved.reaction_count > 0 ? pick(mostLoved) : null,
      highest: pick(highest),
      // Only a real "harshest take" when it differs from their favorite.
      lowest: lowest.rating < highest.rating ? pick(lowest) : null,
    });
  }
  return details;
}

/**
 * Compute and persist Wrapped for every user for `year`.
 * Returns { users, computedAt }.
 */
function computeWrappedYear(year) {
  const allPlays = fetchPlays(year);
  resolveDriftedPlays(allPlays);
  const activity = fetchActivity(year);
  const reviewDetails = fetchReviewDetails(year);

  // Split per user; keep both all plays (completion denominator) and qualifying.
  const byUser = new Map();
  for (const p of allPlays) {
    const uid = String(p.user_id);
    let u = byUser.get(uid);
    if (!u) {
      u = { userId: uid, userName: p.user_name || uid, userThumb: p.user_thumb || null, all: [], qualifying: [] };
      byUser.set(uid, u);
    }
    u.all.push(p);
    if (p.user_name) u.userName = p.user_name;
    if (p.user_thumb) u.userThumb = p.user_thumb;
    if (playQualifies(p)) u.qualifying.push(p);
  }

  // Cross-user: per-show watch seconds (for buddy + fan percentile).
  const showWatchers = new Map(); // showKey → Map(userId → seconds)
  for (const u of byUser.values()) {
    for (const p of u.qualifying) {
      if (p.media_type !== 'episode' || !p.entity_key) continue;
      let m = showWatchers.get(p.entity_key);
      if (!m) { m = new Map(); showWatchers.set(p.entity_key, m); }
      m.set(u.userId, (m.get(u.userId) || 0) + (p.duration || 0));
    }
  }

  // Leaderboard over users with at least one qualifying play.
  const ranked = [...byUser.values()]
    .map((u) => ({
      userId: u.userId, userName: u.userName, userThumb: u.userThumb,
      seconds: u.qualifying.reduce((s, p) => s + (p.duration || 0), 0),
      plays: u.qualifying.length,
    }))
    .filter((u) => u.plays > 0)
    .sort((a, b) => b.seconds - a.seconds || b.plays - a.plays);
  const userCount = ranked.length;
  const rankOf = new Map(ranked.map((u, i) => [u.userId, i + 1]));

  const computedAt = Math.floor(Date.now() / 1000);
  const globalPayload = {
    v: PAYLOAD_VERSION,
    year,
    leaderboard: ranked,
    totals: {
      seconds: ranked.reduce((s, u) => s + u.seconds, 0),
      plays: ranked.reduce((s, u) => s + u.plays, 0),
      userCount,
    },
  };

  const upsertUser = db.prepare(`
    INSERT INTO wrapped_stats (user_id, year, payload, share_slug, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, year) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at
  `);

  for (const u of byUser.values()) {
    if (!u.qualifying.length) continue;
    const entities = aggregateEntities(u.qualifying);
    const movieEntities = [...entities.values()].filter((e) => e.mediaType === 'movie');
    const showEntities = [...entities.values()].filter((e) => e.mediaType === 'show');
    const seconds = (list) => list.reduce((s, e) => s + e.seconds, 0);
    const plays = (list) => list.reduce((s, e) => s + e.plays, 0);

    const completed = u.all.filter((p) => p.watched_status === 'complete').length;
    const dated = [...entities.values()].filter((e) => e.year && e.year >= 1800);
    const oldestEntity = dated.sort((a, b) => a.year - b.year)[0] || null;

    const topShows = topEntities(entities, 'show');
    const topMovies = topEntities(entities, 'movie');
    const topShow = topShows.bySeconds[0] || null;

    let topShowFan = null;
    let buddy = null;
    if (topShow && showWatchers.has(topShow.ratingKey)) {
      const watchers = showWatchers.get(topShow.ratingKey);
      const fanRanked = [...watchers.entries()].sort((a, b) => b[1] - a[1]);
      const fanRank = fanRanked.findIndex(([uid]) => uid === u.userId) + 1;
      topShowFan = {
        title: topShow.title,
        rank: fanRank,
        watcherCount: fanRanked.length,
        pct: percentileOfRank(fanRank, fanRanked.length),
      };
      const b = pickShowBuddy(u.userId, watchers);
      if (b) {
        const other = byUser.get(b.userId);
        buddy = {
          userId: b.userId,
          userName: other ? other.userName : b.userId,
          userThumb: other ? other.userThumb : null,
          showTitle: topShow.title,
          mySeconds: b.mySeconds,
          theirSeconds: b.theirSeconds,
        };
      }
    }

    const rank = rankOf.get(u.userId) || null;
    const payload = {
      v: PAYLOAD_VERSION,
      year,
      user: { id: u.userId, name: u.userName, thumb: u.userThumb },
      totals: {
        seconds: seconds([...entities.values()]),
        plays: u.qualifying.length,
        distinctTitles: entities.size,
        movies: { seconds: seconds(movieEntities), plays: plays(movieEntities), count: movieEntities.length },
        shows: { seconds: seconds(showEntities), episodes: plays(showEntities), count: showEntities.length },
        completionRate: u.all.length ? Math.round((completed / u.all.length) * 100) : 0,
      },
      oldest: oldestEntity
        ? { title: oldestEntity.title, year: oldestEntity.year, mediaType: oldestEntity.mediaType, thumb: oldestEntity.thumb }
        : null,
      topMovies,
      topShows,
      genres: computeGenres(entities),
      time: computeTimeStats(u.qualifying),
      percentile: { viewer: percentileOfRank(rank, userCount), rank, userCount, topShow: topShowFan },
      decade: computeBirthDecade(entities, year),
      buddy,
      personality: null, // filled below (needs genres/time/totals/decade)
      activity: activity.get(u.userId) || { requests: 0, reviews: 0, avgRating: null, reactionsReceived: 0 },
      reviews: reviewDetails.get(u.userId) || null,
    };

    payload.personality = computePersonality(payload);
    upsertUser.run(u.userId, year, JSON.stringify(payload), crypto.randomBytes(8).toString('hex'), computedAt);
  }

  db.prepare(`
    INSERT INTO wrapped_global (year, payload, computed_at) VALUES (?, ?, ?)
    ON CONFLICT(year) DO UPDATE SET payload = excluded.payload, computed_at = excluded.computed_at
  `).run(year, JSON.stringify(globalPayload), computedAt);

  return { users: userCount, computedAt };
}

// ── Read API (lazy compute with TTL) ─────────────────────────────────────────

function getGlobalRow(year) {
  return db.prepare('SELECT payload, computed_at FROM wrapped_global WHERE year = ?').get(year) || null;
}

/** Ensure `year` is computed; the in-progress year is refreshed at most daily. */
function ensureComputed(year, { force = false } = {}) {
  const globalRow = getGlobalRow(year);
  const currentYear = new Date().getFullYear();
  const stale = year === currentYear
    && (!globalRow || Math.floor(Date.now() / 1000) - globalRow.computed_at > CURRENT_YEAR_TTL);
  if (force || !globalRow || stale) return computeWrappedYear(year);
  return null;
}

/**
 * Full Wrapped response for a user: { payload, global, shareSlug, computedAt }
 * or { notEnoughData: true, global } when the user has no qualifying plays.
 */
function getWrapped(userId, year) {
  ensureComputed(year);
  const read = () => db.prepare('SELECT payload, share_slug, computed_at FROM wrapped_stats WHERE user_id = ? AND year = ?')
    .get(String(userId), year);
  let row = read();
  // Payloads cached before the current schema are recomputed once on demand.
  if (row && (JSON.parse(row.payload).v || 1) < PAYLOAD_VERSION) {
    computeWrappedYear(year);
    row = read();
  }
  const globalRow = getGlobalRow(year);
  const global = globalRow ? JSON.parse(globalRow.payload) : null;
  if (!row) return { notEnoughData: true, global };
  return { payload: JSON.parse(row.payload), global, shareSlug: row.share_slug, computedAt: row.computed_at };
}

/** Lookup by capability slug for the public /og/wrapped image routes. */
function getWrappedBySlug(slug) {
  const read = () => db.prepare('SELECT user_id, year, payload, computed_at FROM wrapped_stats WHERE share_slug = ?')
    .get(String(slug));
  let row = read();
  if (!row) return null;
  if ((JSON.parse(row.payload).v || 1) < PAYLOAD_VERSION) {
    computeWrappedYear(row.year);
    row = read();
  }
  const globalRow = getGlobalRow(row.year);
  return {
    userId: row.user_id,
    year: row.year,
    payload: JSON.parse(row.payload),
    global: globalRow ? JSON.parse(globalRow.payload) : null,
    computedAt: row.computed_at,
  };
}

/** Unlocked years that have any history; admins also get the locked current year. */
function getAvailableYears(isAdmin, now = new Date()) {
  const r = db.prepare('SELECT MIN(watched_at) AS mn FROM watch_history WHERE watched_at > 0').get();
  const currentYear = now.getFullYear();
  const years = [];
  if (r && r.mn) {
    const first = new Date(r.mn * 1000).getFullYear();
    for (let y = currentYear; y >= first; y--) {
      if (isYearUnlocked(y, now)) years.push(y);
    }
  }
  const previewYear = isAdmin && !isYearUnlocked(currentYear, now) && r && r.mn ? currentYear : null;
  return { years, previewYear, current: currentYear };
}

/** Daily job: keep the in-progress year fresh during December only. */
function refreshIfDecember(now = new Date()) {
  if (now.getMonth() !== 11) return null;
  return computeWrappedYear(now.getFullYear());
}

module.exports = {
  computeWrappedYear,
  getWrapped,
  getWrappedBySlug,
  getAvailableYears,
  isYearUnlocked,
  refreshIfDecember,
  // pure helpers exported for unit tests
  playQualifies,
  yearWindow,
  aggregateEntities,
  computeGenres,
  computeTimeStats,
  computeBirthDecade,
  percentileOfRank,
  pickShowBuddy,
};
