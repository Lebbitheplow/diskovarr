// Notification queue worker. Every 30s it claims due notification_queue rows,
// sends each through its provider with the row's recipient, and records the
// outcome: sent, skipped, retry (with backoff, bounded attempts) or failed.
// The delivery contract and audience rules live in notificationAgents/delivery.js.
const db = require('../db/database');
const logger = require('./logger');
const { manager } = require('./notificationAgents');
const { DeliveryStatus, classifyError, normalizeResult, skipped } = require('./notificationAgents/delivery');
const { notificationUrl, notificationPath } = require('./notificationAgents/links');

let _interval = null;
let _running = false;

function parseJson(text, fallback) {
  if (text && typeof text === 'object') return text;
  try { return JSON.parse(text) ?? fallback; } catch { return fallback; }
}

// Rows that share a bell notification, agent and recipient are one bundle and
// go out as ONE external message. Rows without a notification are sent alone.
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.notification_id ? `${row.notification_id}:${row.agent}:${row.user_id || ''}` : `row:${row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

const deliveredOf = (row) => parseJson(row.delivered, []) || [];

// Targets every row of the bundle already reached. A row that joined the bundle
// later still needs the rest, so those go out again with the bundle's message.
function deliveredTargets(rows) {
  const [first, ...rest] = rows.map(deliveredOf);
  return (first || []).filter(id => rest.every(list => list.includes(id)));
}

// The row carries its event's admin-feed copy and hasn't delivered it yet.
const owesFeed = (row) => row.feed !== 0 && !deliveredOf(row).includes('feed');

// The payload for one bundle: the bell notification's current title/body (they
// describe its newest item), the newest queued item's poster, a link to the
// event's destination, and the recipient taken from the queue row.
function buildPayload(rows, notif) {
  const newest = rows[rows.length - 1];
  const payload = parseJson(newest.payload, {}) || {};
  if (notif) {
    payload.title = notif.title;
    payload.body = notif.body || payload.body || null;
  }
  // Providers need an absolute image URL; a bare Plex path would get the whole
  // message rejected (Discord embeds, Pushover attachments).
  if (payload.posterUrl && !/^https?:\/\//i.test(String(payload.posterUrl))) payload.posterUrl = null;
  const type = payload.type || notif?.type;
  const data = notif?.data ?? null;
  if (!payload.url) {
    const url = notificationUrl(db.getSetting('app_public_url', '') || '', type, data);
    if (url) payload.url = url;
  }
  const path = notificationPath(type, data);
  if (path) payload.path = path;
  payload.userId = newest.user_id || null;
  return payload;
}

async function deliverGroup(rows, summary) {
  const first = rows[0];
  const notif = first.notification_id ? db.getNotificationById(first.notification_id) : null;

  // If the user already read the bell notification, skip their personal copy —
  // they've seen it in the app so external notifications would just be noise.
  // The shared admin feed is watched by others, so it still gets the event
  // once: the rows carrying its copy send feed-only (and retry as usual).
  const read = !!(notif && notif.read);
  if (read) {
    for (const row of rows.filter(r => !owesFeed(r))) {
      db.recordQueueDelivery(row.id, { status: DeliveryStatus.SKIPPED, error: 'read in app before sending' });
      summary.skipped++;
    }
    rows = rows.filter(owesFeed);
    if (!rows.length) {
      logger.debug(`notificationService: notif ${first.notification_id} already read, skipping ${first.agent} send`);
      return;
    }
  }

  const payload = buildPayload(rows, notif);
  const ctx = {
    recipientId: read ? null : (first.user_id || null),
    feed: rows.some(owesFeed),
    delivered: deliveredTargets(rows),
  };
  let result;
  try {
    result = normalizeResult(await dispatchToAgent(first.agent, payload, ctx));
  } catch (err) {
    result = { status: classifyError(err), targets: {}, error: err?.message || String(err), retryAfter: err?.retryAfter || 0 };
  }
  const sentNow = Object.entries(result.targets || {})
    .filter(([, status]) => status === DeliveryStatus.SENT).map(([id]) => id);

  // Each row keeps its own delivered targets and attempt count, so an event that
  // joined the bundle late gets its full retry budget.
  const outcomes = rows.map(row => db.recordQueueDelivery(row.id, {
    status: result.status, delivered: [...deliveredOf(row), ...sentNow], error: result.error, retryAfter: result.retryAfter,
  }));
  const label = `${first.agent} for ${notif ? `notif ${first.notification_id}` : `queue item ${first.id}`} (user ${first.user_id || '-'})`;
  const attemptsOf = (status) => Math.max(0, ...outcomes.filter(o => o?.status === status).map(o => o.attempts));
  for (const o of outcomes) {
    if (o?.status === 'sent') summary.sent++;
    else if (o?.status === 'pending') summary.retried++;
    else if (o?.status === 'failed') summary.failed++;
    else summary.skipped++;
  }
  if (attemptsOf('failed')) {
    logger.warn(`notificationService: ${label} failed permanently after ${attemptsOf('failed')} attempt(s): ${result.error}`);
  }
  if (attemptsOf('pending')) {
    logger.info(`notificationService: ${label} will retry (attempt ${attemptsOf('pending')}/${db.QUEUE_MAX_ATTEMPTS}): ${result.error}`);
  } else if (result.status === 'sent') {
    logger.debug(`notificationService: sent ${label}`);
  }
}

async function processPendingNotifications() {
  // One pass at a time: a slow batch must not be picked up again by the next tick.
  if (_running) return { busy: true };
  _running = true;
  const summary = { sent: 0, retried: 0, failed: 0, skipped: 0 };
  try {
    const rows = db.claimDueQueuedNotifications(50);
    for (const group of groupRows(rows)) {
      try {
        await deliverGroup(group, summary);
      } catch (err) {
        logger.warn('notificationService: delivery bookkeeping failed:', err.message);
      }
    }
    return summary;
  } finally {
    _running = false;
  }
}

function start() {
  if (_interval) return;
  _interval = setInterval(() => {
    processPendingNotifications().catch(err => logger.warn('notificationService error:', err.message));
  }, 30000);
  logger.info('Notification service started (30s interval)');
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Dispatch one queued payload to a registered agent with its delivery context.
async function dispatchToAgent(agentKey, payload, ctx) {
  const agent = manager.getAgent(agentKey);
  if (agent && typeof agent.send === 'function') {
    return agent.send(payload.type, payload, ctx);
  }
  logger.warn(`notificationService: unknown agent "${agentKey}", skipping`);
  return skipped(`unknown agent ${agentKey}`);
}

module.exports = { start, stop, processPendingNotifications, dispatchToAgent, buildPayload };
