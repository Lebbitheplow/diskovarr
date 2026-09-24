'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { rivenFetch, getRivenUrl, getRivenApiKey, getRdApiKey } = require('../services/rivenClient');

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /admin/riven/config — return current config (keys masked)
router.get('/config', (req, res) => {
  // Auto-create DUMB app row (and ensure it's enabled) whenever Riven is enabled
  let dumbApp = db.listApiApps().find(a => a.type === 'dumb') || null;
  if (!dumbApp) {
    dumbApp = db.createApiApp('DUMB', 'dumb');
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ?, enabled = 1 WHERE id = ?').run(key68, dumbApp.id);
    dumbApp = db.getApiApp(dumbApp.id);
  } else if (!dumbApp.enabled) {
    db.updateApiApp(dumbApp.id, { enabled: true });
    dumbApp = db.getApiApp(dumbApp.id);
  } else if (dumbApp.api_key && dumbApp.api_key.length !== 68) {
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(key68, dumbApp.id);
    dumbApp = db.getApiApp(dumbApp.id);
  }
  res.json({
    url: getRivenUrl(),
    apiKey: getRivenApiKey() ? '••••••••' : '',
    rdApiKey: getRdApiKey() ? '••••••••' : '',
    hasApiKey: !!getRivenApiKey(),
    hasRdKey: !!getRdApiKey(),
    enabled: ['1', 'true'].includes(db.getSetting('riven_enabled', '0')),
    dumbRequestMode: db.getSetting('dumb_request_mode', 'pull'),
    dumbHasApiKey: !!(dumbApp?.api_key),
  });
});

// POST /admin/riven/config/save
router.post('/config/save', (req, res) => {
  const { url, apiKey, rdApiKey, enabled, dumbRequestMode } = req.body || {};
  if (url !== undefined) db.setSetting('riven_url', url.trim());
  if (apiKey && apiKey !== '••••••••') db.setSetting('riven_api_key', apiKey.trim());
  if (rdApiKey && rdApiKey !== '••••••••') db.setSetting('riven_rd_api_key', rdApiKey.trim());
  if (enabled !== undefined) db.setSetting('riven_enabled', enabled ? '1' : '0');
  if (dumbRequestMode !== undefined) db.setSetting('dumb_request_mode', dumbRequestMode);
  res.json({ ok: true });
});

// Riven validates Overseerr API keys with an exact length check of 68 characters.
// Use 34 random bytes (68 hex chars) for all DUMB keys.
function generateDumbKey() {
  const { randomBytes } = require('crypto');
  return randomBytes(34).toString('hex');
}

// GET /admin/riven/dumb/config — get DUMB app state (auto-creates app row)
router.get('/dumb/config', (req, res) => {
  let app = db.listApiApps().find(a => a.type === 'dumb') || null;
  if (!app) {
    app = db.createApiApp('DUMB', 'dumb');
    // Override the default 64-char key with a 68-char key Riven will accept
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ?, enabled = 0 WHERE id = ?').run(key68, app.id);
    app = db.getApiApp(app.id);
  } else if (app.api_key && app.api_key.length !== 68) {
    // Fix any existing key that's the wrong length
    const key68 = generateDumbKey();
    db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(key68, app.id);
    app = db.getApiApp(app.id);
  }
  res.json({ hasApiKey: !!app.api_key, enabled: !!app.enabled });
});

// POST /admin/riven/dumb/enable — toggle DUMB integration on/off
router.post('/dumb/enable', (req, res) => {
  const { enabled } = req.body || {};
  let app = db.listApiApps().find(a => a.type === 'dumb');
  if (!app) app = db.createApiApp('DUMB', 'dumb');
  db.updateApiApp(app.id, { enabled: !!enabled });
  db.setSetting('dumb_enabled', enabled ? '1' : '0');
  res.json({ ok: true, enabled: !!enabled });
});

// POST /admin/riven/dumb/regenerate-key — create or regenerate DUMB API key (68 chars)
router.post('/dumb/regenerate-key', (req, res) => {
  const newKey = generateDumbKey();
  let app = db.listApiApps().find(a => a.type === 'dumb');
  if (!app) {
    app = db.createApiApp('DUMB', 'dumb');
    db.updateApiApp(app.id, { enabled: true });
  }
  db.prepare('UPDATE api_apps SET api_key = ? WHERE id = ?').run(newKey, app.id);
  res.json({ ok: true, apiKey: newKey });
});

// POST /admin/riven/config/test
router.post('/config/test', async (req, res) => {
  try {
    await rivenFetch('GET', '/items', { query: { limit: 1 } });
    res.json({ ok: true, message: 'Connected to Riven successfully' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
