import React, { useState } from 'react'
import { userApi } from '../../../services/api'

export default function DiscordUserProvider({ settings, onToast, onSave }) {
  const [userId, setUserId] = useState(settings?.discord_user_id || '')
  const [enabled, setEnabled] = useState(!!settings?.discord_enabled)

  const handleSave = async () => {
    try {
      await userApi.updateSettings({ discord_user_id: userId || null, discord_enabled: enabled })
      if (onToast) onToast('Discord settings saved', 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }

  const handleTest = async () => {
    if (!userId?.trim()) { if (onToast) onToast('Enter your Discord User ID', 'error'); return }
    try {
      const { data } = await userApi.testDiscord(userId.trim())
      if (data.ok) if (onToast) onToast('Test message sent!', 'success')
      else if (onToast) onToast(data.error || 'Send failed', 'error')
    } catch (e) {
      if (onToast) onToast('Send failed', 'error')
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">Discord (Bot DMs)</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Receive direct message notifications from the Diskovarr bot.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 6px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Desktop:</strong> Enable Developer Mode (Settings {'>'} Advanced), right-click your avatar {'>'} Copy User ID.
          </p>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '0 0 10px' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Mobile:</strong> Tap your profile in a message, tap the &#8942; {'>'} Copy User ID.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="text" className="conn-input" placeholder="e.g. 185234567891234560" value={userId} onChange={(e) => setUserId(e.target.value)} />
            <button className="btn-admin" onClick={handleTest}>Send Test</button>
          </div>
        </div>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">Enable Discord notifications</span>
        </div>
        {settings?.discord_invite_link && (
          <div style={{ background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            You must be a member of the admin&apos;s Discord server for the bot to send you DMs.
            <a href={settings.discord_invite_link} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 8, padding: '6px 14px', background: 'var(--accent)', color: '#000', borderRadius: 6, fontWeight: 600, textDecoration: 'none', fontSize: '0.82rem' }}>Join Server</a>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </section>
  )
}
