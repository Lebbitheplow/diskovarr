const express = require('express');
const router = express.Router();
const db = require('../db/database');
const plexService = require('../services/plex');
const recommender = require('../services/recommender');

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// ── Sync state (in-process — survives as long as server runs) ─────────────────

let autoSyncEnabled = true;
let syncInProgress = false;
let lastSyncError = null;

function getAutoSyncEnabled() { return autoSyncEnabled; }

// Called by server.js before each scheduled sync
function shouldAutoSync() { return autoSyncEnabled && !syncInProgress; }

module.exports.shouldAutoSync = shouldAutoSync;

// ── Login ─────────────────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.render('admin/login', { error: 'ADMIN_PASSWORD not set in .env' });
  }

  // Timing-safe string comparison to prevent timing attacks
  const a = Buffer.from(password || '');
  const b = Buffer.from(adminPassword);
  const match = a.length === b.length &&
    require('crypto').timingSafeEqual(a, b);

  if (!match) {
    return res.render('admin/login', { error: 'Incorrect password' });
  }

  req.session.isAdmin = true;
  res.redirect('/admin');
});

router.post('/logout', requireAdmin, (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin/login');
});

// ── Main admin page ───────────────────────────────────────────────────────────

router.get('/', requireAdmin, (req, res) => {
  const stats = db.getAdminStats();
  res.render('admin/index', {
    stats,
    autoSyncEnabled,
    syncInProgress,
    lastSyncError,
    themeParam: encodeURIComponent(db.getThemeColor()),
  });
});

// ── API: Status (polled by admin UI) ─────────────────────────────────────────

router.get('/status', requireAdmin, (req, res) => {
  const stats = db.getAdminStats();
  res.json({ stats, autoSyncEnabled, syncInProgress, lastSyncError });
});

// ── Library sync controls ─────────────────────────────────────────────────────

router.post('/sync/library', requireAdmin, async (req, res) => {
  if (syncInProgress) {
    return res.json({ success: false, message: 'Sync already in progress' });
  }
  syncInProgress = true;
  lastSyncError = null;

  // Run in background — respond immediately
  res.json({ success: true, message: 'Library sync started' });

  try {
    plexService.invalidateCache();
    await plexService.warmCache();
    recommender.invalidateAllCaches();
    console.log('[Admin] Manual library sync completed');
  } catch (err) {
    lastSyncError = err.message;
    console.error('[Admin] Library sync error:', err.message);
  } finally {
    syncInProgress = false;
  }
});

router.post('/sync/auto/enable', requireAdmin, (req, res) => {
  autoSyncEnabled = true;
  res.json({ success: true, autoSyncEnabled });
});

router.post('/sync/auto/disable', requireAdmin, (req, res) => {
  autoSyncEnabled = false;
  res.json({ success: true, autoSyncEnabled });
});

// ── Per-user watched sync ─────────────────────────────────────────────────────

router.post('/sync/watched/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  // Find the user's token from active sessions
  const sessDb = require('better-sqlite3')(require('path').join(__dirname, '..', 'data', 'sessions.db'));
  const rows = sessDb.prepare('SELECT sess FROM sessions').all();
  sessDb.close();

  let userToken = null;
  for (const row of rows) {
    try {
      const s = JSON.parse(row.sess);
      if (s.plexUser && s.plexUser.id === userId) {
        userToken = s.plexUser.token;
        break;
      }
    } catch {}
  }

  if (!userToken) {
    return res.json({ success: false, message: 'User not found in active sessions. They need to be signed in.' });
  }

  res.json({ success: true, message: 'Watched sync started for user ' + userId });

  try {
    await plexService.syncUserWatched(userId, userToken);
    recommender.invalidateUserCache(userId);
    console.log(`[Admin] Watched sync completed for user ${userId}`);
  } catch (err) {
    console.error(`[Admin] Watched sync error for ${userId}:`, err.message);
  }
});

// ── Theme color ───────────────────────────────────────────────────────────────

router.post('/theme/color', requireAdmin, (req, res) => {
  const { color } = req.body;
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    return res.status(400).json({ error: 'Invalid color — must be a 6-digit hex value' });
  }
  db.setThemeColor(color);
  res.json({ success: true, color });
});

router.get('/theme/color', (req, res) => {
  res.json({ color: db.getThemeColor() });
});

// ── Cache operations ──────────────────────────────────────────────────────────

router.post('/cache/clear/recommendations', requireAdmin, (req, res) => {
  recommender.invalidateAllCaches();
  res.json({ success: true, message: 'Recommendation caches cleared for all users' });
});

router.post('/cache/clear/watched/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  db.clearUserWatched(userId);
  recommender.invalidateUserCache(userId);
  res.json({ success: true, message: `Watched cache cleared for user ${userId}` });
});

router.post('/cache/clear/watched', requireAdmin, (req, res) => {
  db.clearAllUserWatched();
  recommender.invalidateAllCaches();
  res.json({ success: true, message: 'All watched caches cleared' });
});

router.post('/cache/clear/dismissals/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  db.clearUserDismissals(userId);
  recommender.invalidateUserCache(userId);
  res.json({ success: true, message: `Dismissals cleared for user ${userId}` });
});

router.post('/cache/clear/dismissals', requireAdmin, (req, res) => {
  db.clearUserDismissals(null);
  recommender.invalidateAllCaches();
  res.json({ success: true, message: 'All dismissals cleared' });
});

module.exports = router;
module.exports.shouldAutoSync = shouldAutoSync;
