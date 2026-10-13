const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');
const { toPlainText } = require('./messageFormat');
const { resolveAudience, runTargets, skipped, httpError, emptyTally, tallySend } = require('./notificationAgents/delivery');

// Telegram agent — Bot API for messaging
// Docs: https://core.telegram.org/bots/api

// Every character MarkdownV2 reserves outside entities; each must be escaped
// with a backslash in plain text, and the backslash itself too.
// https://core.telegram.org/bots/api#markdownv2-style
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;
// Telegram rejects longer text (4096) and captions (1024); trim the raw body
// before escaping so an escape sequence is never cut in half.
const MAX_TEXT_BODY = 3500;
const MAX_CAPTION_BODY = 700;
const FOOTER = '_Diskovarr_';

// Limits count UTF-16 units (as Telegram does); a cut never splits a surrogate pair.
function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

class TelegramAgent extends BaseAgent {
  constructor() {
    super('telegram_agent');
    this.baseUrl = 'https://api.telegram.org';
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled && settings.botAPI);
  }

  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  // Escape Telegram MarkdownV2 special characters
  escapeText(text) {
    if (!text) return '';
    return String(text).replace(MARKDOWN_V2_SPECIAL, '\\$&');
  }

  // *bold title*, escaped body, italic footer. Only the markers added here are
  // unescaped, so entities always balance. `caption` uses the shorter limit.
  buildMessage(type, payload, { caption = false } = {}) {
    const title = truncate(payload.title || '', 200);
    const body = truncate(payload.body || '', caption ? MAX_CAPTION_BODY : MAX_TEXT_BODY);

    let message = `*${this.escapeText(title)}*`;
    if (body) {
      message += `\n${this.escapeText(body)}`;
    }
    message += `\n\n${FOOTER}`;

    return message;
  }

  async postMessage(endpoint, body) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let retryAfter = res.headers?.get?.('retry-after');
      try { retryAfter = JSON.parse(text)?.parameters?.retry_after ?? retryAfter; } catch { /* not JSON */ }
      throw httpError('Telegram API', res.status, text, retryAfter);
    }
    return true;
  }

  // `payload` is the raw notification ({ title, body }) or a prebuilt message string.
  async sendToChat(chatId, payload, threadId, silent, posterUrl, url) {
    const settings = this.getSettings();
    if (!settings || !settings.botAPI) return false;

    const embedPoster = !!(settings.embedPoster && posterUrl);
    const endpoint = `${this.baseUrl}/bot${settings.botAPI}/${embedPoster ? 'sendPhoto' : 'sendMessage'}`;
    const message = typeof payload === 'string' ? payload : this.buildMessage(null, payload, { caption: embedPoster });

    const body = {
      chat_id: chatId,
      parse_mode: 'MarkdownV2',
      disable_notification: !!silent,
    };

    if (threadId) {
      body.message_thread_id = threadId;
    }

    if (embedPoster) {
      body.photo = posterUrl;
      body.caption = message;
    } else {
      body.text = message;
    }

    if (url) {
      body.reply_markup = { inline_keyboard: [[{ text: 'View in Diskovarr', url }]] };
    }

    return this.postMessage(endpoint, body);
  }

  // Feed: the admin chat. Personal: the recipient's own chat.
  async send(type, payload, ctx) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.botAPI) return skipped('Telegram disabled');
    if (!this.shouldSendType(type)) return skipped(`type ${type} not selected`);
    const { recipientId, feed } = resolveAudience(payload, ctx);
    const targets = [];

    if (feed && settings.chatId) {
      targets.push({ id: 'feed', send: () => this.sendToChat(
        settings.chatId, payload, settings.messageThreadId || null, settings.sendSilently || false,
        payload.posterUrl || '', payload.url || null,
      ) });
    }
    // A personal chat that is the admin chat gets the event from the feed
    // carrier row, whichever row this is.
    if (recipientId) {
      const prefs = db.getUserNotificationPrefs(recipientId);
      if (prefs?.telegram_enabled && prefs?.telegram_chat_id
        && !(settings.chatId && String(prefs.telegram_chat_id) === String(settings.chatId))) {
        targets.push({ id: 'user', send: () => this.sendToChat(
          prefs.telegram_chat_id, payload, prefs.telegram_message_thread_id || null, prefs.telegram_send_silently || false,
          payload.posterUrl || '', payload.url || null,
        ) });
      }
    }

    const result = await runTargets(targets, ctx);
    if (result.error) logger.warn('Telegram agent error:', result.error);
    return result;
  }

  async sendTest(payload) {
    const { botAPI, chatId, messageThreadId, sendSilently } = payload;
    if (!botAPI) throw new Error('Telegram bot API token required');
    if (!chatId) throw new Error('Telegram chat ID required for test');

    const message = this.buildMessage('test', {
      title: 'Diskovarr Test Notification',
      body: 'Telegram notifications are working correctly.',
    });

    const body = {
      chat_id: chatId,
      parse_mode: 'MarkdownV2',
      text: message,
      disable_notification: !!sendSilently,
    };
    if (messageThreadId) {
      body.message_thread_id = messageThreadId;
    }

    try {
      return await this.postMessage(`${this.baseUrl}/bot${botAPI}/sendMessage`, body);
    } catch (err) {
      throw new Error(`Telegram test failed (${err.status || 'network'}): ${err.message}`);
    }
  }

  // Returns { attempted, sent, failed }.
  async sendBroadcast(message) {
    const tally = emptyTally();
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.botAPI) return tally;

    const broadcastMsg = this.buildMessage('broadcast', { title: 'Message from Server Admin', body: toPlainText(message) });
    const chats = new Set();

    if (settings.chatId) {
      chats.add(String(settings.chatId));
      await tallySend(tally,
        () => this.sendToChat(settings.chatId, broadcastMsg, settings.messageThreadId || null, false),
        (err) => logger.warn('Telegram broadcast to admin chat failed:', err.message));
    }

    // Send to all users with Telegram configured
    for (const user of db.getKnownUsers()) {
      const prefs = db.getUserNotificationPrefs(user.user_id);
      if (prefs?.telegram_enabled && prefs?.telegram_chat_id && !chats.has(String(prefs.telegram_chat_id))) {
        chats.add(String(prefs.telegram_chat_id));
        await tallySend(tally,
          () => this.sendToChat(prefs.telegram_chat_id, broadcastMsg, prefs.telegram_message_thread_id || null, prefs.telegram_send_silently || false),
          (err) => logger.warn(`Telegram broadcast to ${prefs.telegram_chat_id} failed:`, err.message));
      }
    }
    return tally;
  }
}

const agent = new TelegramAgent();
module.exports = agent;
