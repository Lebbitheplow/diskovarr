import React, { useState, useCallback } from 'react'
import { adminNotifications, adminSettings } from '../../../../services/adminApi'
import {
  WEBHOOK_NOTIFICATION_TYPES, BOT_NOTIFICATION_TYPES,
  DEFAULT_WEBHOOK_TYPES, DEFAULT_BOT_TYPES,
} from '../constants'

function Checkbox({ checked, onChange, children, style }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', ...style }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function DiscordProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [webhookEnabled, setWebhookEnabled] = useState(initial?.webhookEnabled || false)
  const [botEnabled, setBotEnabled] = useState(initial?.botEnabled || false)
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhookUrl || '')
  const [botToken, setBotToken] = useState(initial?.botToken || '')
  const [botUsername, setBotUsername] = useState(initial?.botUsername || 'Diskovarr')
  const [botAvatarUrl, setBotAvatarUrl] = useState(initial?.botAvatarUrl || '')
  const [publicUrl, setPublicUrl] = useState(initial?.publicUrl || '')
  const [notificationRoleId, setNotificationRoleId] = useState(initial?.notificationRoleId || '')
  const [enableMentions, setEnableMentions] = useState(!!initial?.enableMentions)
  const [webhookEmbedPoster, setWebhookEmbedPoster] = useState(!!initial?.webhookEmbedPoster)
  const [botEmbedPoster, setBotEmbedPoster] = useState(!!initial?.botEmbedPoster)
  const [webhookNotifTypes, setWebhookNotifTypes] = useState(
    (initial?.webhookNotificationTypes || []).length > 0 ? initial.webhookNotificationTypes : [...DEFAULT_WEBHOOK_TYPES]
  )
  const [botNotifTypes, setBotNotifTypes] = useState(
    (initial?.botNotificationTypes || []).length > 0 ? initial.botNotificationTypes : [...DEFAULT_BOT_TYPES]
  )
  const [inviteLink, setInviteLink] = useState(initial?.inviteLink || '')
  const [discordTestUserId, setDiscordTestUserId] = useState('')
  const [avatarPreview, setAvatarPreview] = useState(initial?.botAvatarUrl || null)
  const [avatarFileData, setAvatarFileData] = useState(null)
  const [avatarRemoving, setAvatarRemoving] = useState(false)
  const [testing, setTesting] = useState(false)

  const getChecked = useCallback((types, value) => types.includes(value), [])
  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev => prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value])
  }, [])
  const collectTypes = useCallback((types) => types.filter(t => t), [])

  const handleSave = useCallback(async () => {
    try {
      if (avatarRemoving) await adminSettings.setDiscordAvatar('', true)
      else if (avatarFileData) await adminSettings.setDiscordAvatar(avatarFileData, false)

      await adminNotifications.setDiscord({
        enabled, webhookEnabled, botEnabled, webhookUrl,
        botToken: botToken || undefined, botUsername: botUsername || undefined,
        botAvatarUrl, publicUrl, notificationRoleId, enableMentions,
        webhookEmbedPoster, botEmbedPoster,
        webhookNotificationTypes: collectTypes(webhookNotifTypes),
        botNotificationTypes: collectTypes(botNotifTypes),
        inviteLink: inviteLink || undefined,
      })
      setAvatarFileData(null)
      setAvatarRemoving(false)
      if (onToast) onToast('Discord settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save Discord settings', 'error')
    }
  }, [enabled, webhookEnabled, botEnabled, webhookUrl, botToken, botUsername, botAvatarUrl, publicUrl, notificationRoleId, enableMentions, webhookEmbedPoster, botEmbedPoster, avatarRemoving, avatarFileData, inviteLink, webhookNotifTypes, botNotifTypes, onToast])

  const handleTest = useCallback(async () => {
    if (webhookEnabled && !webhookUrl) { if (onToast) onToast('Webhook URL required', 'error'); return }
    if (botEnabled && !botToken) { if (onToast) onToast('Bot Token required', 'error'); return }
    if (!webhookEnabled && !botEnabled) { if (onToast) onToast('Enable Webhook or Bot mode', 'error'); return }
    setTesting(true)
    try {
      if (botEnabled) {
        if (!discordTestUserId) { if (onToast) onToast('Enter Discord User ID', 'error'); setTesting(false); return }
        await adminNotifications.testDiscord({ mode: 'bot', discordUserId: discordTestUserId, botToken, botNotificationTypes: collectTypes(botNotifTypes) })
      } else {
        await adminNotifications.testDiscord({ mode: 'webhook', webhookUrl, webhookNotificationTypes: collectTypes(webhookNotifTypes) })
      }
      if (onToast) onToast('Test notification sent', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [webhookEnabled, botEnabled, webhookUrl, botToken, discordTestUserId, botNotifTypes, webhookNotifTypes, onToast])

  const handleAvatarChange = useCallback((e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { if (onToast) onToast('File must be under 2MB', 'error'); e.target.value = ''; return }
    const reader = new FileReader()
    reader.onload = (ev) => { setAvatarPreview(ev.target.result); setAvatarFileData(ev.target.result); setAvatarRemoving(false) }
    reader.readAsDataURL(file)
  }, [onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          Discord Agent
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('discord')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>
        Send Discord notifications via webhook or direct messages via bot. Both can be enabled independently.
      </p>

      <div className="toggle-row" style={{ marginBottom: 12 }}>
        <label className="slide-toggle">
          <input type="checkbox" checked={webhookEnabled} onChange={(e) => setWebhookEnabled(e.target.checked)} disabled={!enabled} />
          <span className="slide-track" />
        </label>
        <span className="toggle-label">Webhook</span>
      </div>
      {webhookEnabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20, padding: 14, background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <div>
            <label className="conn-label">Webhook URL</label>
            <input type="url" className="conn-input" placeholder="https://discord.com/api/webhooks/..." value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
          </div>
          <div>
            <label className="conn-label">Notification Role ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
            <input type="text" className="conn-input" placeholder="Role ID" value={notificationRoleId} onChange={(e) => setNotificationRoleId(e.target.value)} />
          </div>
          <Checkbox checked={enableMentions} onChange={(e) => setEnableMentions(e.target.checked)}>Enable @role mentions</Checkbox>
          <div>
            <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {WEBHOOK_NOTIFICATION_TYPES.map(t => (
                <Checkbox key={t.value} checked={getChecked(webhookNotifTypes, t.value)} onChange={() => toggleType(setWebhookNotifTypes, t.value)}>
                  {t.label}{t.meta && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{t.meta}</span>}
                </Checkbox>
              ))}
            </div>
          </div>
          <Checkbox checked={webhookEmbedPoster} onChange={(e) => setWebhookEmbedPoster(e.target.checked)}>Embed poster image</Checkbox>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
            <button className="btn-admin" onClick={handleTest} disabled={testing}>{testing ? 'Sending...' : 'Send Test'}</button>
          </div>
        </div>
      )}

      <div className="toggle-row" style={{ marginBottom: 12 }}>
        <label className="slide-toggle">
          <input type="checkbox" checked={botEnabled} onChange={(e) => setBotEnabled(e.target.checked)} disabled={!enabled} />
          <span className="slide-track" />
        </label>
        <span className="toggle-label">Bot Token</span>
      </div>
      {botEnabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20, padding: 14, background: 'var(--bg-elevated)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <div>
            <label className="conn-label">Bot Token</label>
            <input type="password" className="conn-input" placeholder="Bot token from Discord Developer Portal" value={botToken} onChange={(e) => setBotToken(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <label className="conn-label">Bot Username</label>
            <input type="text" className="conn-input" placeholder="Diskovarr" value={botUsername} onChange={(e) => setBotUsername(e.target.value)} />
          </div>
          <div>
            <label className="conn-label">Bot Avatar <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
              <img src={avatarPreview || '/discord-avatar.png'} width={48} height={48} style={{ borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)', flexShrink: 0 }} alt="Bot avatar" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label htmlFor="discord-avatar-file" className="btn-admin btn-sm" style={{ cursor: 'pointer', margin: 0 }}>Choose Image</label>
                  <input id="discord-avatar-file" type="file" accept="image/png,image/jpeg,image/gif" style={{ display: 'none' }} onChange={handleAvatarChange} />
                  <button type="button" className="btn-admin btn-sm btn-danger" style={{ display: avatarPreview ? 'inline-block' : 'none' }} onClick={() => { setAvatarPreview(null); setAvatarFileData(null); setAvatarRemoving(true) }}>Remove</button>
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>PNG/JPG/GIF · 128×128 recommended · max 2 MB</span>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <label className="conn-label" style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Or use a URL</label>
              <input type="text" className="conn-input" placeholder="https://example.com/avatar.png" value={botAvatarUrl} onChange={(e) => setBotAvatarUrl(e.target.value)} style={{ marginTop: 2 }} />
            </div>
          </div>
          <Checkbox checked={botEmbedPoster} onChange={(e) => setBotEmbedPoster(e.target.checked)}>Embed poster image</Checkbox>
          <div>
            <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {BOT_NOTIFICATION_TYPES.map(t => (
                <Checkbox key={t.value} checked={getChecked(botNotifTypes, t.value)} onChange={() => toggleType(setBotNotifTypes, t.value)}>
                  {t.label}{t.meta && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{t.meta}</span>}
                </Checkbox>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label className="conn-label" style={{ marginBottom: 4 }}>Your Discord User ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(for test DM)</span></label>
              <input type="text" className="conn-input" style={{ maxWidth: 240 }} placeholder="Discord user ID" value={discordTestUserId} onChange={(e) => setDiscordTestUserId(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
              <button className="btn-admin" onClick={handleTest} disabled={testing}>{testing ? 'Sending...' : 'Send Test DM'}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <label className="conn-label">Discord Server Invite Link <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
        <input type="url" className="conn-input" placeholder="https://discord.gg/..." value={inviteLink} onChange={(e) => setInviteLink(e.target.value)} />
        <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: 6 }}>Use a non-expiring invite so users can join for bot DMs.</p>
      </div>
    </section>
  )
}
