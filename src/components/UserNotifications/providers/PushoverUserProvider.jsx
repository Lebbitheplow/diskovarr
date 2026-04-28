import React, { useState } from 'react'
import { userApi } from '../../../services/api'

export default function PushoverUserProvider({ settings, onToast, onSave }) {
  const [userKey, setUserKey] = useState(settings?.pushover_user_key || '')
  const [enabled, setEnabled] = useState(!!settings?.pushover_enabled)

  const handleSave = async () => {
    try {
      await userApi.updateSettings({ pushover_user_key: userKey || null, pushover_enabled: enabled })
      if (onToast) onToast('Pushover settings saved', 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }

  const handleTest = async () => {
    if (!userKey?.trim()) { if (onToast) onToast('Enter your Pushover user key', 'error'); return }
    try {
      const { data } = await userApi.testPushover(userKey.trim())
      if (data.ok) if (onToast) onToast('Test message sent!', 'success')
      else if (onToast) onToast(data.error || 'Send failed', 'error')
    } catch (e) {
      if (onToast) onToast('Send failed', 'error')
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">Pushover</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Receive personal push notifications via Pushover.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="conn-label">Pushover User Key</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="text" className="conn-input" placeholder="User key..." value={userKey} onChange={(e) => setUserKey(e.target.value)} />
            <button className="btn-admin" onClick={handleTest}>Send Test</button>
          </div>
        </div>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">Enable Pushover notifications</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </section>
  )
}
