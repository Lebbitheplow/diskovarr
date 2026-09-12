'use strict';

// Admin → Setup: guided DUMB Traktless installation. Mounted at
// /admin/dumb-setup behind requireAdmin (see server.js).

const express = require('express');
const router = express.Router();
const dumb = require('../services/dumbClient');
const setup = require('../services/dumbSetup');
const installer = require('../services/dumbInstaller');
const plexLib = require('../services/plexLibrarySetup');

const fail = (res, err, code = 400) => res.status(err.status === 401 ? 401 : code).json({ error: err.message || String(err) });

// Everything the wizard needs to render its first screen.
router.get('/state', async (req, res) => {
  try { res.json(await setup.detect()); } catch (err) { fail(res, err, 500); }
});

// Save + test the DUMB connection (URL and, when DUMB has auth on, credentials).
router.post('/connection', async (req, res) => {
  const { url, username, password } = req.body || {};
  if (!url || !/^https?:\/\//.test(String(url))) return res.status(400).json({ error: 'DUMB URL must start with http:// or https://' });
  dumb.saveConfig({ url, username, password });
  try {
    const probe = await dumb.probe();
    res.json({ ok: probe.reachable && probe.loggedIn, probe });
  } catch (err) { fail(res, err); }
});

router.post('/debrid/validate', async (req, res) => {
  const { provider, apiKey } = req.body || {};
  try { res.json({ ok: true, ...(await setup.validateDebrid(provider, apiKey)) }); } catch (err) { fail(res, err); }
});

// DUMB's own view: providers, installable services and their live state.
router.get('/capabilities', async (req, res) => {
  try { res.json(await dumb.provisionCapabilities()); } catch (err) { fail(res, err, 502); }
});

router.get('/plex/libraries', async (req, res) => {
  try { res.json({ libraries: await plexLib.listLibraries() }); } catch (err) { fail(res, err); }
});

router.post('/plex/verify-path', async (req, res) => {
  const p = String(req.body?.path || '');
  if (!p.startsWith('/')) return res.status(400).json({ error: 'Path must be absolute' });
  try { res.json({ path: p, visible: await plexLib.pathVisibleToPlex(p) }); } catch (err) { fail(res, err); }
});

router.get('/plex/instructions', (req, res) => {
  const prefix = String(req.query.prefix || '').replace(/\/$/, '');
  const lib = String(req.query.libraryPath || '/mnt/debrid/library').replace(/\/$/, '');
  const map = (p) => (prefix ? p.replace(/^\/mnt\/debrid/, prefix) : p);
  res.json(plexLib.instructions({ movies: map(`${lib}/movies`), shows: map(`${lib}/shows`) }));
});

// Re-run only the Plex attachment with a corrected mapping.
router.post('/plex/apply', async (req, res) => {
  try { res.json(await setup.rerunPlex(req.body?.plex || req.body || {})); } catch (err) { fail(res, err); }
});

// Docker install of DUMB Traktless (or the compose file for a manual install).
router.get('/compose', (req, res) => {
  res.type('text/plain').send(installer.composeYaml({ image: req.query.image || undefined }));
});

router.post('/install', async (req, res) => {
  const { dir, image, overwrite } = req.body || {};
  try {
    const result = await installer.install({ dir, image, overwrite: !!overwrite });
    if (result.ok && !dumb.getConfig().url) dumb.saveConfig({ url: dumb.DEFAULT_URL });
    res.json(result);
  } catch (err) { fail(res, err); }
});

// Kick off the whole thing; poll /job for progress.
router.post('/apply', async (req, res) => {
  try { res.json(await setup.apply(req.body || {})); } catch (err) { fail(res, err, err.message?.includes('already running') ? 409 : 400); }
});

router.get('/job', (req, res) => res.json(setup.status() || null));

router.post('/reset', (req, res) => { setup.reset(); res.json({ ok: true }); });

module.exports = router;
