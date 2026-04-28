import React, { useState, useCallback } from 'react'
import { adminNotifications } from '../../../../services/adminApi'
import { SHARED_NOTIFICATION_TYPES, DEFAULT_AGENT_TYPES, DEFAULT_WEBHOOK_PAYLOAD, decodeWebhookPayload, encodeWebhookPayload } from '../constants'

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
      <input type="checkbox" className="themed-checkbox" checked={checked} onChange={onChange} />
      {children}
    </label>
  )
}

export default function WebhookProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [url, setUrl] = useState(initial?.webhookUrl || '')
  const [jsonPayload, setJsonPayload] = useState(
    decodeWebhookPayload(initial?.jsonPayload || DEFAULT_WEBHOOK_PAYLOAD) || decodeWebhookPayload(DEFAULT_WEBHOOK_PAYLOAD)
  )
  const [authHeader, setAuthHeader] = useState(initial?.authHeader || '')
  const [customHeaders, setCustomHeaders] = useState(initial?.customHeaders || [])
  const [supportVariables, setSupportVariables] = useState(!!initial?.supportVariables)
  const [notifTypes, setNotifTypes] = useState(
    (initial?.notificationTypes || []).length > 0 ? initial.notificationTypes : [...DEFAULT_AGENT_TYPES]
  )
  const [testing, setTesting] = useState(false)

  const toggleType = useCallback((setTypes, value) => {
    setTypes(prev => prev.includes(value) ? prev.filter(t => t !== value) : [...prev, value])
  }, [])

  const handleSave = useCallback(async () => {
    try {
      await adminNotifications.setWebhook({
        enabled, webhookUrl: url, jsonPayload: encodeWebhookPayload(jsonPayload),
        authHeader, customHeaders, supportVariables, embedPoster: true, notificationTypes: notifTypes,
      })
      if (onToast) onToast('Webhook settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, url, jsonPayload, authHeader, customHeaders, supportVariables, notifTypes, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testWebhook({
        webhookUrl: url, jsonPayload: encodeWebhookPayload(jsonPayload), authHeader,
        customHeaders, supportVariables, notificationTypes: notifTypes,
      })
      if (onToast) onToast('Test sent via webhook', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [url, jsonPayload, authHeader, customHeaders, supportVariables, notifTypes, onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          Webhook
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('webhook')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Send a custom JSON payload to any endpoint. Supports template variables like <code style={{ fontSize: '0.8rem' }}>{'{{notification_type}}'}</code>.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <div>
          <label className="conn-label">Webhook URL</label>
          <input type="url" className="conn-input" placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">Authorization Header <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input type="text" className="conn-input" placeholder="Bearer your-token" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">JSON Payload Template</label>
          <textarea className="conn-input" rows={6} style={{ fontFamily: 'monospace', fontSize: '0.8rem' }} value={jsonPayload} onChange={(e) => setJsonPayload(e.target.value)} />
        </div>
        <Checkbox checked={supportVariables} onChange={(e) => setSupportVariables(e.target.checked)}>Enable variables in URL</Checkbox>
        <div>
          <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {SHARED_NOTIFICATION_TYPES.map(t => (
              <Checkbox key={'wh-'+t.value} checked={notifTypes.includes(t.value)} onChange={() => toggleType(setNotifTypes, t.value)}>
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
