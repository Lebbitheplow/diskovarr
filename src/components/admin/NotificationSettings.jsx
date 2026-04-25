import React, { useState, useEffect, useCallback } from 'react'
import { adminNotifications, adminSettings, adminStatus } from '../../services/adminApi'

const WEBHOOK_NOTIFICATION_TYPES = [
  { value: 'request_pending', label: 'New request pending', meta: '(admin)' },
  { value: 'request_auto_approved', label: 'Request auto-approved', meta: '(admin)' },
  { value: 'request_approved', label: 'Request approved', meta: '(requester)' },
  { value: 'request_denied', label: 'Request denied', meta: '(requester)' },
  { value: 'request_available', label: 'Request available in library', meta: '(requester)' },
  { value: 'request_process_failed', label: 'Request processing error', meta: '(admin)' },
  { value: 'issue_new', label: 'New issue reported', meta: '(admin)' },
  { value: 'issue_updated', label: 'Issue status updated', meta: '(requester)' },
  { value: 'issue_comment_added_admin,issue_comment_added_user', label: 'Issue Comments' },
]

const BOT_NOTIFICATION_TYPES = [
  { value: 'request_pending', label: 'New request pending', meta: '(admin)' },
  { value: 'request_auto_approved', label: 'Request auto-approved', meta: '(admin)' },
  { value: 'request_approved', label: 'Request approved', meta: '(requester)' },
  { value: 'request_denied', label: 'Request denied', meta: '(requester)' },
  { value: 'request_available', label: 'Request available in library', meta: '(requester)' },
  { value: 'request_process_failed', label: 'Request processing error', meta: '(admin)' },
  { value: 'issue_new', label: 'New issue reported', meta: '(admin)' },
  { value: 'issue_updated', label: 'Issue status updated', meta: '(requester)' },
  { value: 'issue_comment_added_admin,issue_comment_added_user', label: 'Issue Comments' },
]

const PUSHOVER_NOTIFICATION_TYPES = [
  { value: 'request_pending', label: 'New request pending' },
  { value: 'request_approved', label: 'Request approved' },
  { value: 'request_denied', label: 'Request denied' },
  { value: 'request_available', label: 'Request available in library' },
  { value: 'request_process_failed', label: 'Request processing error' },
  { value: 'issue_new', label: 'New issue reported' },
  { value: 'issue_updated', label: 'Issue status updated' },
  { value: 'issue_comment_added_admin,issue_comment_added_user', label: 'Issue Comments' },
]

const PUSHOVER_SOUNDS = [
  { value: '', label: 'Device Default' },
  { value: 'pushover', label: 'Pushover (default)' },
  { value: 'bike', label: 'Bike' },
  { value: 'bugle', label: 'Bugle' },
  { value: 'cashregister', label: 'Cash Register' },
  { value: 'classical', label: 'Classical' },
  { value: 'cosmic', label: 'Cosmic' },
  { value: 'falling', label: 'Falling' },
  { value: 'gamelan', label: 'Gamelan' },
  { value: 'incoming', label: 'Incoming' },
  { value: 'intermission', label: 'Intermission' },
  { value: 'magic', label: 'Magic' },
  { value: 'mechanical', label: 'Mechanical' },
  { value: 'pianobar', label: 'Piano Bar' },
  { value: 'siren', label: 'Siren' },
  { value: 'spacealarm', label: 'Space Alarm' },
  { value: 'tugboat', label: 'Tug Boat' },
  { value: 'alien', label: 'Alien Alarm (long)' },
  { value: 'climb', label: 'Climb (long)' },
  { value: 'persistent', label: 'Persistent (long)' },
  { value: 'echo', label: 'Pushover Echo (long)' },
  { value: 'updown', label: 'Up Down (long)' },
  { value: 'vibrate', label: 'Vibrate Only' },
  { value: 'none', label: 'Silent' },
]

const DEFAULT_WEBHOOK_TYPES = [
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]

const DEFAULT_BOT_TYPES = [
  'request_pending', 'request_auto_approved', 'request_approved', 'request_denied',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]

const DEFAULT_PUSHOVER_TYPES = [
  'request_pending', 'request_approved', 'request_denied', 'request_available',
  'issue_new', 'issue_updated', 'issue_comment_added_admin,issue_comment_added_user',
]

