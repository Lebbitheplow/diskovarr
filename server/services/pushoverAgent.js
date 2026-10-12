const db = require('../db/database');
const logger = require('./logger');
const { toPlainText } = require('./messageFormat');
const { hasNotificationType } = require('./notificationAgents/types');
const { resolveAudience, runTargets, skipped, ensureOk, emptyTally, tallySend } = require('./notificationAgents/delivery');

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
  await ensureOk(res, 'Pushover');
}

// Feed: the admin's global user key. Personal: the recipient's own user key.
// Returns a DeliveryResult (see notificationAgents/delivery.js).
async function sendNotification({ type, title, body, userId, posterUrl, url }, ctx) {
  const config = getConfig();
  if (!config || !config.enabled || !config.appToken) return skipped('Pushover disabled');
  if (!hasNotificationType(config.notificationTypes || [], type)) return skipped(`type ${type} not selected`);
  const { recipientId, feed } = resolveAudience({ userId }, ctx);
  const deepUrl = url || null;
  const deepUrlTitle = url ? 'View in Diskovarr' : null;
  const common = { appToken: config.appToken, title, message: body, sound: config.sound || null, posterUrl, embedPoster: config.embedPoster, url: deepUrl, urlTitle: deepUrlTitle };
  const targets = [];
  // Global key
  if (feed && config.userKey) {
    targets.push({ id: 'feed', send: () => sendPushover({ ...common, userKey: config.userKey }) });
  }
  // Per-user key (the global key already covers a user who registered the same one)
  if (recipientId) {
    const prefs = db.getUserNotificationPrefs(recipientId);
    if (prefs.pushover_enabled && prefs.pushover_user_key && prefs.pushover_user_key !== config.userKey) {
      targets.push({ id: 'user', send: () => sendPushover({ ...common, userKey: prefs.pushover_user_key }) });
    }
  }
  const result = await runTargets(targets, ctx);
  if (result.error) logger.warn('Pushover agent error:', result.error);
  return result;
}

async function sendTest(appToken, userKey) {
  await sendPushover({ appToken, userKey, title: 'Diskovarr Test', message: 'Pushover notifications are working correctly.' });
}

// ── Broadcast (admin message to all users, bypasses type filter) ───────────────

// Returns { attempted, sent, failed }.
async function sendBroadcast(message) {
  const tally = emptyTally();
  const config = getConfig();
  if (!config || !config.enabled || !config.appToken) return tally;
  message = toPlainText(message);

  const sentKeys = new Set();
  if (config.userKey) {
    sentKeys.add(config.userKey);
    await tallySend(tally,
      () => sendPushover({ appToken: config.appToken, userKey: config.userKey, title: 'Message from Server Admin', message }),
      (err) => logger.warn('Pushover broadcast global error:', err.message));
  }
  const users = db.getKnownUsers();
  for (const user of users) {
    const prefs = db.getUserNotificationPrefs(user.user_id);
    if (prefs?.pushover_enabled && prefs?.pushover_user_key && !sentKeys.has(prefs.pushover_user_key)) {
      sentKeys.add(prefs.pushover_user_key);
      await tallySend(tally,
        () => sendPushover({ appToken: config.appToken, userKey: prefs.pushover_user_key, title: 'Message from Server Admin', message }),
        (err) => logger.warn(`Pushover broadcast for user ${user.user_id} failed:`, err.message));
    }
  }
  return tally;
}

// ── Manager compatibility layer ───────────────────────────────────────────────

function shouldSend() {
  const config = getConfig();
  return !!(config && config.enabled && config.appToken);
}

function shouldSendType(diskovarrType) {
  const config = getConfig();
  if (!config || !config.enabled) return false;
  return hasNotificationType(config.notificationTypes || [], diskovarrType);
}

// Manager interface: send(type, payload, ctx)
async function sendForManager(type, payload, ctx) {
  return sendNotification({ type, title: payload.title, body: payload.body, posterUrl: payload.posterUrl, userId: payload.userId, url: payload.url }, ctx);
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
