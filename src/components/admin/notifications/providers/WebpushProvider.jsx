import React, { useState, useCallback } from 'react'
import { adminNotifications } from '../../../../services/adminApi'

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function WebpushProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [embedPoster, setEmbedPoster] = useState(!!initial?.embedPoster)
  const [vapidKey, setVapidKey] = useState(initial?.vapidPublic || '')
  const [testing, setTesting] = useState(false)

  const handleSave = useCallback(async () => {
    try {
      await adminNotifications.setWebpush({ enabled, embedPoster })
      if (onToast) onToast('WebPush settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, embedPoster, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testWebpush({})
      if (onToast) onToast('Test sent via WebPush', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          WebPush
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('webpush')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Send browser push notifications to users. Users opt-in from their profile settings. VAPID keys are auto-generated.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <Checkbox checked={embedPoster} onChange={(e) => setEmbedPoster(e.target.checked)}>Include poster image in push</Checkbox>
        {vapidKey && (
          <div>
            <label className="conn-label">VAPID Public Key</label>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-all', background: 'var(--bg-surface)', padding: 8, borderRadius: 4, border: '1px solid var(--border)' }}>{vapidKey}</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
          <button className="btn-admin" onClick={handleTest} disabled={testing}>{testing ? 'Sending...' : 'Send Test'}</button>
        </div>
      </div>
    </section>
  )
}
