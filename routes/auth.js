const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../db/database');
const logger = require('../services/logger');

const checkPinLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests' },
});

const PLEX_CLIENT_ID = 'diskovarr-app';
const PLEX_SERVER_ID = process.env.PLEX_SERVER_ID;

const PLEX_TV_HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
  'X-Plex-Product': 'Diskovarr',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Web',
};

// GET /auth/callback — Plex redirects here after auth; pinId/pinCode passed as query params
router.get('/callback', (req, res) => {
  const { pinId, pinCode } = req.query;
  if (pinId && pinCode) {
    req.session.plexPinId = pinId;
    req.session.plexPinCode = pinCode;
  }
  res.render('poll', { layout: 'layout' });
});

// GET /auth/check-pin — polled by client JS
router.get('/check-pin', checkPinLimiter, async (req, res) => {
  const pinId = req.session.plexPinId;
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
    // Plex Friends' tokens are rejected on the local LAN URL — prefer the relay or
    // external connection which goes through plex.tv and always authenticates correctly.
    // serverToken: the resource-specific access token Plex issues for this server.
    // This is what Plex apps actually use for server API calls (not the main OAuth token).
    // Without it, Friend tokens are rejected by the server for write operations like playlists.
    const serverToken = serverResource.accessToken || userToken;
    const rawName = userData.username || userData.friendlyName || 'Plex User';
    const username = rawName.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c))
                            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const thumb = userData.thumb || null;

    // Persist username so admin panel can show names instead of IDs
    db.upsertKnownUser(String(userData.id), username, thumb);

    // Store in session — token stays server-side only
    req.session.plexUser = {
      id: String(userData.id),
      uuid: userData.uuid,
      username,
      thumb,
      token: userToken,       // plex.tv OAuth token — used for plex.tv API calls & watch sync
      serverToken,            // server-specific access token — used for playlist operations
    };

    delete req.session.plexPinId;
    delete req.session.plexPinCode;

    logger.info(`Plex login success: user=${userData.id} username="${username}" ip=${req.ip}`);
    const landingPage = db.getLandingPage();
    const landingUrl = (landingPage === 'explore') ? '/explore?welcome=1' : '/?welcome=1';
    return res.json({ status: 'authorized', landingUrl });
  } catch (err) {
    logger.error(`Plex auth error: ${err.message}`);
    return res.json({ status: 'error', message: err.message });
  }
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
