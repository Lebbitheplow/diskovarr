const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');

// ntfy agent — self-hosted or cloud pub-sub notification service
// Docs: https://ntfy.sh/docs/publish/

class NtfyAgent extends BaseAgent {
  constructor() {
    super('ntfy_agent');
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled && settings.url && settings.topic);
  }

  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  // Escape markdown special characters for ntfy
  escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/([\\`*_{}[\]()#+\-.!|>~<])/g, '\\$1');
  }

  buildPayload(type, payload) {
    const settings = this.getSettings();
    const title = payload.title || '';
    const message = payload.body || '';
    const topic = settings.topic;
    const priority = settings.priority ?? 3;

    const ntfyPayload = {
      topic,
      priority,
      title,
      markdown: true,
    };

    if (message) ntfyPayload.message = message;

    // Attach poster image if configured
    if (settings.embedPoster && payload.posterUrl) {
      ntfyPayload.attach = payload.posterUrl;
    }

    return ntfyPayload;
  }

  buildAuthHeader() {
    const settings = this.getSettings();
    if (!settings) return null;

    if (settings.authMethod === 'token' && settings.token) {
      return `Bearer ${settings.token}`;
    }
    if (settings.authMethod === 'basic' && settings.username && settings.password) {
      const encoded = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
      return `Basic ${encoded}`;
    }
    return null;
  }

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.topic) return;
    if (!this.shouldSendType(type)) return;

    try {
      const body = this.buildPayload(type, payload);
      const headers = { 'Content-Type': 'application/json' };

      const authHeader = this.buildAuthHeader();
      if (authHeader) {
        headers.Authorization = authHeader;
      }

      logger.debug(`ntfy: sending to ${settings.url} topic=${settings.topic}`);

      const res = await fetch(settings.url.replace(/\/$/, ''), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`ntfy ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return true;
    } catch (err) {
      logger.warn('ntfy agent error:', err.message);
      return false;
    }
  }

  async sendTest(payload) {
    const { url, topic, authMethod, token, username, password, priority } = payload;
    if (!url || !topic) throw new Error('ntfy URL and topic required');

    const headers = { 'Content-Type': 'application/json' };
    if (authMethod === 'token' && token) {
      headers.Authorization = `Bearer ${token}`;
    } else if (authMethod === 'basic' && username && password) {
      const encoded = Buffer.from(`${username}:${password}`).toString('base64');
      headers.Authorization = `Basic ${encoded}`;
    }

    const body = {
      topic,
      priority: priority ?? 3,
      title: 'Diskovarr Test Notification',
      message: 'ntfy notifications are working correctly.',
      markdown: true,
    };

    const res = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`ntfy test failed (${res.status}): ${await res.text().catch(() => '')}`);
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

const agent = new NtfyAgent();
module.exports = agent;
