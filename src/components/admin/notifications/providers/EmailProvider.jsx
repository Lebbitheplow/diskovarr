import React, { useState, useCallback } from 'react'
import { adminNotifications } from '../../../../services/adminApi'
import { SHARED_NOTIFICATION_TYPES, DEFAULT_AGENT_TYPES, SMTP_PORTS } from '../constants'

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function EmailProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [emailFrom, setEmailFrom] = useState(initial?.emailFrom || '')
  const [smtpHost, setSmtpHost] = useState(initial?.smtpHost || '')
  const [smtpPort, setSmtpPort] = useState(initial?.smtpPort || 587)
  const [secure, setSecure] = useState(!!initial?.secure)
  const [requireTls, setRequireTls] = useState(!!initial?.requireTls)
  const [allowSelfSigned, setAllowSelfSigned] = useState(!!initial?.allowSelfSigned)
  const [authUser, setAuthUser] = useState(initial?.authUser || '')
  const [authPass, setAuthPass] = useState(initial?.authPass || '')
  const [senderName, setSenderName] = useState(initial?.senderName || 'Diskovarr')
  const [notifTypes, setNotifTypes] = useState(
    (initial?.notificationTypes || []).length > 0 ? initial.notificationTypes : [...DEFAULT_AGENT_TYPES]
  )
  const [testing, setTesting] = useState(false)

  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev => prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value])
  }, [])

  const handleSave = useCallback(async () => {
    try {
      await adminNotifications.setEmail({
        enabled, emailFrom, smtpHost, smtpPort, secure, requireTls, allowSelfSigned,
        authUser, authPass, senderName, embedPoster: true, notificationTypes: notifTypes,
      })
      if (onToast) onToast('Email settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, emailFrom, smtpHost, smtpPort, secure, requireTls, allowSelfSigned, authUser, authPass, senderName, notifTypes, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testEmail({ emailFrom, smtpHost, smtpPort, secure, requireTls, allowSelfSigned, authUser, authPass, senderName })
      if (onToast) onToast('Test email sent', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [emailFrom, smtpHost, smtpPort, secure, requireTls, allowSelfSigned, authUser, authPass, senderName, onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          Email (SMTP)
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('email')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Send email notifications via SMTP to users who have email addresses on file.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <div>
          <label className="conn-label">Sender Email</label>
          <input type="email" className="conn-input" placeholder="diskovarr@example.com" value={emailFrom} onChange={(e) => setEmailFrom(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">Sender Name</label>
          <input type="text" className="conn-input" placeholder="Diskovarr" value={senderName} onChange={(e) => setSenderName(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 2 }}>
            <label className="conn-label">SMTP Host</label>
            <input type="text" className="conn-input" placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label className="conn-label">SMTP Port</label>
            <select className="conn-input" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value))}>
              {SMTP_PORTS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="conn-label">SMTP Username <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input type="text" className="conn-input" placeholder="Username" value={authUser} onChange={(e) => setAuthUser(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">SMTP Password <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input type="password" className="conn-input" placeholder="Password" value={authPass} onChange={(e) => setAuthPass(e.target.value)} autoComplete="off" />
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Checkbox checked={secure} onChange={(e) => setSecure(e.target.checked)}>Use implicit TLS (port 465)</Checkbox>
          <Checkbox checked={requireTls} onChange={(e) => setRequireTls(e.target.checked)}>Require STARTTLS</Checkbox>
          <Checkbox checked={allowSelfSigned} onChange={(e) => setAllowSelfSigned(e.target.checked)}>Allow self-signed certs</Checkbox>
        </div>
        <div>
          <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {SHARED_NOTIFICATION_TYPES.map(t => (
              <Checkbox key={'em-'+t.value} checked={notifTypes.includes(t.value)} onChange={() => toggleType(setNotifTypes, t.value)}>
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
