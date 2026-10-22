const db = require('../db/database');
const logger = require('./logger');

// Plex ↔ Jellyfin account links. The database calls re-key the stored rows;
// these wrappers also update what is held in memory — memoised library access
// and the recommendation caches built from it, cached Watch Together
// credentials, live parties — so a link change applies at once. Sessions are
// re-checked against the current link per request (requireAuth).

function changed(jfId, plexId, opts) {
  try { require('./watchParty').onAccountLink(jfId, plexId, opts); }
  catch (err) { logger.warn(`[accountLinks] Watch Together update failed: ${err.message}`); }
  const libraryAccess = require('./libraryAccess');
  for (const id of [plexId, jfId]) libraryAccess.changed(id);
}

// Throws (code 'LINK_CONFLICT') when the Plex user already has another
// Jellyfin account linked.
function link(jfId, plexId) {
  db.linkJellyfinAccount(jfId, plexId);
  changed(String(jfId), String(plexId), { merged: true });
}

function unlink(jfId) {
  const plexId = db.resolveCanonicalUserId(jfId);
  db.unlinkJellyfinAccount(jfId);
  changed(String(jfId), plexId);
}

module.exports = { link, unlink };
