'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const db = require('../db/database');
const logger = require('../services/logger');

// ── Config helpers ────────────────────────────────────────────────────────────

const RIVEN_SETTINGS_PATH = process.env.RIVEN_SETTINGS_PATH || '/opt/riven/settings.json';

function getRivenConfig() {
  return {
    url: db.getSetting('riven_url', 'http://127.0.0.1:8082'),
    apiKey: db.getSetting('riven_api_key', ''),
    rdApiKey: db.getSetting('riven_rd_api_key', ''),
  };
}

// Auto-read RD api key from Riven's settings.json as fallback
function getRdApiKey() {
  const stored = db.getSetting('riven_rd_api_key', '');
  if (stored) return stored;
  try {
    const raw = fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    return settings?.downloaders?.real_debrid?.api_key || '';
  } catch {
    return '';
  }
}

// Auto-read Riven API key from settings.json as fallback
function getRivenApiKey() {
  const stored = db.getSetting('riven_api_key', '');
  if (stored) return stored;
  try {
    const raw = fs.readFileSync(RIVEN_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    return settings?.api_key || '';
  } catch {
    return '';
  }
}

function getRivenUrl() {
  return db.getSetting('riven_url', '') || 'http://127.0.0.1:8082';
}

// ── Riven API proxy helpers ───────────────────────────────────────────────────

async function rivenFetch(method, pathname, { body, query } = {}) {
  const apiKey = getRivenApiKey();
  if (!apiKey) throw new Error('Riven API key not configured');
  const base = getRivenUrl().replace(/\/$/, '');
  let url = `${base}/api/v1${pathname}`;
  if (query) {
    const params = new URLSearchParams(query);
    url += '?' + params.toString();
  }
  const opts = {
    method,
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      const raw = body.detail || body.message || body.error || '';
      detail = Array.isArray(raw) ? raw.map(e => e.msg || JSON.stringify(e)).join('; ') : String(raw);
    } catch {}
    throw new Error(`Riven API ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

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
    enabled: db.getSetting('riven_enabled', '0') === '1',
    dumbRequestMode: db.getSetting('dumb_request_mode', 'pull'),
    dumbHasApiKey: !!(dumbApp?.api_key),
  });
});

// POST /admin/riven/config/save
router.post('/config/save', (req, res) => {
  const { url, apiKey, rdApiKey, enabled, dumbRequestMode } = req.body;
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
  const { enabled } = req.body;
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
    const data = await rivenFetch('GET', '/items', { query: { limit: 1 } });
    res.json({ ok: true, message: 'Connected to Riven successfully' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
