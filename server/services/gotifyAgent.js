const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');
const { forGotify } = require('./messageFormat');
const { resolveAudience, runTargets, skipped, ensureOk, emptyTally, tallySend } = require('./notificationAgents/delivery');

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
    let message = payload.body || '';
    const priority = settings.priority ?? 0;

    if (payload.url) {
      message += `\n\n[View in Diskovarr](${payload.url})`;
    }

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

  // Admin feed only — Gotify has no per-user destination.
  async send(type, payload, ctx) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.token) return skipped('Gotify disabled');
    if (!this.shouldSendType(type)) return skipped(`type ${type} not selected`);
    if (!resolveAudience(payload, ctx).feed) return skipped('feed copy carried by another queue row');
    const result = await runTargets([{ id: 'feed', send: () => this.deliver(type, payload) }], ctx);
    if (result.error) logger.warn('Gotify agent error:', result.error);
    return result;
  }

  async deliver(type, payload) {
    const settings = this.getSettings();
    const body = this.buildPayload(type, payload);
    const endpoint = `${settings.url.replace(/\/$/, '')}/message?token=${settings.token}`;
    logger.debug(`Gotify: sending to ${settings.url}`);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    await ensureOk(res, 'Gotify');
    return true;
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

  // Broadcasts bypass the type filter. Returns { attempted, sent, failed }.
  async sendBroadcast(message) {
    const tally = emptyTally();
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.url || !settings.token) return tally;
    await tallySend(tally,
      () => this.deliver('broadcast', { title: 'Message from Server Admin', body: forGotify(message) }),
      (err) => logger.warn('Gotify broadcast failed:', err.message));
    return tally;
  }
}

const agent = new GotifyAgent();
module.exports = agent;
