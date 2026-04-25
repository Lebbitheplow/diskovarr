import React from 'react'

function AgentInfoModal({ agent, onClose }) {
  if (!agent) return null

  const modals = {
    discord: (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: 'rgba(0,0,0,0.75)',
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
            title="Close"
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>Configuring Discord Notifications</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Mode: Webhook (shared channel)</p>
              <p style={{ margin: '0 0 6px' }}>All notifications go to a single Discord channel. Users can optionally add their own personal webhook for private-channel delivery.</p>
              <p style={{ fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 2px' }}>Setup:</p>
              <p style={{ margin: 0 }}>In your Discord server → <strong>Server Settings → Integrations → Webhooks</strong> → <em>New Webhook</em> → pick a channel → copy the URL. Paste it in the Webhook URL field above.</p>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Mode: Bot Token (individual DMs)</p>
              <p style={{ margin: '0 0 6px' }}>The bot sends each user a personal DM. Each user enters their Discord User ID in their profile settings.</p>
              <p style={{ fontWeight: 500, color: 'var(--text-primary)', margin: '0 0 2px' }}>Setup:</p>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>Go to <strong>discord.com/developers/applications</strong> → <em>New Application</em></li>
                <li>Open the <strong>Bot</strong> tab → <em>Add Bot</em> → copy the <strong>Token</strong></li>
                <li>Enable <strong>Message Content Intent</strong> on the Bot tab</li>
                <li>Invite the bot to your server: OAuth2 → URL Generator → scope: <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>bot</code>, permission: <em>Send Messages</em></li>
                <li>Each user finds their Discord User ID (Developer Mode → right-click profile → Copy User ID) and enters it in their Diskovarr settings</li>
              </ol>
              <p style={{ margin: '8px 0 0' }}><strong>Admin channel toggle</strong> — enable "Also post admin notifications to shared channel" to mirror admin-type alerts (pending requests, errors) to a shared Discord channel webhook alongside the bot DMs.</p>
              <p style={{ margin: '6px 0 0' }}><strong>Server Invite Link</strong> — set a non-expiring Discord invite link; users will see a "Join Server" prompt in their settings page so they can join your server before the bot can DM them.</p>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 10 }}>
                <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Finding your Discord User ID (to test DMs)</p>
                <p style={{ margin: '0 0 6px' }}>The User ID is a <strong>17–19 digit number</strong> — not your username (e.g. <code style={{ fontSize: '0.78rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>185234567891234560</code>).</p>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  <li>In Discord, open <strong>Settings → Advanced</strong> and enable <strong>Developer Mode</strong></li>
                  <li>Find any message you've sent, then <strong>right-click your avatar or username</strong> on that message</li>
                  <li>Click <strong>Copy User ID</strong> from the context menu</li>
                  <li>Paste the numeric ID into your Diskovarr <strong>Notification Settings</strong> page and save</li>
                </ol>
                <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)' }}><strong>Note:</strong> The bot must be in a Discord server that you are also a member of — it cannot DM users with no mutual server.</p>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 8 }}>
                  <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Inviting the bot to your server</p>
                  <ol style={{ margin: 0, paddingLeft: 18 }}>
                    <li>Go to <strong>discord.com/developers/applications</strong> → select your app</li>
                    <li>Open <strong>OAuth2 → URL Generator</strong></li>
                    <li>Under <strong>Scopes</strong> check <code style={{ fontSize: '0.78rem', background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>bot</code></li>
                    <li>Under <strong>Bot Permissions</strong> check <em>Send Messages</em></li>
                    <li>Copy the generated URL, open it in your browser, and add the bot to your server</li>
                  </ol>
                </div>
              </div>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Bot avatar</p>
              <p style={{ margin: 0 }}>Leave the Avatar URL blank and Diskovarr will automatically set the bot's avatar to the Diskovarr logo in your server's accent colour. Or supply a custom image URL to override it. The <strong>App Public URL</strong> (set in General Settings) must be configured for the auto-generated avatar endpoint to work.</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Notification types</p>
              <p style={{ margin: 0 }}><strong>New request pending / Auto-approved</strong> — admin alerts for incoming requests. <strong>Approved / Denied</strong> — notify the requester when an admin acts. <strong>Available</strong> — notify when content appears in Plex. <strong>Request processing error</strong> — admin alert when a request fails to submit to Radarr/Sonarr/Overseerr.</p>
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
            title="Close"
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>DUMB / Riven API Keys</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Auto-detection</p>
              <p style={{ margin: 0 }}>API keys are automatically read from the path set in <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>RIVEN_SETTINGS_PATH</code> (env var, defaults to <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>
</code>). You only need to fill them in here if auto-detection fails.</p>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Finding the Riven API key manually</p>
              <p style={{ margin: '0 0 6px' }}>Run this on the server (replace path with your <code>RIVEN_SETTINGS_PATH</code>):</p>
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
            title="Close"
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>How to connect DUMB</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <li>In DUMB settings, set <strong style={{ color: 'var(--text-primary)' }}>Overseerr URL</strong> to <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3 }}>http://your-server:3232</code></li>
                <li>Set <strong style={{ color: 'var(--text-primary)' }}>Overseerr API Key</strong> to the <strong style={{ color: 'var(--text-primary)' }}>Overseerr Compat Key</strong> — copy it from <strong style={{ color: 'var(--text-primary)' }}>Admin → General → Overseerr Compat API</strong></li>
                <li>Choose a request mode (Pull or Push), then save</li>
              </ol>
            </div>
            <div style={{ background: 'var(--bg-elevated)', borderRadius: 8, padding: 12 }}>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Pull vs Push</p>
              <p style={{ margin: '0 0 4px' }}><strong style={{ color: 'var(--text-primary)' }}>Pull</strong> — DUMB polls <code style={{ fontSize: '0.8rem', background: 'var(--bg-secondary)', padding: '1px 4px', borderRadius: 3 }}>/api/v1/request?filter=approved</code> on a schedule. No action needed from Diskovarr.</p>
              <p style={{ margin: 0 }}><strong style={{ color: 'var(--text-primary)' }}>Push</strong> — Diskovarr immediately pushes to Riven when a request is approved. Lower latency but requires Riven to be reachable.</p>
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
            title="Close"
          >
            &times;
          </button>
          <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>Configuring Pushover Notifications</h3>
          <div style={{ fontSize: '0.88rem', lineHeight: 1.7, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>1. Create a Pushover application</p>
              <p style={{ margin: 0 }}>Log in at <strong>pushover.net</strong>, go to <em>Your Applications</em> → <em>Create an Application/API Token</em>. Name it (e.g. "Diskovarr") and copy the <strong>API Token</strong>.</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>2. Find your User Key</p>
              <p style={{ margin: 0 }}>Your <strong>User Key</strong> is shown on your Pushover dashboard homepage. Use a <strong>Group Key</strong> instead to deliver to multiple users at once.</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>3. Install the Pushover app</p>
              <p style={{ margin: 0 }}>Install Pushover on your iOS or Android device and log in. Notifications will be pushed there in real time.</p>
            </div>
            <div>
              <p style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px' }}>Notification types</p>
              <p style={{ margin: 0 }}><strong>New request pending</strong> — admin alert for incoming requests. <strong>Request approved/denied</strong> — notifies the requester when an admin acts.</p>
            </div>
            <div>
              <p style={{ margin: 0 }}>Per-user Pushover keys (for individual delivery) can be set from each user's settings page.</p>
            </div>
          </div>
        </div>
      </div>
    ),
  }

  return modals[agent] || null
}

export default AgentInfoModal
