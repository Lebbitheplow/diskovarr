const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');
const { toPlainText } = require('./messageFormat');
const { resolveAudience, runTargets, skipped, ensureOk, emptyTally, tallySend } = require('./notificationAgents/delivery');

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
    if (payload.url) {
      return {
        type: 'link',
        title: payload.title || '',
        body: payload.body || '',
        url: payload.url,
      };
    }
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

    await ensureOk(res, 'Pushbullet');
    return true;
  }

  // Feed: the admin account (optionally a channel). Personal: the recipient's token.
  async send(type, payload, ctx) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.accessToken) return skipped('Pushbullet disabled');
    if (!this.shouldSendType(type)) return skipped(`type ${type} not selected`);
    const { recipientId, feed } = resolveAudience(payload, ctx);
    const targets = [];

    if (feed) {
      targets.push({ id: 'feed', send: () => this.sendToToken(settings.accessToken, payload, settings.channelTag || null) });
    }
    if (recipientId) {
      const prefs = db.getUserNotificationPrefs(recipientId);
      if (prefs?.pushbullet_enabled && prefs?.pushbullet_access_token && prefs.pushbullet_access_token !== settings.accessToken) {
        targets.push({ id: 'user', send: () => this.sendToToken(prefs.pushbullet_access_token, payload, null) });
      }
    }

    const result = await runTargets(targets, ctx);
    if (result.error) logger.warn('Pushbullet agent error:', result.error);
    return result;
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

  // Returns { attempted, sent, failed }.
  async sendBroadcast(message) {
    const tally = emptyTally();
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.accessToken) return tally;

    const payload = {
      title: 'Message from Server Admin',
      body: toPlainText(message),
    };

    // Send to admin account
    await tallySend(tally,
      () => this.sendToToken(settings.accessToken, payload, settings.channelTag || null),
      (err) => logger.warn('Pushbullet broadcast error:', err.message));

    // Send to all users with Pushbullet configured
    const tokens = new Set([settings.accessToken]);
    for (const user of db.getKnownUsers()) {
      const prefs = db.getUserNotificationPrefs(user.user_id);
      if (prefs?.pushbullet_enabled && prefs?.pushbullet_access_token && !tokens.has(prefs.pushbullet_access_token)) {
        tokens.add(prefs.pushbullet_access_token);
        await tallySend(tally,
          () => this.sendToToken(prefs.pushbullet_access_token, payload, null),
          (err) => logger.warn(`Pushbullet broadcast to user ${user.user_id} failed:`, err.message));
      }
    }
    return tally;
  }
}

const agent = new PushbulletAgent();
module.exports = agent;
