const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const logger = require('../services/logger');
const jellyfinService = require('../services/jellyfin');

const checkPinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests' },
});

// Credential logins get admin-login-strength limiting (Jellyfin auth is
// username/password — there is no PIN indirection to absorb guessing).
const jellyfinLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many login attempts' },
});

function isPlexConfigured() {
  return !!(db.getSetting('plex_url', null) || process.env.PLEX_URL) || !!process.env.PLEX_SERVER_ID;
}

// Library sources this deployment offers. The per-user toggle only renders when
// there is more than one.
function availableSources() {
  const sources = [];
  if (isPlexConfigured()) sources.push('plex');
  if (jellyfinService.isEnabled()) sources.push('jellyfin');
  return sources.length ? sources : ['plex'];
}

// Active source for a fresh session: persisted preference if valid, else the
// provider the user just signed in with, else whatever the server offers.
function pickActiveSource(loginProvider, canonicalId) {
  const sources = availableSources();
  const pref = db.getUserPreferences(canonicalId).preferred_source;
  if (pref && sources.includes(pref)) return pref;
  if (sources.includes(loginProvider)) return loginProvider;
  return sources[0];
}

// Session identity shared by both login paths. `plexUser` keeps its historic
// name — dozens of routes read it — but carries either provider's identity.
function buildSessionUser({ canonicalId, username, thumb, plexToken, plexServerToken, provider, jellyfin }) {
  return {
    id: String(canonicalId),
    username,
    thumb,
    token: plexToken || null,
    serverToken: plexServerToken || null,
    provider,
    jellyfin: jellyfin || null, // { userId: <jf guid>, token } when a Jellyfin identity is attached
  };
}

const PLEX_CLIENT_ID = 'diskovarr-app';
const PLEX_SERVER_ID = process.env.PLEX_SERVER_ID;

const PLEX_TV_HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
  'X-Plex-Product': 'Diskovarr',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Web',
};

