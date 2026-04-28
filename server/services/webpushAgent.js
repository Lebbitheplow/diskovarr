const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const webpush = require('web-push');

// WebPush agent — browser push notifications
// Requires VAPID keys and browser subscriptions stored in user_push_subscriptions table

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

  async sendToSubscription(sub, payload) {
    const vapid = this.initVapid();
    const mainUser = db.getSetting('owner_plex_user_id', null)
      ? db.getKnownUsers().find((u) => u.user_id === db.getSetting('owner_plex_user_id', ''))
      : null;

    webpush.setVapidDetails(
      `mailto:${mainUser?.email || 'admin@diskovarr.local'}`,
      vapid.public,
      vapid.private
    );

    const notificationPayload = JSON.stringify({
      notificationType: payload.type || 'notification',
      subject: payload.title || '',
      message: payload.body || '',
      image: payload.posterUrl || undefined,
    });

    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            auth: sub.auth,
            p256dh: sub.p256dh,
          },
        },
        notificationPayload
      );
      return true;
    } catch (err) {
      const statusCode = err.statusCode || err.status;
      // Permanent failure — remove subscription
      if (statusCode === 410 || statusCode === 404) {
        this.removeStaleSubscription(sub.endpoint);
      }
      logger.warn(`WebPush: send failed (status ${statusCode}):`, err.message);
      return false;
    }
  }

  async send(type, payload) {
    if (!this.shouldSend()) return;

    let sent = 0;

    try {
      // Send to specific user
      if (payload.userId) {
        const subs = this.getUserSubscriptions(payload.userId);
        for (const sub of subs) {
          if (await this.sendToSubscription(sub, { ...payload, type })) {
            sent++;
          }
        }
      }

      // Send to all admin subscriptions
      const adminIds = db.getPrivilegedUserIds();
      for (const adminId of adminIds) {
        const subs = this.getUserSubscriptions(adminId);
        for (const sub of subs) {
          if (await this.sendToSubscription(sub, { ...payload, type })) {
            sent++;
          }
        }
      }
    } catch (err) {
      logger.warn('WebPush agent error:', err.message);
    }

    return sent > 0;
  }

  async sendTest(payload) {
    const message = {
      notificationType: 'TEST_NOTIFICATION',
      subject: 'Diskovarr Test Notification',
      message: 'WebPush notifications are working correctly.',
    };

    // Send to all subscriptions
    const subs = this.getAllSubscriptions();
    if (subs.length === 0) {
      throw new Error('No browser subscriptions found. Subscribe from your browser first.');
    }

    const vapid = this.initVapid();
    webpush.setVapidDetails(
      `mailto:admin@diskovarr.local`,
      vapid.public,
      vapid.private
    );

    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { auth: sub.auth, p256dh: sub.p256dh },
          },
          JSON.stringify(message)
        );
        sent++;
      } catch (err) {
        const statusCode = err.statusCode || err.status;
        if (statusCode === 410 || statusCode === 404) {
          this.removeStaleSubscription(sub.endpoint);
        }
      }
    }

    if (sent === 0) {
      throw new Error('All subscriptions failed. Try subscribing again.');
    }
    return true;
  }

  async sendBroadcast(message) {
    const payload = {
      title: 'Message from Server Admin',
      body: message,
      type: 'broadcast',
    };

    const subs = this.getAllSubscriptions();
    for (const sub of subs) {
      await this.sendToSubscription(sub, payload).catch((err) => {
        logger.warn(`WebPush broadcast failed:`, err.message);
      });
    }
  }
}

const agent = new WebPushAgent();
module.exports = agent;
