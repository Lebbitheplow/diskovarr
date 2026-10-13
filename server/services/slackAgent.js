const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType, TYPE_COLORS } = require('./notificationAgents/types');
const { toPlainText } = require('./messageFormat');
const { resolveAudience, runTargets, skipped, ensureOk, emptyTally, tallySend } = require('./notificationAgents/delivery');

// Slack Block Kit agent for incoming webhooks

class SlackAgent extends BaseAgent {
  constructor() {
    super('slack_agent');
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

  // Map Diskovarr type to Slack emoji
  getTypeEmoji(type) {
    const emojiMap = {
      request_pending: ':hourglass:',
      request_auto_approved: ':white_check_mark:',
      request_approved: ':white_check_mark:',
      request_denied: ':x:',
      request_available: ':clap:',
      request_process_failed: ':warning:',
      issue_new: ':warning:',
      issue_updated: ':wrench:',
      issue_comment_added_admin: ':speech_balloon:',
      issue_comment_added_user: ':speech_balloon:',
    };
    return emojiMap[type] || ':bell:';
  }

  buildPayload(type, payload) {
    const emoji = this.getTypeEmoji(type);
    const title = payload.title || '';
    const body = payload.body || '';

    const blocks = [];

    // Header
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${title}`,
      },
    });

    // Description
    if (body) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: body,
        },
      });
    }

    // URL link
    if (payload.url) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${payload.url}|View in Diskovarr>`,
        },
      });
    }

    // Footer
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '_Sent by Diskovarr_',
        },
      ],
    });

    return {
      text: `${emoji} ${title}`,
      blocks,
    };
  }

  // Admin feed only — Slack has no per-user destination.
  async send(type, payload, ctx) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.webhookUrl) return skipped('Slack disabled');
    if (!this.shouldSendType(type)) return skipped(`type ${type} not selected`);
    if (!resolveAudience(payload, ctx).feed) return skipped('feed copy carried by another queue row');
    const result = await runTargets([{ id: 'feed', send: () => this.deliver(type, payload) }], ctx);
    if (result.error) logger.warn('Slack agent error:', result.error);
    return result;
  }

  async deliver(type, payload) {
    const settings = this.getSettings();
    const body = this.buildPayload(type, payload);
    logger.debug(`Slack: sending webhook to ${settings.webhookUrl}`);
    const res = await fetch(settings.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    await ensureOk(res, 'Slack');
    return true;
  }

  async sendTest(payload) {
    const webhookUrl = payload.webhookUrl;
    if (!webhookUrl) throw new Error('Slack webhook URL required');

    const body = this.buildPayload('test', {
      title: 'Diskovarr Test Notification',
      body: 'Slack notifications are working correctly.',
    });

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`Slack test failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
    return true;
  }

  // Broadcasts bypass the type filter. Returns { attempted, sent, failed }.
  async sendBroadcast(message) {
    const tally = emptyTally();
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.webhookUrl) return tally;
    await tallySend(tally,
      () => this.deliver('broadcast', { title: 'Message from Server Admin', body: toPlainText(message) }),
      (err) => logger.warn('Slack broadcast failed:', err.message));
    return tally;
  }
}

const agent = new SlackAgent();
module.exports = agent;
