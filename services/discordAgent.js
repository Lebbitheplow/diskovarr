const db = require('../db/database');
const logger = require('./logger');

function getConfig() {
  const raw = db.getSetting('discord_agent', null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const TYPE_COLORS = {
  request_pending:       0xe5a00d,
  request_auto_approved: 0xe5a00d,
  request_approved:      0x00c864,
  request_denied:        0xff5252,
  request_available:     0x00b4d8,
  request_process_failed: 0xff5252,
  issue_new:             0xff8c00,
  issue_updated:         0x00b4d8,
};

// ── Webhook mode ───────────────────────────────────────────────────────────────

async function sendWebhookEmbed({ webhookUrl, title, description, color, posterUrl, mentionRole, botUsername, botAvatarUrl }) {
  if (!webhookUrl) return;
  const embed = { title, description, color: color || 0xe5a00d };
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

async function sendNotification({ type, title, body, posterUrl, userId }) {
  const config = getConfig();
  if (!config || !config.enabled) {
    logger.debug('Discord: agent disabled or no config, skipping');
    return;
  }

  const enabledTypes = config.notificationTypes || [];
  if (!enabledTypes.includes(type)) {
    logger.debug(`Discord: type "${type}" not in enabledTypes [${enabledTypes.join(', ')}], skipping`);
    return;
  }

  const embed = {
    title,
    description: body || '',
    color: TYPE_COLORS[type] || 0xe5a00d,
  };
  if (config.embedPoster && posterUrl) embed.image = { url: posterUrl };

  // Resolve avatar URL: explicit URL > publicUrl-derived > none
  const avatarUrl = config.botAvatarUrl || (config.publicUrl ? `${config.publicUrl}/discord-avatar.png` : null);

  if (config.mode === 'bot') {
    // Bot token mode — DM individual users
    if (!config.botToken) {
      logger.debug('Discord: bot mode but no botToken, skipping');
      return;
    }
    const prefs = userId ? db.getUserNotificationPrefs(userId) : null;
    const discordUserId = prefs?.discord_user_id;
    if (!discordUserId || !prefs?.discord_enabled) {
      logger.debug(`Discord: userId=${userId} has no discordUserId or discord_enabled=false, skipping`);
      return;
    }
    try {
      await sendBotDm(discordUserId, embed, config.botToken, config.botUsername);
    } catch (err) {
      logger.warn(`Discord DM to ${discordUserId} failed:`, err.message);
    }
    // Also post admin-type notifications to shared channel webhook if configured
    const adminTypes = ['request_pending', 'request_auto_approved', 'request_process_failed', 'issue_new', 'issue_updated'];
    if (config.botUseWebhook && config.botWebhookUrl && adminTypes.includes(type)) {
      try {
        await sendWebhookEmbed({
          webhookUrl: config.botWebhookUrl,
          title,
          description: body || '',
          color: TYPE_COLORS[type] || 0xe5a00d,
          posterUrl: config.embedPoster ? posterUrl : null,
          botUsername: config.botUsername,
          botAvatarUrl: avatarUrl,
        });
      } catch (err) {
        logger.warn('Discord bot shared-channel webhook error:', err.message);
      }
    }
  } else {
    // Webhook mode — post to global channel
    if (!config.webhookUrl) return;
    try {
      await sendWebhookEmbed({
        webhookUrl: config.webhookUrl,
        title,
        description: body || '',
        color: TYPE_COLORS[type] || 0xe5a00d,
        posterUrl: config.embedPoster ? posterUrl : null,
        mentionRole: config.enableMentions ? config.notificationRoleId : null,
        botUsername: config.botUsername,
        botAvatarUrl: avatarUrl,
      });
    } catch (err) {
      logger.warn('Discord webhook error:', err.message);
    }
    // Per-user personal webhook (webhook mode only)
    if (userId) {
      const prefs = db.getUserNotificationPrefs(userId);
      if (prefs?.discord_enabled && prefs?.discord_webhook && prefs.discord_webhook !== config.webhookUrl) {
        try {
          await sendWebhookEmbed({ webhookUrl: prefs.discord_webhook, title, description: body || '', color: TYPE_COLORS[type] || 0xe5a00d, posterUrl: config.embedPoster ? posterUrl : null, botAvatarUrl: avatarUrl });
        } catch (err) {
          logger.warn('Discord per-user webhook error:', err.message);
        }
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

  if (config.mode === 'bot') {
    if (!config.botToken) return;
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
    if (config.botUseWebhook && config.botWebhookUrl) {
      try {
        await sendWebhookEmbed({ webhookUrl: config.botWebhookUrl, title: embed.title, description: message, color: 0xe5a00d, botUsername: config.botUsername, botAvatarUrl: avatarUrl });
      } catch (err) {
        logger.warn('Discord broadcast webhook error:', err.message);
      }
    }
  } else {
    if (!config.webhookUrl) return;
    try {
      await sendWebhookEmbed({ webhookUrl: config.webhookUrl, title: embed.title, description: message, color: 0xe5a00d, botUsername: config.botUsername, botAvatarUrl: avatarUrl });
    } catch (err) {
      logger.warn('Discord broadcast webhook error:', err.message);
    }
  }
}

module.exports = { sendNotification, sendTest, getConfig, updateBotAvatar, sendBroadcast };