// POST /auth/create-pin — creates a Plex PIN server-side (avoids browser CORS restrictions)
router.post('/create-pin', async (req, res) => {
  try {
    const pinRes = await fetch('https://plex.tv/api/v2/pins', {
      method: 'POST',
      headers: { ...PLEX_TV_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'strong=true',
      signal: AbortSignal.timeout(15000),
    });
    if (!pinRes.ok) throw new Error(`Plex PIN creation failed: ${pinRes.status}`);
    const pin = await pinRes.json();
    logger.info(`PIN created: id=${pin.id}`);
    res.json({ id: pin.id, code: pin.code });
  } catch (err) {
    logger.error(`PIN creation error: ${err.message}`);
    res.status(502).json({ error: 'Could not reach Plex' });
  }
});

// POST /auth/callback — stores PIN in session (for React SPA). `link: true`
// marks this PIN flow as an account-link for a signed-in Jellyfin user rather
// than a fresh login.
router.post('/callback', (req, res) => {
  const { pinId, pinCode, link } = req.body || {};
  logger.info(`POST callback: sessionID=${req.sessionID} pinId=${pinId || 'missing'}${link ? ' (link mode)' : ''}`);
  if (pinId && pinCode) {
    req.session.plexPinId = pinId;
    req.session.plexPinCode = pinCode;
    if (link && req.session.plexUser?.provider === 'jellyfin') req.session.plexLinkMode = true;
  }
  res.json({ ok: true });
});

// GET /auth/check-pin — polled by client JS
router.get('/check-pin', checkPinLimiter, async (req, res) => {
  const pinId = req.session.plexPinId;
  logger.info(`check-pin: sessionID=${req.sessionID} pinId=${pinId || 'MISSING'}`);
  if (!pinId) {
    return res.json({ status: 'expired' });
  }

  try {
    const pinRes = await fetch(`https://plex.tv/api/v2/pins/${pinId}`, {
      headers: PLEX_TV_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!pinRes.ok) throw new Error(`Pin check failed: ${pinRes.status}`);
    const pinData = await pinRes.json();

    if (!pinData.authToken) {
      return res.json({ status: 'pending' });
    }

    const userToken = pinData.authToken;

    // Get user info from plex.tv
    const userRes = await fetch('https://plex.tv/api/v2/user', {
      headers: { ...PLEX_TV_HEADERS, 'X-Plex-Token': userToken },
      signal: AbortSignal.timeout(10000),
    });
    if (!userRes.ok) throw new Error(`User fetch failed: ${userRes.status}`);
    const userData = await userRes.json();

    // Verify user has access to this server
    const resourcesRes = await fetch('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
      headers: { ...PLEX_TV_HEADERS, 'X-Plex-Token': userToken },
      signal: AbortSignal.timeout(10000),
    });
    if (!resourcesRes.ok) throw new Error(`Resources fetch failed: ${resourcesRes.status}`);
    const resources = await resourcesRes.json();

    const serverResource = resources.find(r => r.clientIdentifier === PLEX_SERVER_ID);
    if (!serverResource) {
      logger.warn(`Plex login denied: user ${userData.id} (${userData.username}) has no access to this server`);
      return res.json({ status: 'no_access' });
    }

    // Pick the best URL for this user to reach the Plex server with their own token.
    const serverToken = serverResource.accessToken || userToken;
    const rawName = userData.username || userData.friendlyName || 'Plex User';
    const username = rawName.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
                            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const thumb = userData.thumb || null;

    // Persist username and token so admin panel and background syncs can use them
    db.upsertKnownUser(String(userData.id), username, thumb, userToken);

    const plexId = String(userData.id);

    // Link mode: a signed-in (unlinked) Jellyfin user completing the Plex PIN
    // flow connects the two accounts. The Plex row becomes canonical and the
    // Jellyfin account's data merges into it.
    if (req.session.plexLinkMode && req.session.plexUser?.provider === 'jellyfin'
        && String(req.session.plexUser.id).startsWith('jf_')) {
      const jfDiskovarrId = String(req.session.plexUser.id);
      db.linkJellyfinAccount(jfDiskovarrId, plexId);
      logger.info(`Linked Jellyfin account ${jfDiskovarrId} to Plex user ${plexId}`);
    }
    delete req.session.plexLinkMode;

    // Attach a linked Jellyfin identity (if any) so source-specific features work
    const jfRow = db.getLinkedJellyfinRow(plexId);
    req.session.plexUser = {
      ...buildSessionUser({
        canonicalId: plexId,
        username,
        thumb,
        plexToken: userToken,
        plexServerToken: serverToken,
        provider: 'plex',
        jellyfin: jfRow ? { userId: jfRow.user_id.replace(/^jf_/, ''), token: jfRow.jellyfin_token } : null,
      }),
      uuid: userData.uuid,
    };
    req.session.activeSource = pickActiveSource('plex', plexId);

    // Set Plex admin flag if user has is_admin set in DB
    req.session.isPlexAdminUser = db.isAdminUser(plexId);

    delete req.session.plexPinId;
    delete req.session.plexPinCode;

    logger.info(`Plex login success: user=${userData.id} username="${username}" ip=${req.ip}`);
    const userPrefs = db.getUserPreferences(String(userData.id));
    const landingPage = userPrefs.landing_page || db.getLandingPage();
    const landingUrl = (landingPage === 'explore') ? '/explore?welcome=1' : '/?welcome=1';
    return res.json({ status: 'authorized', landingUrl });
  } catch (err) {
    logger.error(`Plex auth error: ${err.message}`);
    return res.json({ status: 'error', message: err.message });
  }
});

// GET /auth/providers — which login methods the login page should offer
router.get('/providers', (req, res) => {
  res.json({
    plex: isPlexConfigured(),
    jellyfin: jellyfinService.isEnabled(),
  });
});

// POST /auth/jellyfin/login — username/password against the configured Jellyfin
// server (Jellyfin has no central account service or OAuth). The Diskovarr
// identity is 'jf_<guid>', unless the account is linked to a Plex user — then
// the Plex identity is canonical and gets loaded instead.
router.post('/jellyfin/login', jellyfinLoginLimiter, async (req, res) => {
  if (!jellyfinService.isEnabled()) {
    return res.status(400).json({ status: 'error', message: 'Jellyfin login is not enabled' });
  }
  const { username, password } = req.body || {};
  if (!username) return res.status(400).json({ status: 'error', message: 'Username required' });
  try {
    const auth = await jellyfinService.authenticateByName(username, password);
    if (!auth) {
      logger.warn(`Jellyfin login failed for username="${username}" ip=${req.ip}`);
      return res.status(401).json({ status: 'invalid', message: 'Invalid username or password' });
    }
    const jfDiskovarrId = `jf_${auth.userId}`;
    const avatar = jellyfinService.getAvatarPath(auth.userId, auth.primaryImageTag);
    db.upsertJellyfinUser(jfDiskovarrId, auth.name, avatar, auth.accessToken);

    const canonicalId = db.resolveCanonicalUserId(jfDiskovarrId);
    if (canonicalId !== jfDiskovarrId) {
      // Linked → sign in as the canonical Plex identity with Jellyfin attached
      const plexRow = db.getKnownUserById(canonicalId);
      req.session.plexUser = buildSessionUser({
        canonicalId,
        username: plexRow?.username || auth.name,
        thumb: plexRow?.thumb || avatar,
        plexToken: plexRow?.plex_token || null,
        provider: 'jellyfin',
        jellyfin: { userId: auth.userId, token: auth.accessToken },
      });
    } else {
      req.session.plexUser = buildSessionUser({
        canonicalId: jfDiskovarrId,
        username: auth.name,
        thumb: avatar,
        provider: 'jellyfin',
        jellyfin: { userId: auth.userId, token: auth.accessToken },
      });
    }
    req.session.activeSource = pickActiveSource('jellyfin', canonicalId);
    req.session.isPlexAdminUser = db.isAdminUser(canonicalId);

    logger.info(`Jellyfin login success: user=${jfDiskovarrId} username="${auth.name}" ip=${req.ip}`);
    const userPrefs = db.getUserPreferences(canonicalId);
    const landingPage = userPrefs.landing_page || db.getLandingPage();
    const landingUrl = (landingPage === 'explore') ? '/explore?welcome=1' : '/?welcome=1';
    return res.json({ status: 'authorized', landingUrl });
  } catch (err) {
    logger.error(`Jellyfin auth error: ${err.message}`);
    return res.status(502).json({ status: 'error', message: 'Could not reach Jellyfin' });
  }
});

// GET /auth/check-auth — checks if user is logged in (for React SPA)
router.get('/check-auth', (req, res) => {
  if (req.session?.plexUser) {
    const userId = String(req.session.plexUser.id);
    const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser);
    const isElevated = !isAdmin && db.getPrivilegedUserIds().includes(userId);
    // Wrapped appears once any year has unlocked (Dec 1) and history exists;
    // admins always get it so they can preview the in-progress year.
    const wrappedStats = require('../services/wrappedStats');
    const wrappedYears = wrappedStats.getAvailableYears(isAdmin || isElevated);
    const sources = availableSources();
    const isJellyfinIdentity = userId.startsWith('jf_');
    return res.json({
      authenticated: true,
      // The Jellyfin token stays server-side; expose only that a link exists.
      user: {
        ...req.session.plexUser,
        jellyfin: undefined,
        hasJellyfin: !!req.session.plexUser.jellyfin,
        isPlexLinked: !isJellyfinIdentity,
        isAdmin,
        isElevated,
      },
      discoverAvailable: db.isDiscoverEnabled() && db.hasTmdbKey(),
      wrappedAvailable: wrappedYears.years.length > 0 || wrappedYears.previewYear != null,
      activeSource: req.session.activeSource === 'jellyfin' ? 'jellyfin' : 'plex',
      availableSources: sources,
    });
  }
  res.json({ authenticated: false });
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  const user = req.session.plexUser;
  if (user) logger.info(`Plex logout: user=${user.id} username="${user.username}"`);
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
