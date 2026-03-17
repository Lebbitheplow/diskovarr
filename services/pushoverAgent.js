const db = require('../db/database');
const logger = require('./logger');

function getConfig() {
  const raw = db.getSetting('pushover_agent', null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function sendPushover({ appToken, userKey, title, message, url, urlTitle }) {
  if (!appToken || !userKey) return;
  const body = new URLSearchParams({ token: appToken, user: userKey, title, message: message || title });
  if (url) { body.append('url', url); body.append('url_title', urlTitle || 'View'); }
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Pushover returned ${res.status}`);
}

async function sendNotification({ type, title, body, userId }) {
  const config = getConfig();
  if (!config || !config.enabled || !config.appToken) return;
  const enabledTypes = config.notificationTypes || [];
  if (!enabledTypes.includes(type)) return;
  try {
    // Global webhook
    if (config.userKey) {
      await sendPushover({ appToken: config.appToken, userKey: config.userKey, title, message: body });
    }
    // Per-user webhook
    if (userId) {
      const prefs = db.getUserNotificationPrefs(userId);
      if (prefs.pushover_enabled && prefs.pushover_user_key) {
        await sendPushover({ appToken: config.appToken, userKey: prefs.pushover_user_key, title, message: body });
      }
    }
  } catch (err) {
    logger.warn('Pushover agent error:', err.message);
  }
}

async function sendTest(appToken, userKey) {
  await sendPushover({ appToken, userKey, title: 'Diskovarr Test', message: 'Pushover notifications are working correctly.' });
}

module.exports = { sendNotification, sendTest, getConfig };
