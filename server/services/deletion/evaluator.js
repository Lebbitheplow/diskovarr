// Deletion profile criteria evaluation. Criteria rows are { field, op, value }
// AND-combined; exclusions are checked after a match. Pure functions over
// library_items rows (rowToItem shape) + a ctx of cross-user watch stats —
// no I/O here, which keeps the dry-run preview and the real run identical.

const DAY = 86400;

const LIST_FIELDS = {
  genre: 'genres', actor: 'cast', director: 'directors', writer: 'writers',
  producer: 'producers', country: 'countries', collection: 'collections', label: 'labels',
};

const toArray = v => (Array.isArray(v) ? v : [v]).map(x => String(x).toLowerCase().trim()).filter(Boolean);

function numOp(actual, op, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return false;
  switch (op) {
    case 'gt': return actual > v;
    case 'gte': return actual >= v;
    case 'lt': return actual < v;
    case 'lte': return actual <= v;
    case 'eq': return actual === v;
    case 'neq': return actual !== v;
    default: return false;
  }
}

function listOp(items, op, value) {
  const haystack = (items || []).map(x => String(x).toLowerCase());
  const wanted = toArray(value);
  const hit = wanted.some(w => haystack.includes(w));
  return op === 'not_contains' ? !hit : hit; // default op: contains (any-of)
}

function stringOp(actual, op, value) {
  const a = String(actual || '').toLowerCase();
  if (!a) return false;
  const wanted = toArray(value);
  switch (op) {
    case 'neq':
    case 'not_in': return !wanted.includes(a);
    case 'contains': return wanted.some(w => a.includes(w));
    default: return wanted.includes(a); // eq / in
  }
}

// Returns a human-readable reason string when the criterion matches, else null.
function matchCriterion(item, ctx, { field, op, value }) {
  const now = ctx.now;
  const stats = ctx.viewStats[String(item.ratingKey)] || null;
  const plays = stats ? stats.plays : 0;
  const lastPlayedAt = stats ? stats.lastPlayedAt : 0;

  if (LIST_FIELDS[field]) {
    return listOp(item[LIST_FIELDS[field]], op, value)
      ? `${field} ${op === 'not_contains' ? 'not in' : 'matches'} ${JSON.stringify(value)}` : null;
  }

  switch (field) {
    case 'audience_rating': {
      // 0 / null means "unrated" — never let lt/gt sweep up unrated items
      const r = Number(item.audienceRating) || 0;
      return r > 0 && numOp(r, op, value) ? `audience rating ${r} ${op} ${value}` : null;
    }
    case 'critic_rating': {
      const r = Number(item.rating) || 0;
      return r > 0 && numOp(r, op, value) ? `critic rating ${r} ${op} ${value}` : null;
    }
    case 'content_rating':
      return stringOp(item.contentRating, op, value) ? `content rating ${item.contentRating}` : null;
    case 'studio':
      return stringOp(item.studio, op, value) ? `studio ${item.studio}` : null;
    case 'edition':
      return stringOp(item.edition, op, value) ? `edition ${item.edition}` : null;
    case 'runtime_minutes': {
      const mins = (item.duration || 0) / 60000;
      return mins > 0 && numOp(mins, op, value) ? `runtime ${Math.round(mins)}m ${op} ${value}m` : null;
    }
    case 'year':
      return item.year > 0 && numOp(item.year, op, value) ? `year ${item.year} ${op} ${value}` : null;
    case 'video_resolution': {
      // null = unknown (e.g. shows) — matches nothing, deletion stays conservative
      if (!item.videoResolution) return null;
      return stringOp(item.videoResolution, op, value) ? `resolution ${item.videoResolution}` : null;
    }
    case 'file_size_gb': {
      const gb = (item.fileSize || 0) / 1e9;
      return gb > 0 && numOp(gb, op, value) ? `size ${gb.toFixed(1)}GB ${op} ${value}GB` : null;
    }
    case 'added_days_ago': {
      if (!item.addedAt) return null;
      const days = (now - item.addedAt) / DAY;
      return numOp(days, op, value) ? `added ${Math.floor(days)}d ago ${op} ${value}d` : null;
    }
    case 'last_played_days_ago': {
      // "Not played in the last X days" — never-played counts as infinitely old
      const days = lastPlayedAt > 0 ? (now - lastPlayedAt) / DAY : Infinity;
      if (op === 'gt' || op === 'gte') {
        return numOp(days === Infinity ? Number.MAX_SAFE_INTEGER : days, op, value)
          ? (lastPlayedAt ? `last played ${Math.floor(days)}d ago` : 'never played') : null;
      }
      // lt/lte ("played within X days") requires an actual play
      return lastPlayedAt > 0 && numOp(days, op, value) ? `last played ${Math.floor(days)}d ago` : null;
    }
    case 'never_played':
      return (plays === 0) === (value === true || value === 'true') ? (plays === 0 ? 'never played' : 'has been played') : null;
    case 'plays': {
      return numOp(plays, op, value) ? `${plays} plays ${op} ${value}` : null;
    }
    default:
      return null; // unknown field never matches — fail safe
  }
}

const WATCH_FIELDS = new Set(['last_played_days_ago', 'never_played', 'plays']);

function usesWatchData(profile) {
  return (profile.criteria || []).some(c => WATCH_FIELDS.has(c.field));
}

function isExcluded(item, ctx, exclusions) {
  if (exclusions.watchlisted !== false && ctx.watchlistedKeys.has(String(item.ratingKey))) {
    return 'on a user watchlist';
  }
  if (Array.isArray(exclusions.collections) && exclusions.collections.length > 0
      && listOp(item.collections, 'contains', exclusions.collections)) {
    return 'in an excluded collection';
  }
  if (Array.isArray(exclusions.labels) && exclusions.labels.length > 0
      && listOp(item.labels, 'contains', exclusions.labels)) {
    return 'has an excluded label';
  }
  const minAge = Number(exclusions.minAgeDays) || 0;
  if (minAge > 0 && item.addedAt && (ctx.now - item.addedAt) / DAY < minAge) {
    return `added less than ${minAge}d ago`;
  }
  return null;
}

/**
 * Evaluate one profile over the library. Returns { matches, excluded } where
 * matches = [{ item, reasons }]. A profile with zero criteria matches nothing —
 * an empty profile must never mean "delete everything".
 */
function evaluateProfile(profile, items, ctx) {
  const criteria = profile.criteria || [];
  const matches = [];
  let excluded = 0;
  if (criteria.length === 0) return { matches, excluded };

  const wantType = profile.mediaType === 'show' ? 'show' : 'movie';
  for (const item of items) {
    if (item.type !== wantType) continue;
    const reasons = [];
    let all = true;
    for (const criterion of criteria) {
      const reason = matchCriterion(item, ctx, criterion);
      if (!reason) { all = false; break; }
      reasons.push(reason);
    }
    if (!all) continue;
    if (isExcluded(item, ctx, profile.exclusions || {})) { excluded++; continue; }
    matches.push({ item, reasons });
  }
  return { matches, excluded };
}

module.exports = { evaluateProfile, usesWatchData, matchCriterion };
