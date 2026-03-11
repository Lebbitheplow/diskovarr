/**
 * Overseerr helpers — agent user management and request submission.
 *
 * Diskovarr creates a dedicated local Overseerr user "Diskovarr Agent" so
 * that requests are clearly attributed in Overseerr rather than appearing
 * under the admin account.  The user ID is cached in the settings table so
 * we only hit the Overseerr API when the agent doesn't exist yet (or was
 * deleted and needs to be re-created).
 */

const db = require('../db/database');

const AGENT_USERNAME = 'Diskovarr Agent';
const AGENT_EMAIL    = 'diskovarr-agent@diskovarr.local';
const AGENT_PASSWORD = 'DiskovarrAgent!1';
const SETTING_KEY    = 'overseerr_agent_user_id';

// Module-level in-memory cache so we only read the DB once per process.
let _cachedAgentId = null;

/**
 * Returns the Overseerr user ID for the "Diskovarr Agent" account, creating
 * it if it doesn't exist.  Clears and retries once if the cached ID is stale.
 */
async function getOrCreateAgentUserId(baseUrl, apiKey) {
  const url = baseUrl.replace(/\/$/, '');
  const headers = {
    'X-Api-Key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // 1. Try cached value first (memory → DB)
  if (!_cachedAgentId) {
    const stored = db.getSetting(SETTING_KEY, '');
    if (stored) _cachedAgentId = Number(stored);
  }

  // 2. Verify the cached ID still exists in Overseerr
  if (_cachedAgentId) {
    const check = await fetch(`${url}/api/v1/user/${_cachedAgentId}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (check.ok) return _cachedAgentId;
    // User was deleted — clear cache and fall through to find/create
    _cachedAgentId = null;
    db.setSetting(SETTING_KEY, '');
  }

  // 3. Search existing users for the agent account
  const listRes = await fetch(`${url}/api/v1/user?take=250&skip=0`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!listRes.ok) throw new Error(`Overseerr user list failed: ${listRes.status}`);
  const listData = await listRes.json();
  const existing = (listData.results || []).find(
    u => u.username === AGENT_USERNAME || u.email === AGENT_EMAIL
  );
  if (existing) {
    _cachedAgentId = existing.id;
    db.setSetting(SETTING_KEY, String(existing.id));
    return existing.id;
  }

  // 4. Create the agent user
  const createRes = await fetch(`${url}/api/v1/user`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      username: AGENT_USERNAME,
      email: AGENT_EMAIL,
      password: AGENT_PASSWORD,
      // Permissions: REQUEST (4) + AUTO_APPROVE_MOVIE (32) + AUTO_APPROVE_TV (64)
      permissions: 100,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`Failed to create Overseerr agent user: ${createRes.status} ${body}`);
  }
  const created = await createRes.json();
  _cachedAgentId = created.id;
  db.setSetting(SETTING_KEY, String(created.id));
  return created.id;
}

module.exports = { getOrCreateAgentUserId };
