const express = require('express');
const router = express.Router();
const db = require('../db/database');
const logger = require('../services/logger');
const watchParty = require('../services/watchParty');

// Watch Together — mounted at /api/watch-party behind requireAuth.

router.use((req, res, next) => {
  // API-key callers have no user identity to invite or sync.
  if (!req.session.plexUser?.id) return res.status(401).json({ error: 'Not authenticated' });
  watchParty.rememberCreds(req.session.plexUser);
  next();
});

const actor = (req) => String(req.session.plexUser.id);

// Resolves the party from :id and enforces membership. Sends the error response
// and returns null when the caller may not proceed.
function requireMember(req, res, { hostOnly = false } = {}) {
  const party = db.getWatchParty(req.params.id);
  if (!party) { res.status(404).json({ error: 'Party not found' }); return null; }
  const userId = actor(req);
  if (!db.getWatchPartyMember(party.id, userId)) {
    res.status(403).json({ error: 'You are not invited to this party' });
    return null;
  }
  if (hostOnly && party.host_id !== userId) { res.status(403).json({ error: 'Host only' }); return null; }
  return { party, userId };
}

// Wraps a handler so PartyError messages reach the user and anything else is
// logged and reported generically.
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof watchParty.PartyError) return res.status(err.status).json({ error: err.message });
    logger.error(`watch-party ${req.method} ${req.path} error:`, err.message);
    res.status(500).json({ error: 'Something went wrong with the watch party.' });
  }
};

const respond = (res, partyId, userId) => res.json({ party: watchParty.snapshot(db.getWatchParty(partyId), userId) });

// GET /api/watch-party — parties the caller is in that have not ended
router.get('/', (req, res) => {
  const userId = actor(req);
  res.json({ parties: db.getOpenWatchPartiesForUser(userId).map(p => watchParty.snapshot(p, userId)) });
});

// POST /api/watch-party — body: { ratingKey, userIds }
router.post('/', handle(async (req, res) => {
  const { ratingKey, userIds } = req.body || {};
  if (!ratingKey) return res.status(400).json({ error: 'ratingKey required' });
  if (userIds != null && !Array.isArray(userIds)) return res.status(400).json({ error: 'userIds must be an array' });
  const party = await watchParty.createParty({ hostId: actor(req), ratingKey, userIds: userIds || [] });
  res.status(201).json({ party: watchParty.snapshot(party, actor(req)) });
}));

// GET /api/watch-party/:id
router.get('/:id', (req, res) => {
  const ctx = requireMember(req, res);
  if (ctx) respond(res, ctx.party.id, ctx.userId);
});

// POST /api/watch-party/:id/invite — body: { userIds }
router.post('/:id/invite', handle(async (req, res) => {
  const ctx = requireMember(req, res, { hostOnly: true });
  if (!ctx) return;
  if (!Array.isArray(req.body?.userIds)) return res.status(400).json({ error: 'userIds must be an array' });
  if (ctx.party.status === 'ended') return res.status(400).json({ error: 'This party has ended.' });
  watchParty.invite(ctx.party, req.body.userIds);
  respond(res, ctx.party.id, ctx.userId);
}));

// POST /api/watch-party/:id/device — body: { clientId }
router.post('/:id/device', handle(async (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  const clientId = req.body?.clientId;
  if (!clientId || typeof clientId !== 'string') return res.status(400).json({ error: 'clientId required' });
  await watchParty.setDevice(ctx.party, ctx.userId, clientId);
  respond(res, ctx.party.id, ctx.userId);
}));

// POST /api/watch-party/:id/decline
router.post('/:id/decline', handle(async (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  if (ctx.party.host_id === ctx.userId) return res.status(400).json({ error: 'The host ends the party instead.' });
  db.setWatchPartyMemberStatus(ctx.party.id, ctx.userId, 'declined');
  res.json({ ok: true });
}));

// POST /api/watch-party/:id/start
router.post('/:id/start', handle(async (req, res) => {
  const ctx = requireMember(req, res, { hostOnly: true });
  if (!ctx) return;
  await watchParty.startParty(ctx.party);
  respond(res, ctx.party.id, ctx.userId);
}));

// POST /api/watch-party/:id/join — jump into a party that is already playing
router.post('/:id/join', handle(async (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  await watchParty.joinPlaying(ctx.party, ctx.userId);
  respond(res, ctx.party.id, ctx.userId);
}));

// POST /api/watch-party/:id/control — body: { action: 'pause' | 'play' }
router.post('/:id/control', handle(async (req, res) => {
  const ctx = requireMember(req, res);
  if (!ctx) return;
  if (!['pause', 'play'].includes(req.body?.action)) return res.status(400).json({ error: 'action must be pause or play' });
  watchParty.control(ctx.party, ctx.userId, req.body.action);
  respond(res, ctx.party.id, ctx.userId);
}));

// POST /api/watch-party/:id/end
router.post('/:id/end', handle(async (req, res) => {
  const ctx = requireMember(req, res, { hostOnly: true });
  if (!ctx) return;
  watchParty.endParty(ctx.party.id);
  respond(res, ctx.party.id, ctx.userId);
}));

module.exports = router;
