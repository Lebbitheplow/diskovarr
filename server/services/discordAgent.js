const db = require('../db/database');
const logger = require('./logger');
const { forDiscord } = require('./messageFormat');
const { hasNotificationType } = require('./notificationAgents/types');
const { resolveAudience, runTargets, skipped, ensureOk, httpError, permanentError, emptyTally, tallySend } = require('./notificationAgents/delivery');
const { isDiscordWebhookUrl } = require('./notificationAgents/destinations');

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

// `personal` marks a user-supplied webhook: it must be a Discord webhook URL
// (checked again here, not only at save time) and redirects are refused.
async function sendWebhookEmbed({ webhookUrl, title, description, color, url, posterUrl, mentionRole, botUsername, botAvatarUrl, personal = false }) {
  if (!webhookUrl) return;
  if (personal && !isDiscordWebhookUrl(webhookUrl)) {
    throw permanentError('Personal webhook is not a Discord webhook URL');
  }
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
    ...(personal ? { redirect: 'error' } : {}),
  });
  await ensureOk(res, 'Discord webhook');
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
      throw permanentError('Cannot send DM — the bot must share a server with the user (Discord error 50007)');
    }
    let retryAfter = res.headers?.get?.('retry-after');
    if (res.status === 429) { try { retryAfter = JSON.parse(text).retry_after ?? retryAfter; } catch { /* keep header */ } }
    throw httpError('Discord API', res.status, text, retryAfter);
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

// Feed: the channel webhook. Personal: the recipient's own webhook and bot DM.
// Returns a DeliveryResult (see notificationAgents/delivery.js).
async function sendNotification({ type, title, body, posterUrl, userId, url }, ctx) {
  const config = getConfig();
  if (!config || !config.enabled) {
    logger.debug('Discord: agent disabled or no config, skipping');
    return skipped('Discord disabled');
  }
  const { recipientId, feed } = resolveAudience({ userId }, ctx);

  // Backward compat: migrate old single notificationTypes to both webhook/bot types
  const webhookTypes = config.webhookNotificationTypes || config.notificationTypes || [];
  const botTypes = config.botNotificationTypes || config.notificationTypes || [];

  // Resolve per-panel embed poster flags (fall back to shared embedPoster for old configs)
  const webhookEmbedPoster = config.webhookEmbedPoster !== undefined ? config.webhookEmbedPoster : config.embedPoster;
  const botEmbedPoster     = config.botEmbedPoster     !== undefined ? config.botEmbedPoster     : config.embedPoster;

  const color = TYPE_COLORS[type] || 0xe5a00d;
  const embed = { title, description: body || '', color };
  if (url) embed.url = url;
  if (botEmbedPoster && posterUrl) embed.image = { url: posterUrl };

  // Resolve avatar URL: explicit URL > publicUrl-derived > none
  const avatarUrl = config.botAvatarUrl || (config.publicUrl ? `${config.publicUrl}/discord-avatar.png` : null);
  const prefs = recipientId ? db.getUserNotificationPrefs(recipientId) : null;
  const targets = [];

  // Webhook path — independent of bot
  if (_resolveWebhookEnabled(config) && config.webhookUrl && hasNotificationType(webhookTypes, type)) {
    const webhookEmbed = { title, description: body || '', color, ...(url ? { url } : {}) };
    if (feed) {
      targets.push({ id: 'feed', send: () => sendWebhookEmbed({
        webhookUrl: config.webhookUrl,
        ...webhookEmbed,
        posterUrl: webhookEmbedPoster ? posterUrl : null,
        mentionRole: config.enableMentions ? config.notificationRoleId : null,
        botUsername: config.botUsername,
        botAvatarUrl: avatarUrl,
      }) });
    }
    // Per-user personal webhook (webhook path only)
    if (prefs?.discord_enabled && prefs?.discord_webhook && prefs.discord_webhook !== config.webhookUrl) {
      targets.push({ id: 'user_webhook', send: () => sendWebhookEmbed({
        webhookUrl: prefs.discord_webhook, ...webhookEmbed,
        posterUrl: webhookEmbedPoster ? posterUrl : null, botAvatarUrl: avatarUrl, personal: true,
      }) });
    }
  }

  // Bot path — independent of webhook
  if (_resolveBotEnabled(config) && config.botToken && hasNotificationType(botTypes, type)) {
    const discordUserId = prefs?.discord_user_id;
    if (!discordUserId || !prefs?.discord_enabled) {
      logger.debug(`Discord: userId=${recipientId} has no discordUserId or discord_enabled=false, skipping bot DM`);
    } else {
      targets.push({ id: 'user_dm', send: () => sendBotDm(discordUserId, embed, config.botToken, config.botUsername) });
    }
  }

  const result = await runTargets(targets, ctx);
  if (result.error) logger.warn(`Discord delivery (${type}) problem: ${result.error}`);
  return result;
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

// Returns { attempted, sent, failed } across the channel webhook and bot DMs.
async function sendBroadcast(message) {
  const tally = emptyTally();
  const config = getConfig();
  if (!config || !config.enabled) return tally;
  message = forDiscord(message);

  const avatarUrl = config.botAvatarUrl || (config.publicUrl ? `${config.publicUrl}/discord-avatar.png` : null);
  const embed = { title: 'Message from Server Admin', description: message, color: 0xe5a00d };

  if (_resolveWebhookEnabled(config) && config.webhookUrl) {
    await tallySend(tally,
      () => sendWebhookEmbed({ webhookUrl: config.webhookUrl, title: embed.title, description: message, color: 0xe5a00d, botUsername: config.botUsername, botAvatarUrl: avatarUrl }),
      (err) => logger.warn('Discord broadcast webhook error:', err.message));
  }

  if (_resolveBotEnabled(config) && config.botToken) {
    for (const user of db.getKnownUsers()) {
      const prefs = db.getUserNotificationPrefs(user.user_id);
      if (prefs?.discord_user_id && prefs?.discord_enabled) {
        await tallySend(tally,
          () => sendBotDm(prefs.discord_user_id, embed, config.botToken, config.botUsername),
          (err) => logger.warn(`Discord broadcast DM to ${prefs.discord_user_id} failed:`, err.message));
      }
    }
  }
  return tally;
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
  return hasNotificationType(webhookTypes, diskovarrType) || hasNotificationType(botTypes, diskovarrType);
}

// Manager interface: send(type, payload, ctx)
async function sendForManager(type, payload, ctx) {
  return sendNotification({ type, title: payload.title, body: payload.body, posterUrl: payload.posterUrl, userId: payload.userId, url: payload.url }, ctx);
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
