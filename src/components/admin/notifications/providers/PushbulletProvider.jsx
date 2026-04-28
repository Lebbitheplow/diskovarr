import React, { useState, useCallback } from 'react'
import { adminNotifications } from '../../../../services/adminApi'
import { SHARED_NOTIFICATION_TYPES, DEFAULT_AGENT_TYPES } from '../constants'

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function PushbulletProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [accessToken, setAccessToken] = useState(initial?.accessToken || '')
  const [channelTag, setChannelTag] = useState(initial?.channelTag || '')
  const [notifTypes, setNotifTypes] = useState(
    (initial?.notificationTypes || []).length > 0 ? initial.notificationTypes : [...DEFAULT_AGENT_TYPES]
  )
  const [testing, setTesting] = useState(false)

  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev => prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value])
  }, [])

  const handleSave = useCallback(async () => {
    try {
      await adminNotifications.setPushbullet({ enabled, accessToken, channelTag, notificationTypes: notifTypes })
      if (onToast) onToast('Pushbullet settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, accessToken, channelTag, notifTypes, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testPushbullet({ accessToken })
      if (onToast) onToast('Test sent via Pushbullet', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [accessToken, onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          Pushbullet
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('pushbullet')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Send push notifications via Pushbullet. Users can set their own tokens in profile settings.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <div>
          <label className="conn-label">Access Token</label>
          <input type="password" className="conn-input" placeholder="o.YourAccessHere" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} autoComplete="off" />
          <span className="conn-hint">Get from <a href="https://www.pushbullet.com/#settings" target="_blank" rel="noopener noreferrer">Pushbullet Settings</a></span>
        </div>
        <div>
          <label className="conn-label">Channel Tag <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input type="text" className="conn-input" placeholder="diskovarr" value={channelTag} onChange={(e) => setChannelTag(e.target.value)} />
        </div>
        <div>
          <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {SHARED_NOTIFICATION_TYPES.map(t => (
              <Checkbox key={'pb-'+t.value} checked={notifTypes.includes(t.value)} onChange={() => toggleType(setNotifTypes, t.value)}>
                {t.label}{t.meta && <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{t.meta}</span>}
              </Checkbox>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
          <button className="btn-admin" onClick={handleTest} disabled={testing}>{testing ? 'Sending...' : 'Send Test'}</button>
        </div>
      </div>
    </section>
  )
}
