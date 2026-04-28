const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');

// Telegram agent — Bot API for messaging
// Docs: https://core.telegram.org/bots/api

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
    return String(text).replace(/([_\-*+./&)([\]{}|>~`#])/g, '\\$1');
  }

  buildMessage(type, payload) {
    const title = payload.title || '';
    const body = payload.body || '';

    let message = `*${this.escapeText(title)}*`;
    if (body) {
      message += `\n${this.escapeText(body)}`;
    }
    message += `\n\n_/Diskovarr/`;

    return message;
  }

  async sendToChat(chatId, message, threadId, silent, posterUrl, url) {
    const settings = this.getSettings();
    if (!settings || !settings.botAPI) return false;

    const embedPoster = settings.embedPoster && posterUrl;
    const endpoint = `${this.baseUrl}/bot${settings.botAPI}/${embedPoster ? 'sendPhoto' : 'sendMessage'}`;

    const body = {
      chat_id: chatId,
      parse_mode: 'MarkdownV2',
      disable_notification: !!silent,
    };

    if (threadId) {
      body.message_thread_id = threadId;
    }

    if (embedPoster && posterUrl) {
      body.photo = posterUrl;
      body.caption = message;
    } else {
      body.text = message;
    }

    if (url) {
      body.reply_markup = { inline_keyboard: [[{ text: 'View in Diskovarr', url }]] };
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Telegram API ${res.status}: ${text}`);
    }
    return true;
  }

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.botAPI) return;
    if (!this.shouldSendType(type)) return;

    const message = this.buildMessage(type, payload);
    let sent = 0;

    try {
      // Send to admin chat
      if (settings.chatId) {
        await this.sendToChat(
          settings.chatId,
          message,
          settings.messageThreadId || null,
          settings.sendSilently || false,
          payload.posterUrl || '',
          payload.url || null
        );
        sent++;
        logger.debug(`Telegram: sent to admin chat ${settings.chatId}`);
      }

      // Send to specific user if provided
      if (payload.userId) {
        const prefs = db.getUserNotificationPrefs(payload.userId);
        if (prefs?.telegram_enabled && prefs?.telegram_chat_id) {
          await this.sendToChat(
            prefs.telegram_chat_id,
            message,
            prefs.telegram_message_thread_id || null,
            prefs.telegram_send_silently || false,
            payload.posterUrl || '',
            payload.url || null
          );
          sent++;
          logger.debug(`Telegram: sent to user ${payload.userId} (${prefs.telegram_chat_id})`);
        }
      }
    } catch (err) {
      logger.warn('Telegram agent error:', err.message);
    }

    return sent > 0;
  }

  async sendTest(payload) {
    const { botAPI, chatId, messageThreadId, sendSilently } = payload;
    if (!botAPI) throw new Error('Telegram bot API token required');
    if (!chatId) throw new Error('Telegram chat ID required for test');

    const message = `*Diskovarr Test Notification*\n\nTelegram notifications are working correctly.\n\n_/Diskovarr/`;

    const endpoint = `${this.baseUrl}/bot${botAPI}/sendMessage`;
    const body = {
      chat_id: chatId,
      parse_mode: 'MarkdownV2',
      text: message,
      disable_notification: !!sendSilently,
    };
    if (messageThreadId) {
      body.message_thread_id = messageThreadId;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Telegram test failed (${res.status}): ${text}`);
    }
    return true;
  }

  async sendBroadcast(message) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled || !settings.botAPI) return;

    const broadcastMsg = `*Message from Server Admin*\n\n${this.escapeText(message)}`;

    try {
      // Send to admin chat
      if (settings.chatId) {
        await this.sendToChat(
          settings.chatId,
          broadcastMsg,
          settings.messageThreadId || null,
          false
        );
        logger.debug(`Telegram broadcast: sent to admin chat`);
      }

      // Send to all users with Telegram configured
      const users = db.getKnownUsers();
      for (const user of users) {
        const prefs = db.getUserNotificationPrefs(user.user_id);
        if (prefs?.telegram_enabled && prefs?.telegram_chat_id) {
          await this.sendToChat(
            prefs.telegram_chat_id,
            broadcastMsg,
            prefs.telegram_message_thread_id || null,
            prefs.telegram_send_silently || false
          ).catch((err) => {
            logger.warn(`Telegram broadcast to ${prefs.telegram_chat_id} failed:`, err.message);
          });
        }
      }
    } catch (err) {
      logger.warn('Telegram broadcast error:', err.message);
    }
  }
}

const agent = new TelegramAgent();
module.exports = agent;
