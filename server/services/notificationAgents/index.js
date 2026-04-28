const manager = require('./manager');
const BaseAgent = require('./base');
const {
  NotificationType,
  ALL_NOTIFICATION_TYPES,
  TYPE_MAP,
  TYPE_LABELS,
  TYPE_TARGET,
  TYPE_COLORS,
  hasNotificationType,
  typesToBitmask,
  bitmaskToTypes,
  getBitForType,
  AgentKey,
} = require('./types');

// Register all agents
function registerAllAgents() {
  const agents = [
    { key: AgentKey.DISCORD, path: '../discordAgent' },
    { key: AgentKey.PUSHOVER, path: '../pushoverAgent' },
    { key: AgentKey.WEBHOOK, path: '../webhookAgent' },
    { key: AgentKey.SLACK, path: '../slackAgent' },
    { key: AgentKey.GOTIFY, path: '../gotifyAgent' },
    { key: AgentKey.NTFY, path: '../ntfyAgent' },
    { key: AgentKey.TELEGRAM, path: '../telegramAgent' },
    { key: AgentKey.PUSHBULLET, path: '../pushbulletAgent' },
    { key: AgentKey.EMAIL, path: '../emailAgent' },
    { key: AgentKey.WEBPUSH, path: '../webpushAgent' },
  ];

  for (const { key, path } of agents) {
    try {
      const agent = require(path);
      manager.register(key, agent);
    } catch (err) {
      // Agent may not exist yet or have missing deps — skip
    }
  }
}

registerAllAgents();

module.exports = {
  manager,
  BaseAgent,
  NotificationType,
  ALL_NOTIFICATION_TYPES,
  TYPE_MAP,
  TYPE_LABELS,
  TYPE_TARGET,
  TYPE_COLORS,
  hasNotificationType,
  typesToBitmask,
  bitmaskToTypes,
  getBitForType,
  AgentKey,
};
