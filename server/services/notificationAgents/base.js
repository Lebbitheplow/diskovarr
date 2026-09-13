const db = require('../../db/database');
const { hasNotificationType } = require('./types');

// Base class for all notification agents.
// Each agent stores its settings key (e.g., 'discord_agent') and provides
// shouldSend() and send(type, payload) methods.

// Per-user "channel enabled" pref column for agents that can target a user.
const USER_ENABLED_FLAG = {
  discord_agent: 'discord_enabled',
  pushover_agent: 'pushover_enabled',
  telegram_agent: 'telegram_enabled',
  pushbullet_agent: 'pushbullet_enabled',
  email_agent: 'email_enabled',
  webpush_agent: 'webpush_enabled',
};

class BaseAgent {
  constructor(settingsKey) {
    this.settingsKey = settingsKey;
  }

  // Always read from the DB: the admin can change agent settings at runtime
  // and a process-lifetime cache left agents sending with stale config (or
  // never becoming "active") until the next restart.
  getSettings() {
    try {
      const raw = db.getSetting(this.settingsKey, null);
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  // Check if this agent is properly configured to send notifications
  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled);
  }

  // Check if the agent's configured types include the given Diskovarr type
  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || settings.webhookNotificationTypes || settings.botNotificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  // Main send method — subclasses implement this
  async send(_type, _payload) {
    throw new Error(`${this.constructor.name}.send() not implemented`);
  }

  // Test notification — subclasses can override for custom behavior
  async sendTest(payload) {
    return this.send('test', payload);
  }

  // Broadcast to all configured targets — subclasses can override
  async sendBroadcast(message) {
    return this.send('broadcast', { body: message });
  }

  // Check per-user preferences for this agent
  shouldSendToUser(userId, diskovarrType) {
    if (!userId) return false;
    const prefs = db.getUserNotificationPrefs(userId);
    if (!prefs) return false;
    const flag = USER_ENABLED_FLAG[this.settingsKey];
    if (flag && prefs[flag] !== true) return false;
    // Check per-type filter
    const userTypes = prefs.agentTypes?.[diskovarrType];
    return userTypes !== false;
  }

  // Get per-user settings for this agent
  getUserTarget(userId) {
    if (!userId) return null;
    return db.getUserNotificationPrefs(userId);
  }
}

module.exports = BaseAgent;
module.exports.USER_ENABLED_FLAG = USER_ENABLED_FLAG;
