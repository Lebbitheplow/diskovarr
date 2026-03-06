const express = require('express');
const router = express.Router();
const db = require('../db/database');

const PLEX_CLIENT_ID = 'diskovarr-app';
const PLEX_SERVER_ID = process.env.PLEX_SERVER_ID;

const PLEX_TV_HEADERS = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
  'X-Plex-Product': 'Diskovarr',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Web',
};

// GET /auth/plex — initiate OAuth
router.get('/plex', async (req, res) => {
  try {
    const pinRes = await fetch('https://plex.tv/api/v2/pins', {
      method: 'POST',
      headers: {
        ...PLEX_TV_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'strong=true',
      signal: AbortSignal.timeout(10000),
    });

    if (!pinRes.ok) throw new Error(`Plex pin request failed: ${pinRes.status}`);
    const pinData = await pinRes.json();

    req.session.plexPinId = pinData.id;
    req.session.plexPinCode = pinData.code;

    const forwardUrl = `${req.protocol}://${req.get('host')}/auth/callback`;
    const authUrl = `https://app.plex.tv/auth#?clientID=${PLEX_CLIENT_ID}&code=${pinData.code}&forwardUrl=${encodeURIComponent(forwardUrl)}&context%5Bdevice%5D%5Bproduct%5D=Diskovarr`;

    res.redirect(authUrl);
  } catch (err) {
    console.error('Auth plex error:', err);
    res.redirect('/login?error=plex_unreachable');
  }
});

// GET /auth/callback — render polling page
router.get('/callback', (req, res) => {
  res.render('poll', { layout: 'layout' });
});

// GET /auth/check-pin — polled by client JS
router.get('/check-pin', async (req, res) => {
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
    const resourcesRes = await fetch('https://plex.tv/api/v2/resources', {
      headers: { ...PLEX_TV_HEADERS, 'X-Plex-Token': userToken },
      signal: AbortSignal.timeout(10000),
    });
    if (!resourcesRes.ok) throw new Error(`Resources fetch failed: ${resourcesRes.status}`);
    const resources = await resourcesRes.json();

    const hasAccess = resources.some(r => r.clientIdentifier === PLEX_SERVER_ID);
    if (!hasAccess) {
      return res.json({ status: 'no_access' });
    }

    const username = userData.username || userData.friendlyName || 'Plex User';
    const thumb = userData.thumb || null;

    // Persist username so admin panel can show names instead of IDs
    db.upsertKnownUser(String(userData.id), username, thumb);

    // Store in session — token stays server-side only
    req.session.plexUser = {
      id: String(userData.id),
      uuid: userData.uuid,
      username,
      thumb,
      token: userToken, // user's personal token, never sent to browser
    };

    delete req.session.plexPinId;
    delete req.session.plexPinCode;

    return res.json({ status: 'authorized' });
  } catch (err) {
    console.error('check-pin error:', err);
    return res.json({ status: 'error', message: err.message });
  }
});

// GET /auth/logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
