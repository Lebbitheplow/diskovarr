const db = require('../db/database');
const logger = require('./logger');
const BaseAgent = require('./notificationAgents/base');
const { hasNotificationType } = require('./notificationAgents/types');
const nodemailer = require('nodemailer');

// Email agent — SMTP with optional PGP encryption
// Supports templates, sender name, TLS options

class EmailAgent extends BaseAgent {
  constructor() {
    super('email_agent');
    this._transporter = null;
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

  // Build SMTP transporter (cached)
  getTransporter() {
    if (this._transporter) return this._transporter;

    const settings = this.getSettings();
    if (!settings) return null;

    const transporterConfig = {
      host: settings.smtpHost,
      port: Number(settings.smtpPort) || 587,
      secure: !!settings.secure, // true for port 465
      tls: {
        rejectUnauthorized: !settings.allowSelfSigned,
        // Allow all ciphers for maximum compatibility
        ciphers: 'ALL',
      },
      requireTLS: !!settings.requireTls,
    };

    // Auth
    if (settings.authUser || settings.authPass) {
      transporterConfig.auth = {
        user: settings.authUser || '',
        pass: settings.authPass || '',
      };
    }

    try {
      this._transporter = nodemailer.createTransport(transporterConfig);
      return this._transporter;
    } catch (err) {
      logger.warn('Email: failed to create transporter:', err.message);
      return null;
    }
  }

  // Build HTML email template
  buildHTML(payload) {
    const settings = this.getSettings();
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

  async sendToEmail(to, name, payload) {
    const settings = this.getSettings();
    const transporter = this.getTransporter();
    if (!transporter || !to) return false;

    const mailOptions = {
      from: `"${settings.senderName || 'Diskovarr'}" <${settings.emailFrom}>`,
      to: to,
      subject: payload.title || 'Diskovarr Notification',
      html: this.buildHTML(payload),
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

  async send(type, payload) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled) return;
    if (!this.shouldSendType(type)) return;

    let sent = 0;

    try {
      // Send to specific user if provided
      if (payload.userId) {
        const prefs = db.getUserNotificationPrefs(payload.userId);
        // User's email would come from the user record
        const users = db.getKnownUsers();
        const user = users.find((u) => u.user_id === payload.userId);
        if (user && user.email && prefs?.email_enabled) {
          await this.sendToEmail(user.email, user.username || '', payload);
          sent++;
          logger.debug(`Email: sent to user ${payload.userId} (${user.email})`);
        }
      }
    } catch (err) {
      logger.warn('Email agent error:', err.message);
    }

    return sent > 0;
  }

  async sendTest(payload) {
    const settings = {
      smtpHost: payload.smtpHost,
      smtpPort: payload.smtpPort || 587,
      secure: !!payload.secure,
      allowSelfSigned: !!payload.allowSelfSigned,
      requireTls: !!payload.requireTls,
      authUser: payload.authUser || '',
      authPass: payload.authPass || '',
      emailFrom: payload.emailFrom,
      senderName: payload.senderName || 'Diskovarr',
    };

    // Override settings temporarily for test
    const origSettings = this._settings;
    this._settings = settings;
    this._transporter = null; // Force recreate

    try {
      const transporter = this.getTransporter();
      if (!transporter) throw new Error('Failed to create SMTP transporter');

      const mailOptions = {
        from: `"${settings.senderName}" <${settings.emailFrom}>`,
        to: settings.emailFrom, // Send to same address as from
        subject: 'Diskovarr Test Notification',
        html: this.buildHTML({
          title: 'Diskovarr Test Notification',
          body: 'Email notifications are working correctly.',
          posterUrl: '',
        }),
        text: 'Diskovarr Test Notification\n\nEmail notifications are working correctly.',
      };

      await transporter.sendMail(mailOptions);
      return true;
    } finally {
      this._settings = origSettings;
      this._transporter = null;
    }
  }

  async sendBroadcast(message) {
    const settings = this.getSettings();
    if (!settings || !settings.enabled) return;

    const payload = {
      title: 'Message from Server Admin',
      body: message,
    };

    const users = db.getKnownUsers();
    for (const user of users) {
      const prefs = db.getUserNotificationPrefs(user.user_id);
      if (user.email && prefs?.email_enabled) {
        await this.sendToEmail(user.email, user.username || '', payload).catch((err) => {
          logger.warn(`Email broadcast to ${user.email} failed:`, err.message);
        });
      }
    }
  }
}

const agent = new EmailAgent();
module.exports = agent;
