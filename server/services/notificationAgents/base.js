const db = require('../../db/database');
const logger = require('../logger');
const { hasNotificationType } = require('./types');

// Base class for all notification agents.
// Each agent stores its settings key (e.g., 'discord_agent') and provides
// shouldSend() and send(type, payload) methods.

class BaseAgent {
  constructor(settingsKey) {
    this.settingsKey = settingsKey;
    this._settings = null;
  }

  // Lazy-load settings from DB
  getSettings() {
    if (this._settings) return this._settings;
    try {
      const raw = db.getSetting(this.settingsKey, null);
      if (!raw) return null;
      this._settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return this._settings;
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
  async send(type, payload) {
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
    // Check agent-specific enable flag
    const agentKey = this.settingsKey.replace('_agent', '');
    const agentName = agentKey.replace('_agent', '').includes('discord')
      ? 'discord_enabled'
      : agentKey.replace('_agent', '').includes('pushover')
        ? 'pushover_enabled'
        : agentKey.replace('_agent', '').includes('telegram')
          ? 'telegram_enabled'
          : agentKey.replace('_agent', '').includes('pushbullet')
            ? 'pushbullet_enabled'
            : null;
    if (agentName && prefs[agentName] !== true) return false;
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
