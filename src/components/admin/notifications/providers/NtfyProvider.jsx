import React, { useState, useCallback } from 'react'
import { adminNotifications } from '../../../../services/adminApi'
import { SHARED_NOTIFICATION_TYPES, DEFAULT_AGENT_TYPES, NTFY_PRIORITIES } from '../constants'

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function NtfyProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [url, setUrl] = useState(initial?.url || '')
  const [topic, setTopic] = useState(initial?.topic || '')
  const [authMethod, setAuthMethod] = useState(initial?.authMethod || 'none')
  const [token, setToken] = useState(initial?.token || '')
  const [username, setUsername] = useState(initial?.username || '')
  const [password, setPassword] = useState(initial?.password || '')
  const [priority, setPriority] = useState(initial?.priority ?? 3)
  const [embedPoster, setEmbedPoster] = useState(!!initial?.embedPoster)
  const [notifTypes, setNotifTypes] = useState(
    (initial?.notificationTypes || []).length > 0 ? initial.notificationTypes : [...DEFAULT_AGENT_TYPES]
  )
  const [testing, setTesting] = useState(false)

  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev => prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value])
  }, [])

  const handleSave = useCallback(async () => {
    try {
      await adminNotifications.setNtfy({
        enabled, url, topic, authMethod, token, username, password, priority, embedPoster, notificationTypes: notifTypes,
      })
      if (onToast) onToast('ntfy settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, url, topic, authMethod, token, username, password, priority, embedPoster, notifTypes, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testNtfy({ url, topic, authMethod, token, username, password, priority })
      if (onToast) onToast('Test sent via ntfy', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [url, topic, authMethod, token, username, password, priority, onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          ntfy
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('ntfy')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Send notifications via ntfy (self-hosted or ntfy.sh cloud). Supports markdown and images.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <div>
          <label className="conn-label">Server URL</label>
          <input type="url" className="conn-input" placeholder="https://ntfy.sh or https://ntfy.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">Topic</label>
          <input type="text" className="conn-input" placeholder="diskovarr" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">Authentication <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <select className="conn-input" value={authMethod} onChange={(e) => setAuthMethod(e.target.value)} style={{ marginBottom: 8 }}>
            <option value="none">None</option>
            <option value="token">Bearer Token</option>
            <option value="basic">Username / Password</option>
          </select>
          {authMethod === 'token' && <input type="password" className="conn-input" placeholder="Bearer token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
          {authMethod === 'basic' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="text" className="conn-input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
              <input type="password" className="conn-input" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
          )}
        </div>
        <div>
          <label className="conn-label">Priority</label>
          <select className="conn-input" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {NTFY_PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <Checkbox checked={embedPoster} onChange={(e) => setEmbedPoster(e.target.checked)}>Attach poster image</Checkbox>
        <div>
          <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {SHARED_NOTIFICATION_TYPES.map(t => (
              <Checkbox key={'nf-'+t.value} checked={notifTypes.includes(t.value)} onChange={() => toggleType(setNotifTypes, t.value)}>
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
