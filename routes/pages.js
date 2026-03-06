const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/database');

function pageLocals() {
  return {
    discoverEnabled: db.isDiscoverEnabled(),
    themeParam: themeParam(),
  };
}

// Dynamic theme CSS — overrides all accent CSS variables with the current color
router.get('/theme.css', (req, res) => {
  const color = db.getThemeColor();
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  // Compute a slightly lighter hover color (~15% brighter)
  const rh = Math.min(255, Math.round(r + (255 - r) * 0.15));
  const gh = Math.min(255, Math.round(g + (255 - g) * 0.15));
  const bh = Math.min(255, Math.round(b + (255 - b) * 0.15));
  const hover = `#${rh.toString(16).padStart(2,'0')}${gh.toString(16).padStart(2,'0')}${bh.toString(16).padStart(2,'0')}`;

  const css = `:root {
  --accent: ${color};
  --accent-dim: rgba(${r}, ${g}, ${b}, 0.15);
  --accent-dim2: rgba(${r}, ${g}, ${b}, 0.20);
  --accent-glow: rgba(${r}, ${g}, ${b}, 0.08);
  --accent-border: rgba(${r}, ${g}, ${b}, 0.4);
  --accent-shadow: rgba(${r}, ${g}, ${b}, 0.4);
  --accent-hover: ${hover};
}\n`;
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(css);
});

// Login page
router.get('/login', (req, res) => {
  if (req.session && req.session.plexUser) {
    return res.redirect('/');
  }
  const error = req.query.error || null;
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  res.render('login', { error, appUrl });
});

function themeParam() {
  // Use color as cache-busting query param — changing color = new URL = fresh CSS
  return encodeURIComponent(db.getThemeColor());
}

// Home page — requires auth
router.get('/', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('home', { ...pageLocals(), userId, username, thumb, currentPath: '/' });
});

// Diskovarr View (library browse) — requires auth
router.get('/discover', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('discover', { ...pageLocals(), userId, username, thumb, currentPath: '/discover' });
});

// Recommended Requests (external content) — requires auth + discover enabled
router.get('/explore', requireAuth, (req, res) => {
  if (!db.isDiscoverEnabled()) return res.redirect('/');
  const { id: userId, username, thumb } = req.session.plexUser;
  const connections = db.getConnectionSettings();
  const services = {
    overseerr: connections.overseerrEnabled && !!connections.overseerrUrl,
    radarr: connections.radarrEnabled && !!connections.radarrUrl,
    sonarr: connections.sonarrEnabled && !!connections.sonarrUrl,
  };
  const hasAnyService = services.overseerr || services.radarr || services.sonarr;
  res.render('explore', {
    ...pageLocals(), userId, username, thumb, currentPath: '/explore',
    services, hasAnyService,
  });
});

// Watchlist page — requires auth
router.get('/watchlist', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  const plexService = require('../services/plex');
  const keys = db.getWatchlistFromDb(userId);
  const items = keys
    .map(key => db.getLibraryItemByKey(key))
    .filter(Boolean)
    .map(item => ({ ...item, deepLink: plexService.getDeepLink(item.ratingKey), isInWatchlist: true }));
  res.render('watchlist', { ...pageLocals(), userId, username, thumb, currentPath: '/watchlist', items });
});

module.exports = router;
