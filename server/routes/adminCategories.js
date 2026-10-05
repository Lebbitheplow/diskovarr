// Admin API for category packs (Kometa-style automatic collections). Mounted
// at /admin/automation/categories (server.js), ahead of the automation router.
const express = require('express');
const router = express.Router();
const categoryPacks = require('../services/categoryPacks');
const categoryPolicy = require('../services/categoryPolicy');
const plexCollections = require('../services/plexCollections');
const logger = require('../services/logger');

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Admin session required' });
}
router.use(requireAdmin);

function jellyfinEnabled() {
  try { return require('../services/jellyfin').isEnabled(); } catch { return false; }
}

router.param('pack', (req, res, next, pack) => {
  if (!categoryPolicy.PACK_IDS.includes(pack)) return res.status(404).json({ error: 'Unknown category pack' });
  next();
});

router.get('/', (req, res) => {
  res.json({
    packs: categoryPacks.describe(),
    visibilities: categoryPolicy.VISIBILITIES,
    plexConfigured: plexCollections.plexConfigured(),
    jellyfinEnabled: jellyfinEnabled(),
  });
});

// What enabling (or re-syncing) the pack would manage — read-only.
router.get('/:pack/preview', async (req, res) => {
  try {
    res.json({ collections: await categoryPacks.previewPack(req.params.pack) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Sync runs in the background (a pack can be 100+ Plex collections); the UI
// polls GET / for `syncing`.
function startSync(pack) {
  categoryPacks.syncPack(pack)
    .catch(e => logger.warn(`[categories] ${pack} sync failed: ${e.message}`));
}

// Body: { enabled?, visibility?, minItems?, limit?, deleteCollections? }
router.put('/:pack', async (req, res) => {
  const { pack } = req.params;
  const body = req.body || {};
  if (body.visibility !== undefined && !categoryPolicy.VISIBILITIES.includes(body.visibility)) {
    return res.status(400).json({ error: 'invalid visibility' });
  }
  const patch = {};
  for (const key of ['enabled', 'visibility', 'minItems', 'limit']) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  try {
    const config = await categoryPacks.updatePack(pack, patch, { deleteCollections: !!body.deleteCollections });
    if (config.enabled) startSync(pack);
    logger.info(`[categories] ${pack} pack ${config.enabled ? 'enabled' : 'disabled'} (visibility=${config.visibility}, min=${config.minItems})`);
    res.json({ ok: true, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:pack/sync', (req, res) => {
  const { pack } = req.params;
  if (!categoryPacks.getConfig()[pack].enabled) return res.status(400).json({ error: 'Pack is not enabled' });
  if (categoryPacks.isRunning(pack)) return res.status(409).json({ error: 'Sync already running' });
  startSync(pack);
  res.status(202).json({ ok: true, started: true });
});

module.exports = router;
