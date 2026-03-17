const db = require('../db/database');
const discordAgent = require('./discordAgent');
const pushoverAgent = require('./pushoverAgent');
const logger = require('./logger');

let _interval = null;

async function processPendingNotifications() {
  const pending = db.getPendingQueuedNotifications();
  for (const item of pending) {
    try {
      const payload = JSON.parse(item.payload);
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