function Checkbox({ checked, onChange, children, style }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', ...style }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function NotificationSettings({ onDataLoaded, onToast, onOpenAgentInfo }) {
  const [broadcastMsg, setBroadcastMsg] = useState('')
  const [broadcastResult, setBroadcastResult] = useState('')

  const [discordEnabled, setDiscordEnabled] = useState(false)
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [botEnabled, setBotEnabled] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [botToken, setBotToken] = useState('')
  const [botUsername, setBotUsername] = useState('')
  const [botAvatarUrl, setBotAvatarUrl] = useState('')
  const [publicUrl, setPublicUrl] = useState('')
  const [notificationRoleId, setNotificationRoleId] = useState('')
  const [enableMentions, setEnableMentions] = useState(false)
  const [webhookEmbedPoster, setWebhookEmbedPoster] = useState(true)
  const [botEmbedPoster, setBotEmbedPoster] = useState(true)
  const [webhookNotifTypes, setWebhookNotifTypes] = useState([...DEFAULT_WEBHOOK_TYPES])
  const [botNotifTypes, setBotNotifTypes] = useState([...DEFAULT_BOT_TYPES])
  const [inviteLink, setInviteLink] = useState('')

  const [avatarPreview, setAvatarPreview] = useState(null)
  const [avatarFileData, setAvatarFileData] = useState(null)
  const [avatarRemoving, setAvatarRemoving] = useState(false)

  const [pushoverEnabled, setPushoverEnabled] = useState(false)
  const [pushoverAppToken, setPushoverAppToken] = useState('')
  const [pushoverUserKey, setPushoverUserKey] = useState('')
  const [pushoverSound, setPushoverSound] = useState('')
  const [pushoverEmbedPoster, setPushoverEmbedPoster] = useState(false)
  const [pushoverNotifTypes, setPushoverNotifTypes] = useState([...DEFAULT_PUSHOVER_TYPES])

  const [discordTestUserId, setDiscordTestUserId] = useState('')
  const [testingBroadcast, setTestingBroadcast] = useState(false)
  const [testingDiscord, setTestingDiscord] = useState(false)
  const [testingPushover, setTestingPushover] = useState(false)

  const loadConfig = useCallback(async () => {
    try {
      const res = await adminStatus.get()
      const discord = res.data?.discordAgent || {}
      const pushover = res.data?.pushoverAgent || {}

      setDiscordEnabled(!!discord.enabled)
      setWebhookEnabled(!!discord.webhookEnabled)
      setBotEnabled(!!discord.botEnabled)
      setWebhookUrl(discord.webhookUrl || '')
      setBotToken(discord.botToken || '')
      setBotUsername(discord.botUsername || 'Diskovarr')
      setBotAvatarUrl(discord.botAvatarUrl || '')
      setPublicUrl(discord.publicUrl || '')
      setNotificationRoleId(discord.notificationRoleId || '')
      setEnableMentions(!!discord.enableMentions)
      setWebhookEmbedPoster(!!discord.webhookEmbedPoster)
      setBotEmbedPoster(!!discord.botEmbedPoster)
      setInviteLink(discord.inviteLink || '')

      const wTypes = discord.webhookNotificationTypes || []
      setWebhookNotifTypes(wTypes.length > 0 ? wTypes : [...DEFAULT_WEBHOOK_TYPES])

      const bTypes = discord.botNotificationTypes || []
      setBotNotifTypes(bTypes.length > 0 ? bTypes : [...DEFAULT_BOT_TYPES])

      setPushoverEnabled(!!pushover.enabled)
      setPushoverAppToken(pushover.appToken || '')
      setPushoverUserKey(pushover.userKey || '')
      setPushoverSound(pushover.sound || '')
      setPushoverEmbedPoster(!!pushover.embedPoster)
      const pTypes = pushover.notificationTypes || []
      setPushoverNotifTypes(pTypes.length > 0 ? pTypes : [...DEFAULT_PUSHOVER_TYPES])

      if (discord.botAvatarUrl) {
        setAvatarPreview(discord.botAvatarUrl)
      }

      if (onDataLoaded) onDataLoaded()
    } catch (err) {
      if (onToast) onToast('Failed to load notification settings', 'error')
    }
  }, [onDataLoaded, onToast])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const handleAvatarChange = useCallback(async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      if (onToast) onToast('File must be under 2MB', 'error')
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUri = ev.target.result
      setAvatarPreview(dataUri)
      setAvatarFileData(dataUri)
      setAvatarRemoving(false)
    }
    reader.readAsDataURL(file)
  }, [onToast])

  const handleRemoveAvatar = useCallback(() => {
    setAvatarPreview(null)
    setAvatarFileData(null)
    setAvatarRemoving(true)
  }, [])

  const getChecked = useCallback((types, value) => types.includes(value), [])

  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev =>
      prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value],
    )
  }, [])

  const collectWebhookTypes = useCallback(() => {
    const types = []
    WEBHOOK_NOTIFICATION_TYPES.forEach(t => {
      if (getChecked(webhookNotifTypes, t.value)) types.push(t.value)
    })
    return types
  }, [webhookNotifTypes, getChecked])

  const collectBotTypes = useCallback(() => {
    const types = []
    BOT_NOTIFICATION_TYPES.forEach(t => {
      if (getChecked(botNotifTypes, t.value)) types.push(t.value)
    })
    return types
  }, [botNotifTypes, getChecked])

  const collectPushoverTypes = useCallback(() => {
    const types = []
    PUSHOVER_NOTIFICATION_TYPES.forEach(t => {
      if (getChecked(pushoverNotifTypes, t.value)) types.push(t.value)
    })
    return types
  }, [pushoverNotifTypes, getChecked])

  const handleSaveDiscord = useCallback(async () => {
    try {
      const payload = {
        enabled: discordEnabled,
        webhookEnabled,
        botEnabled,
        webhookUrl,
        botToken: botToken || undefined,
        botUsername: botUsername || undefined,
        botAvatarUrl,
        publicUrl,
        notificationRoleId,
        enableMentions,
        webhookEmbedPoster,
        botEmbedPoster,
        webhookNotificationTypes: collectWebhookTypes(),
        botNotificationTypes: collectBotTypes(),
        inviteLink: inviteLink || undefined,
      }

      if (avatarRemoving) {
        await adminSettings.setDiscordAvatar('', true)
      } else if (avatarFileData) {
        await adminSettings.setDiscordAvatar(avatarFileData, false)
      }

      await adminNotifications.setDiscord(payload)
      setAvatarFileData(null)
      setAvatarRemoving(false)
      if (onToast) onToast('Discord settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save Discord settings', 'error')
    }
  }, [
    discordEnabled, webhookEnabled, botEnabled, webhookUrl, botToken, botUsername,
    botAvatarUrl, publicUrl, notificationRoleId, enableMentions,
    webhookEmbedPoster, botEmbedPoster, avatarRemoving, avatarFileData,
    inviteLink, collectWebhookTypes, collectBotTypes, onToast,
  ])

  const handleTestDiscord = useCallback(async () => {
    if (webhookEnabled && !webhookUrl) {
      if (onToast) onToast('Webhook URL is required to send a test', 'error')
      return
    }
    if (botEnabled && !botToken) {
      if (onToast) onToast('Bot Token is required to send a test', 'error')
      return
    }
    if (!webhookEnabled && !botEnabled) {
      if (onToast) onToast('Enable either Webhook or Bot mode to send a test', 'error')
      return
    }

    setTestingDiscord(true)
    try {
      if (botEnabled) {
        if (!discordTestUserId) {
          if (onToast) onToast('Enter your Discord User ID to send a test DM', 'error')
          setTestingDiscord(false)
          return
        }
        const res = await adminNotifications.testDiscord({
          mode: 'bot',
          discordUserId: discordTestUserId,
          botToken,
          botNotificationTypes: collectBotTypes(),
        })
        if (onToast) onToast(res.data?.message || 'Test notification sent', 'success')
      } else {
        const res = await adminNotifications.testDiscord({
          mode: 'webhook',
          webhookUrl,
          webhookNotificationTypes: collectWebhookTypes(),
        })
        if (onToast) onToast(res.data?.message || 'Test notification sent', 'success')
      }
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test notification', 'error')
    } finally {
      setTestingDiscord(false)
    }
  }, [
    webhookEnabled, botEnabled, webhookUrl, botToken,
    discordTestUserId, collectWebhookTypes, collectBotTypes, onToast,
  ])

  const handleSavePushover = useCallback(async () => {
    try {
      await adminNotifications.setPushover({
        enabled: pushoverEnabled,
        appToken: pushoverAppToken,
        userKey: pushoverUserKey,
        sound: pushoverSound || undefined,
        embedPoster: pushoverEmbedPoster,
        notificationTypes: collectPushoverTypes(),
      })
      if (onToast) onToast('Pushover settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save Pushover settings', 'error')
    }
  }, [pushoverEnabled, pushoverAppToken, pushoverUserKey, pushoverSound, pushoverEmbedPoster, collectPushoverTypes, onToast])

  const handleTestPushover = useCallback(async () => {
    setTestingPushover(true)
    try {
      const res = await adminNotifications.testPushover({
        appToken: pushoverAppToken,
        userKey: pushoverUserKey,
        notificationTypes: collectPushoverTypes(),
      })
      if (onToast) onToast(res.data?.message || 'Test notification sent', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test notification', 'error')
    } finally {
      setTestingPushover(false)
    }
  }, [pushoverAppToken, pushoverUserKey, collectPushoverTypes, onToast])

  const handleBroadcast = useCallback(async () => {
    if (!broadcastMsg.trim()) {
      if (onToast) onToast('Please enter a message', 'error')
      return
    }
    setTestingBroadcast(true)
    setBroadcastResult('')
    try {
      const res = await adminNotifications.broadcast(broadcastMsg.trim())
      setBroadcastResult(res.data?.message || 'Notification sent')
      if (onToast) onToast('Broadcast sent', 'success')
    } catch (err) {
      setBroadcastResult(err.message || 'Failed to send broadcast')
      if (onToast) onToast(err.message || 'Failed to send broadcast', 'error')
    } finally {
      setTestingBroadcast(false)
    }
  }, [broadcastMsg, onToast])

  const infoBtnStyle = {
    marginLeft: 8,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 'inherit',
    color: 'inherit',
    padding: 0,
    verticalAlign: 'middle',
  }

  const sectionHeaderStyle = { marginBottom: 4 }

  const panelStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginBottom: 20,
    padding: 14,
    background: 'var(--bg-elevated)',
    borderRadius: 8,
    border: '1px solid var(--border)',
  }

  return (
    <div className="admin-tab-panel" id="panel-notifications">
      {/* Broadcast Message */}
      <section className="admin-section">
        <div className="admin-section-header">
          <h2 className="section-title">Broadcast Message</h2>
        </div>
        <p className="section-desc" style={{ marginBottom: 16 }}>
          Send a custom message to all users via all configured notification channels (in-app bell, Discord, and Pushover).
        </p>
        <textarea
          className="conn-input"
          rows={3}
          placeholder="Type a message to send to all users..."
          value={broadcastMsg}
          onChange={(e) => setBroadcastMsg(e.target.value)}
          style={{ resize: 'vertical', minHeight: 80, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <button
            className="btn-admin btn-primary"
            onClick={handleBroadcast}
            disabled={testingBroadcast}
          >
            {testingBroadcast ? 'Sending...' : 'Notify All Users'}
          </button>
          <span style={{ fontSize: '0.82rem' }}>{broadcastResult}</span>
        </div>
      </section>

      {/* Discord Agent */}
      <section className="admin-section">
        <div className="admin-section-header">
          <h2 className="section-title">
            Discord Agent
            <button
              type="button"
              className="agent-info-btn"
              onClick={() => onOpenAgentInfo?.('discord')}
              title="How to configure"
              style={infoBtnStyle}
            >
              &#9432;
            </button>
          </h2>
          <label className="slide-toggle" style={{ flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={discordEnabled}
              onChange={(e) => setDiscordEnabled(e.target.checked)}
            />
            <span className="slide-track" />
          </label>
        </div>
        <p className="section-desc" style={{ marginBottom: 16 }}>
          Send Discord notifications via a shared channel webhook or direct messages to individual users via a bot. Both can be enabled independently.
        </p>

        <div className="toggle-row" style={{ marginBottom: 12 }}>
          <label className="slide-toggle">
            <input
              type="checkbox"
              checked={webhookEnabled}
              onChange={(e) => setWebhookEnabled(e.target.checked)}
              disabled={!discordEnabled}
            />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">Webhook</span>
        </div>

        {webhookEnabled && (
          <div style={panelStyle}>
            <div>
              <label className="conn-label">Webhook URL</label>
              <input
                type="url"
                className="conn-input"
                placeholder="https://discord.com/api/webhooks/..."
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
            </div>
            <div>
              <label className="conn-label">
                Notification Role ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional, for @mentions)</span>
              </label>
              <input
                type="text"
                className="conn-input"
                placeholder="Role ID"
                value={notificationRoleId}
                onChange={(e) => setNotificationRoleId(e.target.value)}
              />
            </div>
            <Checkbox checked={enableMentions} onChange={(e) => setEnableMentions(e.target.checked)}>
              Enable @role mentions
            </Checkbox>
            <div>
              <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
                Webhook Notification Types
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {WEBHOOK_NOTIFICATION_TYPES.map((t) => (
                  <Checkbox
                    key={t.value}
                    checked={getChecked(webhookNotifTypes, t.value)}
                    onChange={() => toggleType(setWebhookNotifTypes, t.value)}
                  >
                    {t.label}
                    {t.meta && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{t.meta}</span>}
                  </Checkbox>
                ))}
              </div>
            </div>
            <Checkbox checked={webhookEmbedPoster} onChange={(e) => setWebhookEmbedPoster(e.target.checked)}>
              Embed poster image in notifications
            </Checkbox>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingTop: 4 }}>
              <button className="btn-admin btn-primary" onClick={handleSaveDiscord}>Save</button>
              <button className="btn-admin" onClick={handleTestDiscord} disabled={testingDiscord}>
                {testingDiscord ? 'Sending...' : 'Send Test'}
              </button>
            </div>
          </div>
        )}

        <div className="toggle-row" style={{ marginBottom: 12 }}>
          <label className="slide-toggle">
            <input
              type="checkbox"
              checked={botEnabled}
              onChange={(e) => setBotEnabled(e.target.checked)}
              disabled={!discordEnabled}
            />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">Bot Token</span>
        </div>

        {botEnabled && (
          <div style={panelStyle}>
            <div>
              <label className="conn-label">Bot Token</label>
              <input
                type="password"
                className="conn-input"
                placeholder="Bot token from Discord Developer Portal"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>
                Bot Notification Types
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {BOT_NOTIFICATION_TYPES.map((t) => (
                  <Checkbox
                    key={t.value}
                    checked={getChecked(botNotifTypes, t.value)}
                    onChange={() => toggleType(setBotNotifTypes, t.value)}
                  >
                    {t.label}
                    {t.meta && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{t.meta}</span>}
                  </Checkbox>
                ))}
              </div>
            </div>
            <div>
              <label className="conn-label">
                Bot Username <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="text"
                className="conn-input"
                placeholder="Diskovarr"
                value={botUsername}
                onChange={(e) => setBotUsername(e.target.value)}
              />
            </div>

            <div>
              <label className="conn-label">
                Bot Avatar <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                <img
                  src={avatarPreview || '/discord-avatar.png'}
                  width={48}
                  height={48}
                  style={{ borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)', flexShrink: 0 }}
                  alt="Bot avatar preview"
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <label
                      htmlFor="avatar-file-input"
                      className="btn-admin btn-sm"
                      style={{ cursor: 'pointer', margin: 0 }}
                    >
                      Choose Image
                    </label>
                    <input
                      id="avatar-file-input"
                      type="file"
                      accept="image/png,image/jpeg,image/gif"
                      style={{ display: 'none' }}
                      onChange={handleAvatarChange}
                    />
                    <button
                      type="button"
                      className="btn-admin btn-sm btn-danger"
                      style={{ display: avatarPreview ? 'inline-block' : 'none' }}
                      onClick={handleRemoveAvatar}
                    >
                      Remove
                    </button>
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    PNG/JPG/GIF &middot; 128x128 recommended &middot; max 2 MB &middot; leave blank for auto-generated logo
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label className="conn-label" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Or use a URL instead</label>
                <input
                  type="text"
                  className="conn-input"
                  placeholder="https://example.com/avatar.png"
                  value={botAvatarUrl}
                  onChange={(e) => setBotAvatarUrl(e.target.value)}
                  style={{ marginTop: 2 }}
                />
              </div>
            </div>

            <Checkbox checked={botEmbedPoster} onChange={(e) => setBotEmbedPoster(e.target.checked)}>
              Embed poster image in notifications
            </Checkbox>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', paddingTop: 4 }}>
              <div>
                <label className="conn-label" style={{ marginBottom: 4 }}>
                  Your Discord User ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(to receive test DM)</span>
                </label>
                <input
                  type="text"
                  className="conn-input"
                  style={{ maxWidth: 240 }}
                  placeholder="Discord user ID"
                  value={discordTestUserId}
                  onChange={(e) => setDiscordTestUserId(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn-admin btn-primary" onClick={handleSaveDiscord}>Save</button>
                <button className="btn-admin" onClick={handleTestDiscord} disabled={testingDiscord}>
                  {testingDiscord ? 'Sending...' : 'Send Test DM'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <label className="conn-label">
            Discord Server Invite Link <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional - shown to users in their settings)</span>
          </label>
          <input
            type="url"
            className="conn-input"
            placeholder="https://discord.gg/..."
            value={inviteLink}
            onChange={(e) => setInviteLink(e.target.value)}
          />
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 6 }}>
            Use a non-expiring invite so users can join the server to receive bot DMs.
          </p>
        </div>
      </section>

      {/* Pushover Agent */}
      <section className="admin-section">
        <div className="admin-section-header">
          <h2 className="section-title">
            Pushover Agent
            <button
              type="button"
              className="agent-info-btn"
              onClick={() => onOpenAgentInfo?.('pushover')}
              title="How to configure"
              style={infoBtnStyle}
            >
              &#9432;
            </button>
          </h2>
          <label className="slide-toggle" style={{ flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={pushoverEnabled}
              onChange={(e) => setPushoverEnabled(e.target.checked)}
            />
            <span className="slide-track" />
          </label>
        </div>
        <p className="section-desc" style={{ marginBottom: 20 }}>
          Send push notifications via Pushover to your devices.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          <div>
            <label className="conn-label">Application API Token</label>
            <input
              type="text"
              className="conn-input"
              placeholder="App token from pushover.net"
              value={pushoverAppToken}
              onChange={(e) => setPushoverAppToken(e.target.value)}
            />
            <span className="conn-hint">
              <a href="https://pushover.net/api#registration" target="_blank" rel="noopener noreferrer">Register an application</a> for use with Diskovarr
            </span>
          </div>
          <div>
            <label className="conn-label">User or Group Key</label>
            <input
              type="text"
              className="conn-input"
              placeholder="User/group key"
              value={pushoverUserKey}
              onChange={(e) => setPushoverUserKey(e.target.value)}
            />
            <span className="conn-hint">
              Your 30-character <a href="https://pushover.net/api#identifiers" target="_blank" rel="noopener noreferrer">User or Group ID</a>
            </span>
          </div>
          <Checkbox checked={pushoverEmbedPoster} onChange={(e) => setPushoverEmbedPoster(e.target.checked)}>
            Embed poster image in notifications
          </Checkbox>
          <div>
            <label className="conn-label">Notification Sound</label>
            <select
              className="conn-input"
              value={pushoverSound}
              onChange={(e) => setPushoverSound(e.target.value)}
            >
              {PUSHOVER_SOUNDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 10px' }}>
              Notification Types
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {PUSHOVER_NOTIFICATION_TYPES.map((t) => (
                <Checkbox
                  key={t.value}
                  checked={getChecked(pushoverNotifTypes, t.value)}
                  onChange={() => toggleType(setPushoverNotifTypes, t.value)}
                >
                  {t.label}
                </Checkbox>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-admin btn-primary" onClick={handleSavePushover}>Save</button>
            <button className="btn-admin" onClick={handleTestPushover} disabled={testingPushover}>
              {testingPushover ? 'Sending...' : 'Send Test'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
