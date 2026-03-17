const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/database');
const plexService = require('../services/plex');
const APP_VERSION = require('../package.json').version;

const CHANGELOG = (() => { try { return require('../CHANGELOG.json'); } catch { return []; } })();

function pageLocals(req) {
  const isQueueAdmin = !!(req && (req.session?.isAdmin || req.session?.isPlexAdminUser));
  return {
    discoverEnabled: db.isDiscoverEnabled(),
    themeParam: themeParam(),
    appVersion: APP_VERSION,
    isQueueAdmin,
    changelog: CHANGELOG,
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

// PWA manifest (dynamic — uses current theme color)
router.get('/manifest.json', (req, res) => {
  const color = db.getThemeColor();
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.json({
    name: 'Diskovarr',
    short_name: 'Diskovarr',
    description: 'Personalized Plex recommendations based on your watch history.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f0f0f',
    theme_color: color,
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  });
});

// PWA app icon (dynamic — uses current theme color)
router.get('/icons/icon.svg', (req, res) => {
  const c = db.getThemeColor();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="18" fill="#0f0f0f"/>
  <g transform="translate(20,20) scale(2.5)" fill="none">
    <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="${c}"/>
    <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="${c}"/>
    <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="${c}"/>
    <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="${c}"/>
    <circle cx="15" cy="9" r="5" stroke="${c}" stroke-width="2"/>
    <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(svg);
});

// Maskable variant — full bleed background for OS icon cropping
router.get('/icons/icon-maskable.svg', (req, res) => {
  const c = db.getThemeColor();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#0f0f0f"/>
  <g transform="translate(22,22) scale(2.33)" fill="none">
    <rect x="0.5" y="17.5" width="13" height="1.5" rx="0.5" fill="${c}"/>
    <rect x="1" y="8.5" width="2.5" height="9" rx="0.4" fill="${c}"/>
    <rect x="4.5" y="11" width="3" height="6.5" rx="0.4" fill="${c}"/>
    <rect x="8.5" y="10" width="2.5" height="7.5" rx="0.4" fill="${c}"/>
    <circle cx="15" cy="9" r="5" stroke="${c}" stroke-width="2"/>
    <line x1="18.5" y1="12.5" x2="22" y2="16" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(svg);
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
  res.render('home', { ...pageLocals(req), userId, username, thumb, currentPath: '/' });
});

// Diskovarr View (library browse) — requires auth
router.get('/discover', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('discover', { ...pageLocals(req), userId, username, thumb, currentPath: '/discover' });
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
  const ownerUserId = db.getOwnerUserId();
  res.render('explore', {
    ...pageLocals(req), userId, username, thumb, currentPath: '/explore',
    services, hasAnyService,
    individualSeasonsEnabled: db.isIndividualSeasonsEnabled(),
    directRequestAccess: db.getDirectRequestAccess(),
    isOwner: userId === ownerUserId,
  });
});

// Search results page — requires auth
router.get('/search', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  const connections = db.getConnectionSettings();
  const services = {
    overseerr: connections.overseerrEnabled && !!connections.overseerrUrl,
    radarr: connections.radarrEnabled && !!connections.radarrUrl,
    sonarr: connections.sonarrEnabled && !!connections.sonarrUrl,
  };
  const hasAnyService = services.overseerr || services.radarr || services.sonarr;
  const query = (req.query.q || '').trim();
  res.render('search', {
    ...pageLocals(req), userId, username, thumb, currentPath: '/search',
    query, services, hasAnyService,
    individualSeasonsEnabled: db.isIndividualSeasonsEnabled(),
    directRequestAccess: db.getDirectRequestAccess(),
    isOwner: userId === db.getOwnerUserId(),
  });
});

// Watchlist page — requires auth
router.get('/watchlist', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  const keys = db.getWatchlistFromDb(userId);
  const items = keys
    .map(key => db.getLibraryItemByKey(key))
    .filter(Boolean)
    .map(item => ({ ...item, deepLink: plexService.getDeepLink(item.ratingKey), isInWatchlist: true }));
  res.render('watchlist', { ...pageLocals(req), userId, username, thumb, currentPath: '/watchlist', items });
});

// Queue page — requires auth (all users can view their own requests)
router.get('/queue', requireAuth, (req, res) => {
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser);
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('queue', {
    ...pageLocals(req), userId, username, thumb, currentPath: '/queue',
    isAdmin,
    isPlexAdminUser: !!req.session.isPlexAdminUser,
    connections: db.getConnectionSettings(),
  });
});

// Issues page — all users see their own; admin/elevated see all
router.get('/issues', requireAuth, (req, res) => {
  const isAdmin = !!(req.session.isAdmin || req.session.isPlexAdminUser)
    || db.getPrivilegedUserIds().includes(String(req.session.plexUser.id));
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('issues', { ...pageLocals(req), userId, username, thumb, currentPath: '/issues', isAdmin });
});

// User settings page
router.get('/settings', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  const prefs = db.getUserPreferences(userId);
  res.render('settings', {
    ...pageLocals(req), userId, username, thumb, currentPath: '/settings', prefs,
    notificationPrefs: db.getUserNotificationPrefs(userId),
    discordAgentEnabled: (() => { try { const c = JSON.parse(db.getSetting('discord_agent', 'null')); return c?.enabled === true; } catch { return false; } })(),
    discordMode: (() => { try { return JSON.parse(db.getSetting('discord_agent', 'null'))?.mode || 'webhook'; } catch { return 'webhook'; } })(),
    discordInviteLink: (() => { try { return JSON.parse(db.getSetting('discord_agent', 'null'))?.inviteLink || null; } catch { return null; } })(),
    pushoverAgentEnabled: (() => { try { return JSON.parse(db.getSetting('pushover_agent', 'null'))?.enabled === true; } catch { return false; } })(),
    isElevated: db.getPrivilegedUserIds().includes(userId),
  });
});

module.exports = router;
