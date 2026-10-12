// Pure access checks over an Access object (see ./index.js). No requires, so
// db/database.js can use sqlPredicate without a require cycle.
//
// Access = { userId, plex: SourceAccess | null, jellyfin: SourceAccess | null, fp }
// SourceAccess = { userId /* provider identity */, all, sections: Set, filtered: Map<sectionId, Set<ratingKey>> }
// A null Access is unrestricted; a null source means no access to that server.
// An undefined Access (say req.libraryAccess on a router without the
// middleware) is a caller bug and sees nothing rather than everything.

const SOURCES = ['plex', 'jellyfin'];

function sourceOf(item, sectionId) {
  const s = item.source;
  if (s === 'plex' || s === 'jellyfin') return s;
  return String(sectionId).startsWith('jf_') ? 'jellyfin' : 'plex';
}

// Whether a library item/row with a known section is visible. Callers without a
// section go through index.js allowsKey (which looks the row up).
function allowsRow(access, item) {
  if (access === undefined) return false;
  if (!access) return true;
  const sectionId = item.sectionId ?? item.section_id;
  if (sectionId == null) return false;
  const src = access[sourceOf(item, sectionId)];
  if (!src) return false;
  const sid = String(sectionId);
  const visible = src.filtered.get(sid);
  if (visible) return visible.has(String(item.ratingKey ?? item.rating_key));
  return src.all || src.sections.has(sid);
}

const marks = (list) => list.map(() => '?').join(', ');

// { sql, params } restricting a library_items query to what `access` may see.
// `alias` prefixes the columns ('li' → li.section_id). Filtered sections (Plex
// content filters, Jellyfin parental controls) join the user's visible-item list.
function sqlPredicate(access, alias = '') {
  if (access === undefined) return { sql: '0=1', params: [] };
  if (!access) return { sql: '1=1', params: [] };
  const a = alias ? `${alias}.` : '';
  const parts = [];
  const params = [];
  for (const source of SOURCES) {
    const src = access[source];
    if (!src) continue;
    const filteredIds = [...src.filtered.keys()];
    const sub = [];
    const subParams = [];
    if (src.all) {
      if (filteredIds.length) {
        sub.push(`${a}section_id NOT IN (${marks(filteredIds)})`);
        subParams.push(...filteredIds);
      } else {
        sub.push('1=1');
      }
    } else {
      const full = [...src.sections].filter(id => !src.filtered.has(id));
      if (full.length) {
        sub.push(`${a}section_id IN (${marks(full)})`);
        subParams.push(...full);
      }
    }
    if (filteredIds.length) {
      sub.push(`(${a}section_id IN (${marks(filteredIds)}) AND ${a}rating_key IN `
        + '(SELECT rating_key FROM user_visible_items WHERE user_id = ? AND source = ?))');
      subParams.push(...filteredIds, src.userId, source);
    }
    if (!sub.length) continue;
    parts.push(`(${a}source = ? AND (${sub.join(' OR ')}))`);
    params.push(source, ...subParams);
  }
  if (!parts.length) return { sql: '0=1', params: [] };
  return { sql: `(${parts.join(' OR ')})`, params };
}

module.exports = { allowsRow, sqlPredicate, sourceOf };
