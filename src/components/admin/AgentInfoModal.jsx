import React from 'react'
import { useTranslation } from 'react-i18next'

function AgentInfoModal({ agent, onClose }) {
  const { t } = useTranslation()
  if (!agent) return null

  const modals = {
    discord: (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            background: 'var(--bg-secondary)',
            borderRadius: 14,
            padding: 28,
            width: 'min(560px, 92vw)',
            border: '1px solid var(--border)',
            position: 'relative',
            maxHeight: '88vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 14,
              right: 16,
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 20,
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title={t('Close')}
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Configuring Discord Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Mode: Webhook (shared channel)</p>
              <p style={{ margin: '0 0 6px' }}>{t('All notifications go to a single Discord channel. Users can optionally add their own personal webhook for private-channel delivery.')}</p>
              <p style={{ fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 2px' }}>{t('Setup:')}</p>
              <p style={{ margin: 0 }}>{t('In your Discord server →')} <strong>{t('Server Settings → Integrations → Webhooks')}</strong> → <em>{t('New Webhook')}</em> {t('→ pick a channel → copy the URL. Paste it in the Webhook URL field above.')}</p>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Mode: Bot Token (individual DMs)</p>
              <p style={{ margin: '0 0 6px' }}>{t('The bot sends each user a personal DM. Each user enters their Discord User ID in their profile settings.')}</p>
              <p style={{ fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 2px' }}>{t('Setup:')}</p>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>{t('Go to')} <strong>{t('discord.com/developers/applications')}</strong> → <em>{t('New Application')}</em></li>
                <li>{t('Open the')} <strong>{t('Bot')}</strong> {t('tab →')} <em>{t('Add Bot')}</em> {t('→ copy the')} <strong>{t('Token')}</strong></li>
                <li>{t('Enable')} <strong>{t('Message Content Intent')}</strong> {t('on the Bot tab')}</li>
                <li>{t('Invite the bot to your server: OAuth2 → URL Generator → scope:')} <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{t('bot')}</code>{t(', permission:')} <em>{t('Send Messages')}</em></li>
                <li>Each user finds their Discord User ID (Developer Mode → right-click profile → Copy User ID) and enters it in their Diskovarr settings</li>
              </ol>
              <p style={{ margin: '8px 0 0' }}><strong>{t('Admin channel toggle')}</strong> — enable "Also post admin notifications to shared channel" to mirror admin-type alerts (pending requests, errors) to a shared Discord channel webhook alongside the bot DMs.</p>
              <p style={{ margin: '6px 0 0' }}><strong>{t('Server Invite Link')}</strong> — set a non-expiring Discord invite link; users will see a "Join Server" prompt in their settings page so they can join your server before the bot can DM them.</p>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 10 }}>
                <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Finding your Discord User ID (to test DMs)</p>
                <p style={{ margin: '0 0 6px' }}>{t('The User ID is a')} <strong>{t('17–19 digit number')}</strong> — not your username (e.g. <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>185234567891234560</code>).</p>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  <li>{t('In Discord, open')} <strong>{t('Settings → Advanced')}</strong> {t('and enable')} <strong>{t('Developer Mode')}</strong></li>
                  <li>Find any message you've sent, then <strong>{t('right-click your avatar or username')}</strong> {t('on that message')}</li>
                  <li>{t('Click')} <strong>{t('Copy User ID')}</strong> {t('from the context menu')}</li>
                  <li>{t('Paste the numeric ID into your Diskovarr')} <strong>{t('Notification Settings')}</strong> {t('page and save')}</li>
                </ol>
                <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)' }}><strong>{t('Note:')}</strong> {t('The bot must be in a Discord server that you are also a member of — it cannot DM users with no mutual server.')}</p>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 8 }}>
                  <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Inviting the bot to your server')}</p>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    <li>{t('Go to')} <strong>{t('discord.com/developers/applications')}</strong> {t('→ select your app')}</li>
                    <li>{t('Open')} <strong>{t('OAuth2 → URL Generator')}</strong></li>
                    <li>{t('Under')} <strong>{t('Scopes')}</strong> {t('check')} <code style={{ fontSize: '0.78rem', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>{t('bot')}</code></li>
                    <li>{t('Under')} <strong>{t('Bot Permissions')}</strong> {t('check')} <em>{t('Send Messages')}</em></li>
                    <li>{t('Copy the generated URL, open it in your browser, and add the bot to your server')}</li>
                  </ol>
                </div>
              </div>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Bot avatar')}</p>
              <p style={{ margin: 0 }}>Leave the Avatar URL blank and Diskovarr will automatically set the bot's avatar to the Diskovarr logo in your server's accent colour. Or supply a custom image URL to override it. The <strong>{t('App Public URL')}</strong> (set in General Settings) must be configured for the auto-generated avatar endpoint to work.</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Notification types')}</p>
              <p style={{ margin: 0 }}><strong>{t('New request pending / Auto-approved')}</strong> {t('— admin alerts for incoming requests.')} <strong>{t('Approved / Denied')}</strong> {t('— notify the requester when an admin acts.')} <strong>{t('Available')}</strong> {t('— notify when content appears in Plex.')} <strong>{t('Request processing error')}</strong> {t('— admin alert when a request fails to submit to Radarr/Sonarr/Overseerr.')}</p>
            </div>
          </div>
        </div>
      </div>
    ),
    'riven-keys': (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            background: 'var(--bg-secondary)',
            borderRadius: 14,
            padding: 28,
            width: 'min(520px, 92vw)',
            border: '1px solid var(--border)',
            position: 'relative',
            maxHeight: '88vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 14,
              right: 16,
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 20,
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title={t('Close')}
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('DUMB / Riven API Keys')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Auto-detection')}</p>
              <p style={{ margin: 0 }}>{t('API keys are automatically read from the path set in')} <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{t('RIVEN_SETTINGS_PATH')}</code> (env var, defaults to <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>
</code>). You only need to fill them in here if auto-detection fails.</p>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Finding the Riven API key manually')}</p>
              <p style={{ margin: '0 0 6px' }}>Run this on the server (replace path with your <code>{t('RIVEN_SETTINGS_PATH')}</code>):</p>
              <code style={{ display: 'block', fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '8px 10px', borderRadius: 6, wordBreak: 'break-all' }}>cat /opt/riven/settings.json | python3 -c "import json,sys;print(json.load(sys.stdin)['api_key'])"</code>
            </div>
          </div>
        </div>
      </div>
    ),
    'dumb-connect': (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            background: 'var(--bg-secondary)',
            borderRadius: 14,
            padding: 28,
            width: 'min(520px, 92vw)',
            border: '1px solid var(--border)',
            position: 'relative',
            maxHeight: '88vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 14,
              right: 16,
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 20,
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title={t('Close')}
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('How to connect DUMB')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li>{t('In DUMB settings, set')} <strong style={{ color: 'var(--text-primary)' }}>{t('Overseerr URL')}</strong> {t('to')} <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3 }}>{t('http://your-server:3232')}</code></li>
                <li>{t('Set')} <strong style={{ color: 'var(--text-primary)' }}>{t('Overseerr API Key')}</strong> {t('to the')} <strong style={{ color: 'var(--text-primary)' }}>{t('Overseerr Compat Key')}</strong> {t('— copy it from')} <strong style={{ color: 'var(--text-primary)' }}>{t('Admin → General → Overseerr Compat API')}</strong></li>
                <li>Choose a request mode (Pull or Push), then save</li>
              </ol>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Pull vs Push')}</p>
              <p style={{ margin: '0 0 4px' }}><strong style={{ color: 'var(--text-primary)' }}>{t('Pull')}</strong> {t('— DUMB polls')} <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>/api/v1/request?filter=approved</code> {t('on a schedule. No action needed from Diskovarr.')}</p>
              <p style={{ margin: 0 }}><strong style={{ color: 'var(--text-primary)' }}>{t('Push')}</strong> {t('— Diskovarr immediately pushes to Riven when a request is approved. Lower latency but requires Riven to be reachable.')}</p>
            </div>
          </div>
        </div>
      </div>
    ),
    pushover: (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            background: 'var(--bg-secondary)',
            borderRadius: 14,
            padding: 28,
            width: 'min(500px, 92vw)',
            border: '1px solid var(--border)',
            position: 'relative',
            maxHeight: '88vh',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: 14,
              right: 16,
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: 20,
              cursor: 'pointer',
              lineHeight: 1,
            }}
            title={t('Close')}
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Configuring Pushover Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('1. Create a Pushover application')}</p>
              <p style={{ margin: 0 }}>{t('Log in at')} <strong>{t('pushover.net')}</strong>{t(', go to')} <em>{t('Your Applications')}</em> → <em>{t('Create an Application/API Token')}</em>. Name it (e.g. "Diskovarr") and copy the <strong>{t('API Token')}</strong>.</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('2. Find your User Key')}</p>
              <p style={{ margin: 0 }}>{t('Your')} <strong>{t('User Key')}</strong> {t('is shown on your Pushover dashboard homepage. Use a')} <strong>{t('Group Key')}</strong> {t('instead to deliver to multiple users at once.')}</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('3. Install the Pushover app')}</p>
              <p style={{ margin: 0 }}>{t('Install Pushover on your iOS or Android device and log in. Notifications will be pushed there in real time.')}</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Notification types')}</p>
              <p style={{ margin: 0 }}><strong>{t('New request pending')}</strong> {t('— admin alert for incoming requests.')} <strong>{t('Request approved/denied')}</strong> {t('— notifies the requester when an admin acts.')}</p>
            </div>
     <div>
        <p style={{ margin: 0 }}>Per-user Pushover keys (for individual delivery) can be set from each user's settings page.</p>
      </div>
          </div>
        </div>
      </div>
    ),
    webhook: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Webhook Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ margin: 0 }}>{t('Send a custom JSON payload to any HTTP endpoint when events occur. Supports template variables in both the URL and payload body.')}</p>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Template Variables')}</p>
              <p style={{ margin: 0 }}>{t('Use double-brace syntax in your JSON payload:')} <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{'{{notification_type}}'}</code>, <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{'{{subject}}'}</code>, <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{'{{message}}'}</code>, <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{'{{image}}'}</code>, <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{'{{timestamp}}'}</code>, <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{'{{event}}'}</code>.</p>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Examples')}</p>
              <p style={{ margin: 0 }}>Compatible with services like n8n, Make.com, Zapier webhooks, Home Assistant, and custom scripts. Enable "Variables in URL" to use template variables in the webhook URL path itself.</p>
            </div>
          </div>
        </div>
      </div>
    ),
    slack: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Slack Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>{t('Go to your Slack workspace →')} <strong>{t('Settings & administration → Manage apps')}</strong></li>
              <li>{t('Search for')} <strong>{t('Incoming Webhooks')}</strong> {t('and add it')}</li>
              <li>{t('Choose a channel to post to and copy the webhook URL')}</li>
              <li>{t('Paste it into the Webhook URL field above')}</li>
            </ol>
            <p style={{ margin: 0 }}>{t('Notifications use Slack Block Kit formatting for rich embeds with poster images.')}</p>
          </div>
        </div>
      </div>
    ),
    gotify: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Gotify Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Self-host Gotify (see <a href="https://gotify.net/docs" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{t('gotify.net/docs')}</a>)</li>
              <li>{t('Create an Application in Gotify and copy its token')}</li>
              <li>{t('Enter your Gotify server URL and token above')}</li>
            </ol>
            <p style={{ margin: 0 }}>{t('Priority controls urgency levels from Minimum to Maximum. The Gotify mobile app or web UI receives the notifications.')}</p>
          </div>
        </div>
      </div>
    ),
    ntfy: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('ntfy Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ margin: 0 }}>{t('Use')} <strong>{t('ntfy.sh')}</strong> {t('for free cloud push, or self-host your own ntfy server. The topic acts as a channel name.')}</p>
            </div>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Enter the server URL (e.g. <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{t('https://ntfy.sh')}</code>)</li>
              <li>Choose a topic name (e.g. <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>{t('diskovarr')}</code>)</li>
              <li>Optionally configure auth (Bearer token or Basic auth)</li>
              <li>{t('Subscribe to the topic on the ntfy app or web client')}</li>
            </ol>
          </div>
        </div>
      </div>
    ),
    telegram: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Telegram Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>{t('Message')} <strong><a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{t('@BotFather')}</a></strong> {t('on Telegram and create a new bot')}</li>
              <li>{t('Copy the bot API token and paste it above')}</li>
              <li>{t('Find your chat ID by messaging')} <strong><a href="https://t.me/userinfobot" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{t('@userinfobot')}</a></strong></li>
              <li>{t('For groups: add the bot to the group, make it admin, then get the group chat ID')}</li>
            </ol>
            <p style={{ margin: 0 }}>{t('Users can set their own personal chat IDs in their profile settings for individual delivery.')}</p>
          </div>
        </div>
      </div>
    ),
    pushbullet: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('Pushbullet Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>{t('Log in to')} <strong>{t('pushbullet.com')}</strong></li>
              <li>{t('Go to')} <strong>{t('Settings')}</strong> {t('and find your')} <strong>{t('Access Token')}</strong></li>
              <li>{t('Paste it above')}</li>
              <li>{t('Optionally create a channel for group delivery')}</li>
            </ol>
            <p style={{ margin: 0 }}>{t('Users can set their own access tokens in profile settings for individual device delivery.')}</p>
          </div>
        </div>
      </div>
    ),
    email: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>Email (SMTP) Notifications</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0 }}>Send email notifications via any SMTP server (Gmail, Outlook, self-hosted, etc.). Users who have an email address on file can opt in to receive emails.</p>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Gmail Setup')}</p>
              <p style={{ margin: 0 }}>{t('Use an')} <strong>{t('App Password')}</strong> (not your regular password). Go to Google Account → Security → 2-Step Verification → App Passwords. Use port 587 with STARTTLS.</p>
            </div>
          </div>
        </div>
      </div>
    ),
    webpush: (
      <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
        <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 28, width: 'min(500px, 92vw)', border: '1px solid var(--border)', position: 'relative', maxHeight: '88vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <button onClick={onClose} style={{ position: 'absolute', top: 14, right: 16, background: 'none', border: 'none', color: 'var(--text-secondary)', fontSize: 20, cursor: 'pointer' }}>&times;</button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>{t('WebPush Notifications')}</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0 }}>{t('Send native browser push notifications. VAPID keys are auto-generated on first save. Users opt in from their profile settings page by allowing browser notifications.')}</p>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>{t('Requirements')}</p>
              <p style={{ margin: 0 }}>Diskovarr must be served over HTTPS (or localhost). Users need a modern browser that supports the Web Push API. The in-app bell icon will prompt users to subscribe.</p>
            </div>
          </div>
        </div>
      </div>
    ),
  }

  return modals[agent] || null
}

export default AgentInfoModal
