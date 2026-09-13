const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');
const { toPlainText } = require('./messageFormat');

// ntfy agent — self-hosted or cloud pub-sub notification service
// Docs: https://ntfy.sh/docs/publish/
//
// Two delivery targets per notification:
//  - the admin topic configured in Admin → Notifications → ntfy
//  - the requesting user's own topic (Settings → Notifications → ntfy), which
//    defaults to the admin's server and credentials unless the user overrides them.

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

function isValidTopic(topic) {
  return typeof topic === 'string' && TOPIC_RE.test(topic);
}

function isValidUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildAuthHeader({ authMethod, token, username, password } = {}) {
  if (authMethod === 'token' && token) {
    return `Bearer ${token}`;
  }
  if (authMethod === 'basic' && username && password) {
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    return `Basic ${encoded}`;
  }
  return null;
}

// Where to publish for a given user, or null when the user is not opted in.
// A user with no server URL of their own publishes to the admin's server; in
// that case the admin's credentials are reused unless the user set their own.
function resolveUserTarget(prefs, adminSettings) {
  if (!prefs || !prefs.ntfy_enabled || !isValidTopic(prefs.ntfy_topic)) return null;
  const ownUrl = prefs.ntfy_url && isValidUrl(prefs.ntfy_url) ? prefs.ntfy_url : null;
  const url = ownUrl || (adminSettings?.url && isValidUrl(adminSettings.url) ? adminSettings.url : null);
  if (!url) return null;
  const userAuth = {
    authMethod: prefs.ntfy_auth_method || 'none',
    token: prefs.ntfy_token,
    username: prefs.ntfy_username,
    password: prefs.ntfy_password,
  };
  const userHeader = buildAuthHeader(userAuth);
  const authHeader = userHeader || (ownUrl ? null : buildAuthHeader(adminSettings));
  return { url, topic: prefs.ntfy_topic, authHeader };
}

class NtfyAgent extends BaseAgent {
  constructor() {
    super('ntfy_agent');
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled);
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

  buildPayload(topic, payload) {
    const settings = this.getSettings() || {};
    const ntfyPayload = {
      topic,
      priority: settings.priority ?? 3,
      title: payload.title || '',
      markdown: true,
    };
    if (payload.body) ntfyPayload.message = payload.body;
    // Attach poster image if configured
    if (settings.embedPoster && payload.posterUrl) {
      ntfyPayload.attach = payload.posterUrl;
    }
    if (payload.url) {
      ntfyPayload.click = payload.url;
    }
    return ntfyPayload;
  }

  buildAuthHeader() {
    return buildAuthHeader(this.getSettings() || {});
  }

  async publish({ url, topic, authHeader }, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (authHeader) headers.Authorization = authHeader;
    logger.debug(`ntfy: sending to ${url} topic=${topic}`);
    const res = await fetch(url.replace(/\/$/, ''), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, topic }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`ntfy ${res.status}: ${await res.text().catch(() => '')}`);
    }
    return true;
  }

  userTarget(userId) {
    if (!userId) return null;
    return resolveUserTarget(db.getUserNotificationPrefs(userId), this.getSettings());
  }

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled) return;

    let sent = 0;
    // Admin topic — filtered by the admin's type list
    if (settings.url && settings.topic && this.shouldSendType(type)) {
      try {
        await this.publish(
          { url: settings.url, topic: settings.topic, authHeader: this.buildAuthHeader() },
          this.buildPayload(settings.topic, payload)
        );
        sent++;
      } catch (err) {
        logger.warn('ntfy agent error:', err.message);
      }
    }

    // The addressed user's own topic — gated by their Settings → Notifications
    // type toggles (applied when the bell notification was created), not the
    // admin's agent type list.
    const target = this.userTarget(payload.userId);
    if (target && !(target.url === settings.url && target.topic === settings.topic)) {
      try {
        await this.publish(target, this.buildPayload(target.topic, payload));
        sent++;
        logger.debug(`ntfy: sent to user ${payload.userId} topic=${target.topic}`);
      } catch (err) {
        logger.warn(`ntfy per-user error (user ${payload.userId}):`, err.message);
      }
    }
    return sent > 0;
  }

  async sendTest(payload) {
    const { url, topic, authMethod, token, username, password, priority } = payload;
    if (!url || !topic) throw new Error('ntfy URL and topic required');
    if (!isValidUrl(url)) throw new Error('ntfy URL must be an http(s) URL');
    if (!isValidTopic(topic)) throw new Error('ntfy topic may only contain letters, numbers, - and _');

    const headers = { 'Content-Type': 'application/json' };
    const authHeader = buildAuthHeader({ authMethod, token, username, password });
    if (authHeader) headers.Authorization = authHeader;

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

  // Test a user's own target with the same fallbacks the real send path uses.
  async sendUserTest(prefs) {
    const target = resolveUserTarget({ ...prefs, ntfy_enabled: true }, this.getSettings());
    if (!target) throw new Error('Enter a valid topic (letters, numbers, - and _) and server URL');
    await this.publish(target, {
      priority: this.getSettings()?.priority ?? 3,
      title: 'Diskovarr Test Notification',
      message: 'ntfy notifications are working correctly.',
      markdown: true,
    });
    return true;
  }

  async sendBroadcast(message) {
    await this.send('broadcast', {
      title: 'Message from Server Admin',
      body: toPlainText(message),
    });
  }
}

const agent = new NtfyAgent();
module.exports = agent;
module.exports.resolveUserTarget = resolveUserTarget;
module.exports.buildAuthHeader = buildAuthHeader;
module.exports.isValidTopic = isValidTopic;
module.exports.isValidUrl = isValidUrl;
