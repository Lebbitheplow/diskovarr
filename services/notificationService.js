const db = require('../db/database');
const discordAgent = require('./discordAgent');
const pushoverAgent = require('./pushoverAgent');
const logger = require('./logger');

let _interval = null;

async function processPendingNotifications() {
  const pending = db.getPendingQueuedNotifications();
  if (!pending.length) return;

  // Group items that share a notification_id (bundled bell notifications) so we
  // send ONE Discord/Pushover message per bundle instead of one per queue item.
  // Items without a notification_id are sent individually.
  const grouped = new Map(); // key: "notif_id:agent:user_id" → [items ordered by id ASC]
  const ungrouped = [];

  for (const item of pending) {
    if (item.notification_id) {
      const key = `${item.notification_id}:${item.agent}:${item.user_id || ''}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    } else {
      ungrouped.push(item);
    }
  }

  // Send one message per bundle group
  for (const [, items] of grouped) {
    const first = items[0]; // lowest id = first enqueued = first title's posterUrl
    const notif = db.getNotificationById(first.notification_id);

    // If the user already read the bell notification, skip the external send —
    // they've seen it in the app so Discord/Pushover would just be noise.
    if (notif && notif.read) {
      logger.debug(`notificationService: notif ${first.notification_id} already read, skipping ${first.agent} send`);
      for (const item of items) db.markQueueItemSent(item.id);
      continue;
    }

    try {
      const payload = JSON.parse(first.payload);
      if (notif) {
        // Use the current bundled title from the notifications table
        payload.title = notif.title;
        // For bundles with multiple items, the per-item body is stale — clear it
        payload.body = notif.bundle_count > 1 ? null : (notif.body || payload.body);
      }
      logger.debug(`notificationService: sending ${first.agent} for notif ${first.notification_id} (bundle_count=${notif?.bundle_count ?? 1})`);
      if (first.agent === 'discord') {
        await discordAgent.sendNotification(payload);
      } else if (first.agent === 'pushover') {
        await pushoverAgent.sendNotification(payload);
      }
    } catch (err) {
      logger.warn(`notificationService: failed to send bundle (notif ${first.notification_id}):`, err.message);
    }
    for (const item of items) db.markQueueItemSent(item.id);
  }

  // Send ungrouped items individually
  for (const item of ungrouped) {
    try {
      const payload = JSON.parse(item.payload);
      logger.debug(`notificationService: sending ${item.agent} for ungrouped item ${item.id}`);
      if (item.agent === 'discord') {
        await discordAgent.sendNotification(payload);
      } else if (item.agent === 'pushover') {
        await pushoverAgent.sendNotification(payload);
      }
      db.markQueueItemSent(item.id);
    } catch (err) {
      logger.warn(`notificationService: failed to send item ${item.id}:`, err.message);
      db.markQueueItemSent(item.id); // don't retry forever
    }
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

module.exports = { start, stop, processPendingNotifications };
