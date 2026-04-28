const db = require('../db/database');
const logger = require('./logger');
const { hasNotificationType } = require('./notificationAgents/types');

function getConfig() {
  const raw = db.getSetting('discord_agent', null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const TYPE_COLORS = {
  request_pending:            0xe5a00d,
  request_auto_approved:      0xe5a00d,
  request_approved:           0x00c864,
  request_denied:             0xff5252,
  request_available:          0x00b4d8,
  request_process_failed:     0xff5252,
  issue_new:                  0xff8c00,
  issue_updated:              0x00b4d8,
  issue_comment_added_admin:  0xff8c00,
  issue_comment_added_user:   0x00b4d8,
};

// ── Webhook mode ───────────────────────────────────────────────────────────────

async function sendWebhookEmbed({ webhookUrl, title, description, color, url, posterUrl, mentionRole, botUsername, botAvatarUrl }) {
  if (!webhookUrl) return;
  const embed = { title, description, color: color || 0xe5a00d };
  if (url) embed.url = url;
  if (posterUrl) embed.thumbnail = { url: posterUrl };
  const payload = { embeds: [embed] };
  if (mentionRole) payload.content = `<@&${mentionRole}>`;
  if (botUsername) payload.username = botUsername;
  if (botAvatarUrl) payload.avatar_url = botAvatarUrl;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text().catch(() => '')}`);
}

// ── Bot / DM mode ──────────────────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';

async function discordRequest(method, path, body, botToken) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Diskovarr (https://github.com/Lebbitheplow/diskovarr, 1)',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403 && text.includes('50007')) {
      throw new Error('Cannot send DM — the bot must share a server with the user (Discord error 50007)');
    }
    throw new Error(`Discord API ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function openDmChannel(discordUserId, botToken) {
  const data = await discordRequest('POST', '/users/@me/channels', { recipient_id: discordUserId }, botToken);
  return data?.id;
}

async function sendBotDm(discordUserId, embed, botToken, botUsername) {
  const channelId = await openDmChannel(discordUserId, botToken);
  if (!channelId) throw new Error('Could not open DM channel');
  const payload = { embeds: [embed] };
  if (botUsername) payload.username = botUsername;
  await discordRequest('POST', `/channels/${channelId}/messages`, payload, botToken);
}

// Update the bot's global avatar. Uses custom uploaded image if set, else auto-generates.
async function updateBotAvatar(botToken, accentHex) {
  try {
    const customDataUri = db.getSetting('discord_avatar_data_uri', null);
    let dataUri;
    if (customDataUri && /^data:image\/(png|jpeg|gif);base64,/.test(customDataUri)) {
      dataUri = customDataUri;
    } else {
      const { generateAvatar } = require('./discordAvatar');
      dataUri = generateAvatar(accentHex).dataUri;
    }
    await discordRequest('PATCH', '/users/@me', { avatar: dataUri }, botToken);
    logger.info('Discord bot avatar updated');
  } catch (err) {
    logger.warn('Discord bot avatar update failed:', err.message);
  }
}

// ── Unified send ───────────────────────────────────────────────────────────────

function _resolveWebhookEnabled(config) {
  // New schema: webhookEnabled field. Backward compat: old mode='webhook' with enabled=true
  if (config.webhookEnabled !== undefined) return !!config.webhookEnabled;
  return config.enabled && config.mode !== 'bot';
}

function _resolveBotEnabled(config) {
  // New schema: botEnabled field. Backward compat: old mode='bot' with enabled=true
  if (config.botEnabled !== undefined) return !!config.botEnabled;
  return config.enabled && config.mode === 'bot';
}

async function sendNotification({ type, title, body, posterUrl, userId, url }) {
  const config = getConfig();
  if (!config || !config.enabled) {
    logger.debug('Discord: agent disabled or no config, skipping');
    return;
  }

  // Backward compat: migrate old single notificationTypes to both webhook/bot types
  const webhookTypes = config.webhookNotificationTypes || config.notificationTypes || [];
  const botTypes = config.botNotificationTypes || config.notificationTypes || [];

  // Resolve per-panel embed poster flags (fall back to shared embedPoster for old configs)
  const webhookEmbedPoster = config.webhookEmbedPoster !== undefined ? config.webhookEmbedPoster : config.embedPoster;
  const botEmbedPoster     = config.botEmbedPoster     !== undefined ? config.botEmbedPoster     : config.embedPoster;

  const embed = {
    title,
    description: body || '',
    color: TYPE_COLORS[type] || 0xe5a00d,
  };
  if (url) embed.url = url;
  if (botEmbedPoster && posterUrl) embed.image = { url: posterUrl };

  // Resolve avatar URL: explicit URL > publicUrl-derived > none
  const avatarUrl = config.botAvatarUrl || (config.publicUrl ? `${config.publicUrl}/discord-avatar.png` : null);

  const webhookEnabled = _resolveWebhookEnabled(config);
  const botEnabled = _resolveBotEnabled(config);

  // Webhook path — independent of bot
  if (webhookEnabled && config.webhookUrl && webhookTypes.includes(type)) {
    try {
      const webhookEmbed = { title, description: body || '', color: TYPE_COLORS[type] || 0xe5a00d };
      if (url) webhookEmbed.url = url;
      await sendWebhookEmbed({
        webhookUrl: config.webhookUrl,
        ...webhookEmbed,
        posterUrl: webhookEmbedPoster ? posterUrl : null,
        mentionRole: config.enableMentions ? config.notificationRoleId : null,
        botUsername: config.botUsername,
        botAvatarUrl: avatarUrl,
      });
    } catch (err) {
      logger.warn('Discord webhook error:', err.message);
    }
    // Per-user personal webhook (webhook path only)
    if (userId) {
      const prefs = db.getUserNotificationPrefs(userId);
      if (prefs?.discord_enabled && prefs?.discord_webhook && prefs.discord_webhook !== config.webhookUrl) {
        try {
          const userEmbed = { title, description: body || '', color: TYPE_COLORS[type] || 0xe5a00d };
          if (url) userEmbed.url = url;
          await sendWebhookEmbed({ webhookUrl: prefs.discord_webhook, ...userEmbed, posterUrl: webhookEmbedPoster ? posterUrl : null, botAvatarUrl: avatarUrl });
        } catch (err) {
          logger.warn('Discord per-user webhook error:', err.message);
        }
      }
    }
  }

  // Bot path — independent of webhook
  if (botEnabled && config.botToken && botTypes.includes(type)) {
    const prefs = userId ? db.getUserNotificationPrefs(userId) : null;
    const discordUserId = prefs?.discord_user_id;
    if (!discordUserId || !prefs?.discord_enabled) {
      logger.debug(`Discord: userId=${userId} has no discordUserId or discord_enabled=false, skipping bot DM`);
    } else {
      try {
        await sendBotDm(discordUserId, embed, config.botToken, config.botUsername);
      } catch (err) {
        logger.warn(`Discord DM to ${discordUserId} failed:`, err.message);
      }
    }
  }
}

// ── Test ───────────────────────────────────────────────────────────────────────

async function sendTest({ mode, webhookUrl, botToken, discordUserId, botUsername }) {
  const embed = {
    title: 'Diskovarr Test Notification',
    description: 'Discord notifications are working correctly.',
    color: 0xe5a00d,
  };
  if (mode === 'bot') {
    if (!botToken) throw new Error('Bot token required');
    if (!discordUserId) throw new Error('Discord user ID required for DM test');
    await sendBotDm(discordUserId, embed, botToken, botUsername);
  } else {
    if (!webhookUrl) throw new Error('Webhook URL required');
    await sendWebhookEmbed({ webhookUrl, title: embed.title, description: embed.description, color: embed.color, botUsername });
  }
}

// ── Broadcast (admin message to all users, bypasses type filter) ───────────────

async function sendBroadcast(message) {
  const config = getConfig();
  if (!config || !config.enabled) return;

  const avatarUrl = config.botAvatarUrl || (config.publicUrl ? `${config.publicUrl}/discord-avatar.png` : null);
  const embed = { title: 'Message from Server Admin', description: message, color: 0xe5a00d };

  const webhookEnabled = _resolveWebhookEnabled(config);
  const botEnabled = _resolveBotEnabled(config);

  if (webhookEnabled && config.webhookUrl) {
    try {
      await sendWebhookEmbed({ webhookUrl: config.webhookUrl, title: embed.title, description: message, color: 0xe5a00d, botUsername: config.botUsername, botAvatarUrl: avatarUrl });
    } catch (err) {
      logger.warn('Discord broadcast webhook error:', err.message);
    }
  }

  if (botEnabled && config.botToken) {
    const users = db.getKnownUsers();
    for (const user of users) {
      const prefs = db.getUserNotificationPrefs(user.user_id);
      if (prefs?.discord_user_id && prefs?.discord_enabled) {
        try {
          await sendBotDm(prefs.discord_user_id, embed, config.botToken, config.botUsername);
        } catch (err) {
          logger.warn(`Discord broadcast DM to ${prefs.discord_user_id} failed:`, err.message);
        }
      }
    }
  }
}

// ── Manager compatibility layer ───────────────────────────────────────────────

function shouldSend() {
  const config = getConfig();
  return !!(config && config.enabled);
}

function shouldSendType(diskovarrType) {
  const config = getConfig();
  if (!config || !config.enabled) return false;
  const webhookTypes = config.webhookNotificationTypes || config.notificationTypes || [];
  const botTypes = config.botNotificationTypes || config.notificationTypes || [];
  // Check both webhook and bot types
  return webhookTypes.includes(diskovarrType) || botTypes.includes(diskovarrType);
}

// Manager interface: send(type, payload)
async function sendForManager(type, payload) {
  return sendNotification({ type, title: payload.title, body: payload.body, posterUrl: payload.posterUrl, userId: payload.userId, url: payload.url });
}

module.exports = {
  sendNotification,
  sendTest,
  getConfig,
  updateBotAvatar,
  sendBroadcast,
  // Manager interface
  settingsKey: 'discord_agent',
  shouldSend,
  shouldSendType,
  send: sendForManager,
};
