// Persistence for per-user library access snapshots (tables from the
// library_access_v1 migration). Rows are keyed by provider identity — a Plex
// account id or 'jf_<guid>' — and source ('plex' | 'jellyfin').
const db = require('../../db/database');

const now = () => Math.floor(Date.now() / 1000);
const sortedIds = (list) => [...new Set((list || []).map(String))].sort();

function getRow(userId, source) {
  return db.prepare('SELECT * FROM user_library_access WHERE user_id = ? AND source = ?')
    .get(String(userId), source) || null;
}

function allRows() {
  return db.prepare('SELECT * FROM user_library_access ORDER BY user_id, source').all();
}

function visibleKeys(userId, source) {
  return new Set(db.prepare('SELECT rating_key FROM user_visible_items WHERE user_id = ? AND source = ?')
    .all(String(userId), source).map(r => r.rating_key));
}

/**
 * Store a successful snapshot (fetched_at = now, last_error cleared or set to
 * `note`). `visibleKeys` lists what the user sees in `filteredSectionIds` and is
 * ignored when there are none. Returns true when what the user can see changed
 * (including the first snapshot after none or only failures).
 */
function saveSnapshot(userId, source, {
  role, allSections = false, sectionIds = [], filteredSectionIds = [], filters = null, visibleKeys: keys = null, note = null,
}) {
  const uid = String(userId);
  const prev = getRow(uid, source);
  const sections = JSON.stringify(sortedIds(sectionIds));
  const filteredList = sortedIds(filteredSectionIds);
  const filtered = JSON.stringify(filteredList);
  const nextKeys = filteredList.length ? sortedIds(keys ? [...keys] : []) : [];
  const prevKeys = prev ? [...visibleKeys(uid, source)].sort() : [];
  const keysChanged = prevKeys.length !== nextKeys.length || prevKeys.some((k, i) => k !== nextKeys[i]);
  const changed = !prev || !prev.fetched_at || prev.role !== role
    || prev.all_sections !== (allSections ? 1 : 0)
    || prev.section_ids !== sections || prev.filtered_section_ids !== filtered || keysChanged;
  const ts = now();
  db.withTransaction(() => {
    db.prepare(`
      INSERT INTO user_library_access
        (user_id, source, role, all_sections, section_ids, filtered_section_ids, filters, fetched_at, last_attempt_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, source) DO UPDATE SET
        role = excluded.role, all_sections = excluded.all_sections, section_ids = excluded.section_ids,
        filtered_section_ids = excluded.filtered_section_ids, filters = excluded.filters,
        fetched_at = excluded.fetched_at, last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
    `).run(uid, source, role, allSections ? 1 : 0, sections, filtered,
      filters ? JSON.stringify(filters) : null, ts, ts, note ? String(note).slice(0, 500) : null);
    if (keysChanged) {
      db.prepare('DELETE FROM user_visible_items WHERE user_id = ? AND source = ?').run(uid, source);
      const ins = db.prepare('INSERT OR IGNORE INTO user_visible_items (user_id, source, rating_key) VALUES (?, ?, ?)');
      for (const k of nextKeys) ins.run(uid, source, k);
    }
  });
  return changed;
}

// A failed refresh: the last good snapshot (and fetched_at) stays; only the
// attempt time and error are recorded. A user with no snapshot gets a row with
// fetched_at NULL, which reads as "no access" (fail closed).
function recordError(userId, source, message) {
  const ts = now();
  db.prepare(`
    INSERT INTO user_library_access (user_id, source, role, last_attempt_at, last_error)
    VALUES (?, ?, 'unknown', ?, ?)
    ON CONFLICT(user_id, source) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
  `).run(String(userId), source, ts, String(message || 'Unknown error').slice(0, 500));
}

// A failed refresh whose last good snapshot no longer applies (a restriction
// was added since): the snapshot is dropped, so the user reads as "no access"
// and is retried like one who never had a snapshot. Returns true when that
// took a snapshot away.
function clearSnapshot(userId, source, message) {
  const uid = String(userId);
  const hadSnapshot = !!getRow(uid, source)?.fetched_at;
  db.withTransaction(() => {
    db.prepare(`
      INSERT INTO user_library_access (user_id, source, role, last_attempt_at, last_error)
      VALUES (?, ?, 'unknown', ?, ?)
      ON CONFLICT(user_id, source) DO UPDATE SET
        role = 'unknown', all_sections = 0, section_ids = '[]', filtered_section_ids = '[]', filters = NULL,
        fetched_at = NULL, last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
    `).run(uid, source, now(), String(message || 'Unknown error').slice(0, 500));
    db.prepare('DELETE FROM user_visible_items WHERE user_id = ? AND source = ?').run(uid, source);
  });
  return hadSnapshot;
}

module.exports = { getRow, allRows, visibleKeys, saveSnapshot, recordError, clearSnapshot };
