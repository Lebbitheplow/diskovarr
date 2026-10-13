const crypto = require('crypto');
const { getSetting } = require('../db');

// Sessions for the qBittorrent-compatible API. Sonarr logs in with
// username 'tuberr' + Tuberr's management API key as the password (Diskovarr's
// "Set up Sonarr" writes exactly that), gets a random SID cookie, and sends it
// on every call. Like real qBittorrent, a missing/unknown/expired SID gets
// 403 Forbidden; Sonarr's QBittorrentProxyV2 responds to a 403 by logging in
// again, so keeping sessions in memory (lost on restart) is fine.

const USERNAME = 'tuberr';
// Sliding expiry, same as qBittorrent's default WebUI session timeout. Sonarr
// polls every minute, so an active Sonarr never sees it lapse.
const SESSION_TTL_MS = 60 * 60 * 1000;
// Bounds memory if something keeps logging in without reusing its cookie;
// the least recently used session is evicted first.
const MAX_SESSIONS = 64;

const sessions = new Map(); // sid → expiresAt (Map order = least recently used first)

// Constant-time comparison that does not leak length: compare digests.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkCredentials(username, password) {
  const key = getSetting('api_key');
  if (!key) return false;
  // Evaluate both so a wrong username costs the same as a wrong password
  const userOk = safeEqual(username ?? '', USERNAME);
  const passOk = safeEqual(password ?? '', key);
  return userOk && passOk;
}

function prune(now = Date.now()) {
  for (const [sid, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(sid);
  }
}

function createSession() {
  prune();
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const sid = crypto.randomBytes(16).toString('hex');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return sid;
}

// Validates and refreshes a session. Returns false for unknown/expired SIDs.
function touchSession(sid) {
  if (!sid) return false;
  const expiresAt = sessions.get(sid);
  if (!expiresAt) return false;
  sessions.delete(sid);
  if (expiresAt <= Date.now()) return false;
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return true;
}

function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

// Called when the API key is rotated: every outstanding SID was issued
// against the old password, so none of them may keep working.
function clearSessions() {
  sessions.clear();
}

function sidFromRequest(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === 'SID') return part.slice(eq + 1).trim();
  }
  return '';
}

module.exports = {
  USERNAME, SESSION_TTL_MS, MAX_SESSIONS,
  checkCredentials, createSession, touchSession, destroySession, clearSessions, sidFromRequest,
  sessionCount: () => sessions.size,
};
