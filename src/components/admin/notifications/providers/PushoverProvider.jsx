import React, { useState, useCallback } from 'react'
import { adminNotifications } from '../../../../services/adminApi'
import { PUSHOVER_NOTIFICATION_TYPES, PUSHOVER_SOUNDS, DEFAULT_PUSHOVER_TYPES } from '../constants'

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function PushoverProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [appToken, setAppToken] = useState(initial?.appToken || '')
  const [userKey, setUserKey] = useState(initial?.userKey || '')
  const [sound, setSound] = useState(initial?.sound || '')
  const [embedPoster, setEmbedPoster] = useState(!!initial?.embedPoster)
  const [notifTypes, setNotifTypes] = useState(
    (initial?.notificationTypes || []).length > 0 ? initial.notificationTypes : [...DEFAULT_PUSHOVER_TYPES]
  )
  const [testing, setTesting] = useState(false)

  const getChecked = useCallback((types, value) => types.includes(value), [])
  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev => prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value])
  }, [])

  const handleSave = useCallback(async () => {
    try {
      await adminNotifications.setPushover({
        enabled, appToken, userKey, sound: sound || undefined, embedPoster,
        notificationTypes: notifTypes,
      })
      if (onToast) onToast('Pushover settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, appToken, userKey, sound, embedPoster, notifTypes, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testPushover({ appToken, userKey, notificationTypes: notifTypes })
      if (onToast) onToast('Test notification sent', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [appToken, userKey, notifTypes, onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          Pushover Agent
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('pushover')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 20 }}>Send push notifications via Pushover to your devices.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <div>
          <label className="conn-label">Application API Token</label>
          <input type="text" className="conn-input" placeholder="App token from pushover.net" value={appToken} onChange={(e) => setAppToken(e.target.value)} />
          <span className="conn-hint"><a href="https://pushover.net/api#registration" target="_blank" rel="noopener noreferrer">Register an application</a> for Diskovarr</span>
        </div>
        <div>
          <label className="conn-label">User or Group Key</label>
          <input type="text" className="conn-input" placeholder="User/group key" value={userKey} onChange={(e) => setUserKey(e.target.value)} />
          <span className="conn-hint">Your 30-character <a href="https://pushover.net/api#identifiers" target="_blank" rel="noopener noreferrer">User or Group ID</a></span>
        </div>
        <Checkbox checked={embedPoster} onChange={(e) => setEmbedPoster(e.target.checked)}>Embed poster image</Checkbox>
        <div>
          <label className="conn-label">Notification Sound</label>
          <select className="conn-input" value={sound} onChange={(e) => setSound(e.target.value)}>
            {PUSHOVER_SOUNDS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PUSHOVER_NOTIFICATION_TYPES.map(t => (
              <Checkbox key={t.value} checked={getChecked(notifTypes, t.value)} onChange={() => toggleType(setNotifTypes, t.value)}>{t.label}</Checkbox>
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
