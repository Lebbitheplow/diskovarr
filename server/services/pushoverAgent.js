const db = require('../db/database');
const logger = require('./logger');
const { hasNotificationType } = require('./notificationAgents/types');

function getConfig() {
  const raw = db.getSetting('pushover_agent', null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function sendPushover({ appToken, userKey, title, message, url, urlTitle, sound, posterUrl, embedPoster }) {
  if (!appToken || !userKey) return;
  const body = new URLSearchParams({ token: appToken, user: userKey, title, message: message || title });
  if (url) { body.append('url', url); body.append('url_title', urlTitle || 'View'); }
  if (sound) body.append('sound', sound);
  if (embedPoster && posterUrl) {
    // Use attachment_url if posterUrl is an http URL, otherwise skip (base64 would be too large for URLSearchParams)
    if (posterUrl.startsWith('http://') || posterUrl.startsWith('https://')) {
      body.append('attachment_url', posterUrl);
    }
  }
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Pushover returned ${res.status}`);
}

async function sendNotification({ type, title, body, userId, posterUrl }) {
  const config = getConfig();
  if (!config || !config.enabled || !config.appToken) return;
  const enabledTypes = config.notificationTypes || [];
  if (!enabledTypes.includes(type)) return;
  try {
    // Global key
    if (config.userKey) {
      await sendPushover({ appToken: config.appToken, userKey: config.userKey, title, message: body, sound: config.sound || null, posterUrl, embedPoster: config.embedPoster });
    }
    // Per-user key
    if (userId) {
      const prefs = db.getUserNotificationPrefs(userId);
      if (prefs.pushover_enabled && prefs.pushover_user_key) {
        await sendPushover({ appToken: config.appToken, userKey: prefs.pushover_user_key, title, message: body, sound: config.sound || null, posterUrl, embedPoster: config.embedPoster });
      }
    }
  } catch (err) {
    logger.warn('Pushover agent error:', err.message);
  }
}

async function sendTest(appToken, userKey) {
  await sendPushover({ appToken, userKey, title: 'Diskovarr Test', message: 'Pushover notifications are working correctly.' });
}

// ── Broadcast (admin message to all users, bypasses type filter) ───────────────

async function sendBroadcast(message) {
  const config = getConfig();
  if (!config || !config.enabled || !config.appToken) return;

  const sentKeys = new Set();
  if (config.userKey) {
    try {
      await sendPushover({ appToken: config.appToken, userKey: config.userKey, title: 'Message from Server Admin', message });
      sentKeys.add(config.userKey);
    } catch (err) {
      logger.warn('Pushover broadcast global error:', err.message);
    }
  }
  const users = db.getKnownUsers();
  for (const user of users) {
    const prefs = db.getUserNotificationPrefs(user.user_id);
    if (prefs?.pushover_enabled && prefs?.pushover_user_key && !sentKeys.has(prefs.pushover_user_key)) {
      sentKeys.add(prefs.pushover_user_key);
      try {
        await sendPushover({ appToken: config.appToken, userKey: prefs.pushover_user_key, title: 'Message from Server Admin', message });
      } catch (err) {
        logger.warn(`Pushover broadcast for user ${user.user_id} failed:`, err.message);
      }
    }
  }
}

// ── Manager compatibility layer ───────────────────────────────────────────────

function shouldSend() {
  const config = getConfig();
  return !!(config && config.enabled && config.appToken);
}

function shouldSendType(diskovarrType) {
  const config = getConfig();
  if (!config || !config.enabled) return false;
  const types = config.notificationTypes || [];
  return types.includes(diskovarrType);
}

// Manager interface: send(type, payload)
async function sendForManager(type, payload) {
  return sendNotification({ type, title: payload.title, body: payload.body, posterUrl: payload.posterUrl, userId: payload.userId });
}

module.exports = {
  sendNotification,
  sendTest,
  getConfig,
  sendBroadcast,
  // Manager interface
  settingsKey: 'pushover_agent',
  shouldSend,
  shouldSendType,
  send: sendForManager,
};
