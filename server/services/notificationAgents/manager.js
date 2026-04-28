const db = require('../../db/database');
const logger = require('../logger');
const { hasNotificationType, AgentKey } = require('./types');

// NotificationManager registers agents and dispatches notifications to all active agents.
// Two delivery modes:
//  1. enqueue(type, payload, options) — writes to notification_queue for polling/bundling
//  2. sendImmediate(type, payload)    — sends directly via agents (broadcast, test)

class NotificationManager {
  constructor() {
    this.agents = new Map(); // key: AgentKey → agent instance
  }

  // Register an agent instance
  register(key, agent) {
    this.agents.set(key, agent);
    logger.info(`Notification agent registered: ${key}`);
  }

  // Get registered agent by key
  getAgent(key) {
    return this.agents.get(key) || null;
  }

  // Get all active agents (enabled and configured)
  getActiveAgents() {
    const active = [];
    for (const [key, agent] of this.agents) {
      if (agent.shouldSend()) {
        active.push({ key, agent });
      }
    }
    return active;
  }

  // Enqueue a notification for the polling queue (with bundling).
  // This is the primary path for request/issue notifications.
  enqueue(notificationId, agentKey, userId, payload, sendAfter) {
    const agent = this.agents.get(agentKey);
    if (!agent) {
      logger.warn(`NotificationManager: unknown agent "${agentKey}", enqueueing without agent check`);
    }

    db.enqueueNotification({
      notificationId,
      agent: agentKey,
      userId,
      payload,
      sendAfter,
    });
  }

  // Send a notification immediately to all active agents (bypasses queue).
  // Used for: test notifications, broadcasts.
  sendImmediate(type, payload) {
    const promises = [];
    for (const { key, agent } of this.getActiveAgents()) {
      if (agent.shouldSendType(type)) {
        promises.push(
          agent.send(type, payload).catch((err) => {
            logger.warn(`NotificationManager: immediate send failed for ${key}:`, err.message);
          })
        );
      }
    }
    return Promise.all(promises);
  }

  // Send test notification to a specific agent
  sendTest(agentKey, payload) {
    const agent = this.agents.get(agentKey);
    if (!agent) {
      throw new Error(`Unknown notification agent: ${agentKey}`);
    }
    return agent.sendTest(payload);
  }

  // Broadcast to all agents
  sendBroadcast(message) {
    const promises = [];
    for (const { key, agent } of this.getActiveAgents()) {
      promises.push(
        agent.sendBroadcast(message).catch((err) => {
          logger.warn(`NotificationManager: broadcast failed for ${key}:`, err.message);
        })
      );
    }
    return Promise.all(promises);
  }

  // Get all registered agent keys
  getRegisteredKeys() {
    return [...this.agents.keys()];
  }
}

// Singleton
const manager = new NotificationManager();

module.exports = manager;
