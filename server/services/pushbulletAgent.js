const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');

// Pushbullet agent — push notifications
// Docs: https://docs.pushbullet.com/

class PushbulletAgent extends BaseAgent {
  constructor() {
    super('pushbullet_agent');
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled && settings.accessToken);
  }

  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  buildPayload(type, payload) {
    return {
      type: 'note',
      title: payload.title || '',
      body: payload.body || '',
    };
  }

  async sendToToken(accessToken, payload, channelTag) {
    const body = this.buildPayload('note', payload);
    if (channelTag) {
      body.channel_tag = channelTag;
    }

    const res = await fetch('https://api.pushbullet.com/v2/pushes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Pushbullet ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return true;
  }

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.accessToken) return;
    if (!this.shouldSendType(type)) return;

    let sent = 0;

    try {
      // Send to admin account
      await this.sendToToken(settings.accessToken, payload, settings.channelTag || null);
      sent++;
      logger.debug('Pushbullet: sent to admin account');

      // Send to specific user if provided
      if (payload.userId) {
        const prefs = db.getUserNotificationPrefs(payload.userId);
        if (prefs?.pushbullet_enabled && prefs?.pushbullet_access_token) {
          if (prefs.pushbullet_access_token !== settings.accessToken) {
            await this.sendToToken(prefs.pushbullet_access_token, payload, null);
            sent++;
            logger.debug(`Pushbullet: sent to user ${payload.userId}`);
          }
        }
      }
    } catch (err) {
      logger.warn('Pushbullet agent error:', err.message);
    }

    return sent > 0;
  }

  async sendTest(payload) {
    const { accessToken } = payload;
    if (!accessToken) throw new Error('Pushbullet access token required');

    const body = {
      type: 'note',
      title: 'Diskovarr Test Notification',
      body: 'Pushbullet notifications are working correctly.',
    };

    const res = await fetch('https://api.pushbullet.com/v2/pushes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': accessToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Pushbullet test failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return true;
  }

  async sendBroadcast(message) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.accessToken) return;

    const payload = {
      title: 'Message from Server Admin',
      body: message,
    };

    try {
      // Send to admin account
      await this.sendToToken(settings.accessToken, payload, settings.channelTag || null);

      // Send to all users with Pushbullet configured
      const users = db.getKnownUsers();
      for (const user of users) {
        const prefs = db.getUserNotificationPrefs(user.user_id);
        if (prefs?.pushbullet_enabled && prefs?.pushbullet_access_token) {
          if (prefs.pushbullet_access_token !== settings.accessToken) {
            await this.sendToToken(prefs.pushbullet_access_token, payload, null).catch((err) => {
              logger.warn(`Pushbullet broadcast to user ${user.user_id} failed:`, err.message);
            });
          }
        }
      }
    } catch (err) {
      logger.warn('Pushbullet broadcast error:', err.message);
    }
  }
}

const agent = new PushbulletAgent();
module.exports = agent;
