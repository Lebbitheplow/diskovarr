const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType, TYPE_MAP } = require('./notificationAgents/types');

// Template variable map for webhook JSON payloads
// Maps {{variable_name}} → value from notification payload
const KEY_MAP = {
  // General
  notification_type: (p) => (p.event || 'test'),
  event: (p) => (p.event || ''),
  subject: (p) => (p.title || ''),
  message: (p) => (p.body || ''),
  image: (p) => (p.posterUrl || ''),
  url: (p) => (p.url || ''),
  timestamp: () => new Date().toISOString(),
};

// Build a webhook agent instance
class WebhookAgent extends BaseAgent {
  constructor() {
    super('webhook_agent');
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled && settings.webhookUrl);
  }

  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  // Parse template variables in a value (recursive for nested objects/arrays)
  parseVariables(value, type, payload) {
    if (typeof value === 'string') {
      return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const fn = KEY_MAP[key];
        if (fn) return String(fn(payload, type));
        return '';
      });
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.parseVariables(v, type, payload));
    }
    if (typeof value === 'object' && value !== null) {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = this.parseVariables(v, type, payload);
      }
      return result;
    }
    return value;
  }

  // Build the JSON payload from template
  buildPayload(type, payload) {
    const settings = this.getSettings();
    let template;
    try {
      // Payload is stored as base64-encoded JSON string
      const decoded = Buffer.from(settings.jsonPayload, 'base64').toString('utf8');
      template = JSON.parse(decoded);
    } catch {
      // Fallback default template
      template = {
        notification_type: '{{notification_type}}',
        event: '{{event}}',
        subject: '{{subject}}',
        message: '{{message}}',
        image: '{{image}}',
      };
    }
    return this.parseVariables(template, type, payload);
  }

  // Build headers
  buildHeaders() {
    const settings = this.getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.authHeader) {
      headers.Authorization = settings.authHeader;
    }
    if (settings.customHeaders && Array.isArray(settings.customHeaders)) {
      for (const h of settings.customHeaders) {
        if (h.key && h.value && h.key.toLowerCase() !== 'authorization') {
          headers[h.key] = h.value;
        }
      }
    }
    return headers;
  }

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.webhookUrl) return;
    if (!this.shouldSendType(type)) return;

    let webhookUrl = settings.webhookUrl;

    // Support variables in URL
    if (settings.supportVariables) {
      webhookUrl = webhookUrl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const fn = KEY_MAP[key];
        if (fn) return encodeURIComponent(String(fn(payload, type)));
        return '';
      });
    }

    try {
      const body = this.buildPayload(type, payload);
      const headers = this.buildHeaders();

      logger.debug(`Webhook: sending to ${webhookUrl}`);
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Webhook ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return true;
    } catch (err) {
      logger.warn('Webhook agent error:', err.message);
      return false;
    }
  }

  async sendTest(payload) {
    const settings = payload; // Test passes raw settings from admin UI
    const webhookUrl = settings.webhookUrl;
    if (!webhookUrl) throw new Error('Webhook URL required');

    const headers = { 'Content-Type': 'application/json' };
    if (settings.authHeader) headers.Authorization = settings.authHeader;

    let body;
    try {
      // Try to parse the JSON payload template
      const decoded = Buffer.from(settings.jsonPayload, 'base64').toString('utf8');
      const template = JSON.parse(decoded);
      body = this.parseVariables(template, 'test', {
        event: 'Test',
        title: 'Diskovarr Test Notification',
        body: 'Webhook notifications are working correctly.',
        posterUrl: '',
      });
    } catch {
      body = {
        notification_type: 'TEST_NOTIFICATION',
        event: 'Test',
        subject: 'Diskovarr Test Notification',
        message: 'Webhook notifications are working correctly.',
      };
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Webhook test failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return true;
  }

  async sendBroadcast(message) {
    await this.send('broadcast', {
      event: 'Broadcast',
      title: 'Message from Server Admin',
      body: message,
      posterUrl: '',
    });
  }
}

// Singleton instance
const agent = new WebhookAgent();

module.exports = agent;
