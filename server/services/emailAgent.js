const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');
const { toPlainText } = require('./messageFormat');
const { resolveAudience, runTargets, skipped, emptyTally, tallySend } = require('./notificationAgents/delivery');
const nodemailer = require('nodemailer');

// Email agent — SMTP with optional PGP encryption
// Supports templates, sender name, TLS options

// Everything that shapes the SMTP connection. The cached transport is reused
// only while all of these are unchanged, so a saved host/port/TLS/auth change
// takes effect on the very next send.
function connectionConfig(settings) {
  const config = {
    host: settings.smtpHost,
    port: Number(settings.smtpPort) || 587,
    secure: !!settings.secure, // true for port 465
    requireTLS: !!settings.requireTls,
    ignoreTLS: !!settings.ignoreTls,
    tls: {
      rejectUnauthorized: !settings.allowSelfSigned,
      // Allow all ciphers for maximum compatibility
      ciphers: 'ALL',
    },
    // Fail fast instead of nodemailer's minutes-long defaults so one dead
    // server can't stall the notification worker.
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  };
  // Auth
  if (settings.authUser || settings.authPass) {
    config.auth = {
      user: settings.authUser || '',
      pass: settings.authPass || '',
    };
  }
  return config;
}

class EmailAgent extends BaseAgent {
  constructor() {
    super('email_agent');
    this._transporter = null;
    this._fingerprint = null;
  }

  shouldSend() {
    const settings = this.getSettings();
    return !!(settings && settings.enabled && settings.smtpHost && settings.smtpPort && settings.emailFrom);
  }

  shouldSendType(diskovarrType) {
    const settings = this.getSettings();
    if (!settings) return false;
    const types = settings.notificationTypes || [];
    return hasNotificationType(types, diskovarrType);
  }

  // A fresh transport for the given settings (used directly by Send Test, so
  // unsaved test settings never touch the shared transport).
  buildTransport(settings) {
    return nodemailer.createTransport(connectionConfig(settings));
  }

  // Shared transport for the saved settings, rebuilt whenever the connection
  // fingerprint changes.
  getTransporter() {
    const settings = this.getSettings();
    if (!settings || !settings.smtpHost) return null;
    const fingerprint = JSON.stringify(connectionConfig(settings));
    if (this._transporter && this._fingerprint === fingerprint) return this._transporter;

    try {
      const previous = this._transporter;
      this._transporter = this.buildTransport(settings);
      this._fingerprint = fingerprint;
      if (previous && typeof previous.close === 'function') {
        try { previous.close(); } catch { /* already closed */ }
      }
      return this._transporter;
    } catch (err) {
      logger.warn('Email: failed to create transporter:', err.message);
      return null;
    }
  }

