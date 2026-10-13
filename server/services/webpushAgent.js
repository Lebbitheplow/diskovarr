const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { toPlainText } = require('./messageFormat');
const { resolveAudience, runTargets, skipped, permanentError, emptyTally, tallySend } = require('./notificationAgents/delivery');
const { isSafePushEndpoint, publicHttpsAgent } = require('./notificationAgents/destinations');
const webpush = require('web-push');

// WebPush agent — browser push notifications
// Requires VAPID keys and browser subscriptions stored in user_push_subscriptions table

const PUSH_KEY = /^[A-Za-z0-9_-]{8,256}={0,2}$/;

// Shape check for a browser PushSubscription before it is stored: an https
// push-service endpoint (never loopback/private/localhost) and base64url keys.
function validSubscription(subscription) {
  return !!(subscription
    && isSafePushEndpoint(subscription.endpoint)
    && typeof subscription.keys?.auth === 'string' && PUSH_KEY.test(subscription.keys.auth)
    && typeof subscription.keys?.p256dh === 'string' && PUSH_KEY.test(subscription.keys.p256dh));
}

class WebPushAgent extends BaseAgent {
  constructor() {
    super('webpush_agent');
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled);
  }

  shouldSendType() {
    // WebPush doesn't filter by type at the agent level
    return true;
  }

  // Initialize VAPID keys if not set
  initVapid() {
    const vapidPublic = db.getSetting('webpush_vapid_public', null);
    const vapidPrivate = db.getSetting('webpush_vapid_private', null);

    if (vapidPublic && vapidPrivate) {
      return { public: vapidPublic, private: vapidPrivate };
    }

    // Generate new keys
    const keys = webpush.generateVAPIDKeys();
    db.setSetting('webpush_vapid_public', keys.publicKey);
    db.setSetting('webpush_vapid_private', keys.privateKey);
    logger.info('WebPush: generated new VAPID keys');
    return { public: keys.publicKey, private: keys.privateKey };
  }

  // Store a browser push subscription
  saveSubscription(userId, subscription) {
    if (!validSubscription(subscription)) {
      logger.warn(`WebPush: rejected invalid subscription for user ${userId}`);
      return false;
    }
    try {
      db.prepare(
        'INSERT INTO user_push_subscriptions (user_id, endpoint, auth, p256dh) VALUES (?, ?, ?, ?)'
      ).run(
        String(userId),
        subscription.endpoint,
        subscription.keys.auth,
        subscription.keys.p256dh
      );
      logger.debug(`WebPush: saved subscription for user ${userId}`);
      return true;
    } catch (err) {
      // Duplicate subscription — remove old and re-add
      if (err.message && err.message.includes('UNIQUE')) {
        db.prepare('DELETE FROM user_push_subscriptions WHERE user_id = ? AND endpoint = ?')
          .run(String(userId), subscription.endpoint);
        return this.saveSubscription(userId, subscription);
      }
      logger.warn('WebPush: failed to save subscription:', err.message);
      return false;
    }
  }

  // The one registration path for both subscribe routes: the admin must have
  // browser push enabled and the subscription must pass validSubscription.
  // Subscribing is the opt-in, so the user's channel flag is switched on too.
  registerSubscription(userId, subscription) {
    if (!this.shouldSend()) return { ok: false, status: 400, error: 'Browser notifications are not enabled by the admin' };
    if (!validSubscription(subscription)) return { ok: false, status: 400, error: 'Invalid push subscription' };
    if (!this.saveSubscription(userId, subscription)) return { ok: false, status: 500, error: 'Could not save subscription' };
    db.setUserNotificationPrefs(userId, { webpush_enabled: true });
    return { ok: true };
  }

  // Remove a subscription (cleanup)
  removeSubscription(userId, endpoint) {
    try {
      db.prepare('DELETE FROM user_push_subscriptions WHERE user_id = ? AND endpoint = ?')
        .run(String(userId), endpoint);
    } catch (err) {
      logger.warn('WebPush: failed to remove subscription:', err.message);
    }
  }

  // Get subscriptions for a user
  getUserSubscriptions(userId) {
    try {
      return db.prepare('SELECT * FROM user_push_subscriptions WHERE user_id = ?')
        .all(String(userId));
    } catch {
      return [];
    }
  }

  // Get all subscriptions
  getAllSubscriptions() {
    try {
      return db.prepare('SELECT * FROM user_push_subscriptions').all();
    } catch {
      return [];
    }
  }

  // Remove stale subscription (410/404 from push service)
  removeStaleSubscription(endpoint) {
    try {
      db.prepare('DELETE FROM user_push_subscriptions WHERE endpoint = ?').run(endpoint);
    } catch {
      // ignore
    }
  }

  vapidDetails() {
    const vapid = this.initVapid();
    const ownerId = db.getSetting('owner_plex_user_id', null);
    const mainUser = ownerId ? db.getKnownUsers().find((u) => u.user_id === ownerId) : null;
    return {
      subject: `mailto:${mainUser?.email || 'admin@diskovarr.local'}`,
      publicKey: vapid.public,
      privateKey: vapid.private,
    };
  }

  // Sends one push; throws a classified error on failure. The endpoint is
  // re-validated here (rows saved before validation existed) and the
  // connection refuses hosts that resolve to private addresses.
  async pushToSubscription(sub, payload) {
    if (!isSafePushEndpoint(sub.endpoint)) {
      this.removeStaleSubscription(sub.endpoint);
      throw permanentError('Push endpoint is not an allowed push service URL; subscription removed');
    }
    const notificationPayload = JSON.stringify({
      notificationType: payload.type || 'notification',
      subject: payload.title || '',
      message: payload.body || '',
      image: payload.posterUrl || undefined,
      // Same-origin path works without a configured public URL.
      url: payload.url || payload.path || undefined,
    });
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { auth: sub.auth, p256dh: sub.p256dh } },
        notificationPayload,
        { vapidDetails: this.vapidDetails(), agent: publicHttpsAgent(), timeout: 10000 },
      );
      return true;
    } catch (err) {
      const statusCode = err.statusCode || err.status;
      // Permanent failure — remove subscription
      if (statusCode === 410 || statusCode === 404) {
        this.removeStaleSubscription(sub.endpoint);
        err.retryable = false;
      }
      if (statusCode && !err.status) err.status = statusCode;
      throw err;
    }
  }

  // Boolean wrapper for tests/broadcasts.
  async sendToSubscription(sub, payload) {
    try {
      return await this.pushToSubscription(sub, payload);
    } catch (err) {
      logger.warn(`WebPush: send failed (status ${err.status || 'n/a'}):`, err.message);
      return false;
    }
  }

  // Personal only: pushes go to the queue row's recipient's own devices when
  // they opted in. Admin-facing events reach admins because producers enqueue
  // one row per privileged user; an unaddressed send reaches nobody.
  async send(type, payload, ctx) {
    if (!this.shouldSend()) return skipped('WebPush disabled');
    const { recipientId } = resolveAudience(payload, ctx);
    if (!recipientId) return skipped('no recipient');
    const prefs = db.getUserNotificationPrefs(recipientId);
    if (!prefs?.webpush_enabled) return skipped('recipient has not enabled browser push');
    const targets = this.getUserSubscriptions(recipientId).map((sub) => ({
      id: `push:${sub.id}`,
      send: () => this.pushToSubscription(sub, { ...payload, type }),
    }));
    const result = await runTargets(targets, ctx);
    if (result.error) logger.warn('WebPush agent error:', result.error);
    return result;
  }

  // Test push for a single user's own devices (Settings → Notifications → WebPush).
  async sendTestToUser(userId) {
    const subs = this.getUserSubscriptions(userId);
    if (subs.length === 0) {
      throw new Error('No browser subscriptions found. Enable notifications on this device first.');
    }
    let sent = 0;
    for (const sub of subs) {
      if (await this.sendToSubscription(sub, {
        type: 'TEST_NOTIFICATION',
        title: 'Diskovarr Test Notification',
        body: 'Browser notifications are working correctly.',
      })) sent++;
    }
    if (sent === 0) throw new Error('All subscriptions failed. Try enabling notifications again.');
    return true;
  }

  async sendTest(_payload) {
    // Send to all subscriptions
    const subs = this.getAllSubscriptions();
    if (subs.length === 0) {
      throw new Error('No browser subscriptions found. Subscribe from your browser first.');
    }

    let sent = 0;
    for (const sub of subs) {
      if (await this.sendToSubscription(sub, {
        type: 'TEST_NOTIFICATION',
        title: 'Diskovarr Test Notification',
        body: 'WebPush notifications are working correctly.',
      })) sent++;
    }

    if (sent === 0) {
      throw new Error('All subscriptions failed. Try subscribing again.');
    }
    return true;
  }

  // Every subscribed device of users who have browser push enabled (the same
  // opt-in regular delivery honours). Returns { attempted, sent, failed }.
  async sendBroadcast(message) {
    const tally = emptyTally();
    if (!this.shouldSend()) return tally;
    const payload = {
      title: 'Message from Server Admin',
      body: toPlainText(message),
      type: 'broadcast',
    };

    const optedIn = new Map();
    for (const sub of this.getAllSubscriptions()) {
      if (!optedIn.has(sub.user_id)) optedIn.set(sub.user_id, !!db.getUserNotificationPrefs(sub.user_id)?.webpush_enabled);
      if (!optedIn.get(sub.user_id)) continue;
      await tallySend(tally,
        () => this.pushToSubscription(sub, payload),
        (err) => logger.warn('WebPush broadcast failed:', err.message));
    }
    return tally;
  }
}

const agent = new WebPushAgent();
agent.validSubscription = validSubscription;
module.exports = agent;
