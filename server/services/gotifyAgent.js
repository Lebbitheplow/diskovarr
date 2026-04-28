const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');

// Gotify agent — self-hosted notification server
// Docs: https://gotify.net/docs/push

class GotifyAgent extends BaseAgent {
  constructor() {
    super('gotify_agent');
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled && settings.url && settings.token);
  }

  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  buildPayload(type, payload) {
    const settings = this.getSettings();
    const title = payload.title || '';
    const message = payload.body || '';
    const priority = settings.priority ?? 0;

    return {
      title,
      message,
      priority,
      extras: {
        'client::display': {
          contentType: 'text/markdown',
        },
      },
    };
  }

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.token) return;
    if (!this.shouldSendType(type)) return;

    try {
      const body = this.buildPayload(type, payload);
      const endpoint = `${settings.url.replace(/\/$/, '')}/message?token=${settings.token}`;
      logger.debug(`Gotify: sending to ${settings.url}`);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Gotify ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return true;
    } catch (err) {
      logger.warn('Gotify agent error:', err.message);
      return false;
    }
  }

  async sendTest(payload) {
    const { url, token, priority } = payload;
    if (!url || !token) throw new Error('Gotify URL and token required');

    const body = {
      title: 'Diskovarr Test Notification',
      message: 'Gotify notifications are working correctly.',
      priority: priority ?? 0,
      extras: {
        'client::display': {
          contentType: 'text/markdown',
        },
      },
    };

    const endpoint = `${url.replace(/\/$/, '')}/message?token=${token}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Gotify test failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return true;
  }

  async sendBroadcast(message) {
    await this.send('broadcast', {
      title: 'Message from Server Admin',
      body: message,
    });
  }
}

const agent = new GotifyAgent();
module.exports = agent;