  // Build HTML email template
  buildHTML(payload, settings = this.getSettings() || {}) {
    const senderName = settings.senderName || 'Diskovarr';
    const title = payload.title || '';
    const body = payload.body || '';
    const posterUrl = payload.posterUrl || '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; margin: 0; padding: 20px; }
    .container { max-width: 500px; margin: 0 auto; background: #16213e; border-radius: 12px; overflow: hidden; }
    .header { background: #0f3460; padding: 20px; text-align: center; }
    .header h2 { margin: 0; color: #e94560; }
    .content { padding: 20px; }
    .content h3 { margin: 0 0 10px; color: #e0e0e0; }
    .content p { margin: 0; line-height: 1.5; color: #b0b0b0; }
    .poster { text-align: center; margin: 15px 0; }
    .poster img { max-width: 200px; border-radius: 8px; }
    .footer { text-align: center; padding: 15px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>${this.escapeHtml(senderName)}</h2>
    </div>
    <div class="content">
      <h3>${this.escapeHtml(title)}</h3>
      ${body ? `<p>${this.escapeHtml(body)}</p>` : ''}
      ${posterUrl ? `<div class="poster"><img src="${this.escapeHtml(posterUrl)}" alt="Poster" /></div>` : ''}
      ${payload.url ? `<div style="text-align:center;margin-top:16px;"><a href="${this.escapeHtml(payload.url)}" style="display:inline-block;padding:8px 20px;background:#e94560;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">View in Diskovarr</a></div>` : ''}
    </div>
    <div class="footer">
      <p>Sent by ${this.escapeHtml(senderName)}</p>
    </div>
  </div>
</body>
</html>`;
  }

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Throws on failure (nodemailer errors carry responseCode/code for retry
  // classification).
  async sendToEmail(to, name, payload) {
    const settings = this.getSettings();
    const transporter = this.getTransporter();
    if (!transporter) throw new Error('SMTP is not configured');
    if (!to) throw new Error('No recipient address');

    const mailOptions = {
      from: `"${settings.senderName || 'Diskovarr'}" <${settings.emailFrom}>`,
      to: to,
      subject: payload.title || 'Diskovarr Notification',
      html: this.buildHTML(payload, settings),
      text: `${payload.title || ''}\n\n${payload.body || ''}`,
    };

    // PGP encryption if user has a key
    if (settings.pgpPrivateKey && settings.pgpPassword) {
      // For now, skip PGP — it's complex and requires pgp library
      // This would need the 'mailchecker' or 'openpgp' library
      logger.debug('Email: PGP configured but not yet implemented for encryption');
    }

    await transporter.sendMail(mailOptions);
    return true;
  }

  // Personal only: the recipient's own address from their notification
  // settings, when they opted in. Email has no admin feed.
  async send(type, payload, ctx) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled) return skipped('Email disabled');
    if (!this.shouldSendType(type)) return skipped(`type ${type} not selected`);
    const { recipientId } = resolveAudience(payload, ctx);
    const targets = [];
    if (recipientId) {
      const prefs = db.getUserNotificationPrefs(recipientId);
      if (prefs?.email_enabled && prefs.email_address) {
        const user = db.getKnownUsers().find((u) => u.user_id === recipientId);
        targets.push({ id: 'user', send: () => this.sendToEmail(prefs.email_address, user?.username || '', payload) });
      }
    }
    const result = await runTargets(targets, ctx);
    if (result.error) logger.warn('Email agent error:', result.error);
    return result;
  }

  // Tests exactly the submitted (possibly unsaved) connection on its own
  // transport; the shared transport and queued mail are left alone.
  async sendTest(payload) {
    const settings = {
      smtpHost: payload.smtpHost,
      smtpPort: payload.smtpPort || 587,
      secure: !!payload.secure,
      allowSelfSigned: !!payload.allowSelfSigned,
      requireTls: !!payload.requireTls,
      ignoreTls: !!payload.ignoreTls,
      authUser: payload.authUser || '',
      authPass: payload.authPass || '',
      emailFrom: payload.emailFrom,
      senderName: payload.senderName || 'Diskovarr',
    };
    if (!settings.smtpHost) throw new Error('SMTP host required');
    if (!settings.emailFrom) throw new Error('Sender address required');

    const transporter = this.buildTransport(settings);
    try {
      await transporter.sendMail({
        from: `"${settings.senderName}" <${settings.emailFrom}>`,
        to: settings.emailFrom, // Send to same address as from
        subject: 'Diskovarr Test Notification',
        html: this.buildHTML({
          title: 'Diskovarr Test Notification',
          body: 'Email notifications are working correctly.',
          posterUrl: '',
        }, settings),
        text: 'Diskovarr Test Notification\n\nEmail notifications are working correctly.',
      });
      return true;
    } finally {
      if (typeof transporter.close === 'function') {
        try { transporter.close(); } catch { /* already closed */ }
      }
    }
  }

  // Same addressing as regular delivery: each user's own notification address,
  // only when they enabled email. Returns { attempted, sent, failed }.
  async sendBroadcast(message) {
    const tally = emptyTally();
    const settings = this.getSettings();
    if (!settings || !settings.enabled) return tally;

    const payload = {
      title: 'Message from Server Admin',
      body: toPlainText(message),
    };

    const seen = new Set();
    for (const user of db.getKnownUsers()) {
      const prefs = db.getUserNotificationPrefs(user.user_id);
      const address = prefs?.email_enabled ? prefs.email_address : null;
      if (!address || seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      await tallySend(tally,
        () => this.sendToEmail(address, user.username || '', payload),
        (err) => logger.warn(`Email broadcast to user ${user.user_id} failed:`, err.message));
    }
    return tally;
  }
}

const agent = new EmailAgent();
module.exports = agent;
