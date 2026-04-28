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

export default function TelegramProvider({ initial, onToast, onOpenAgentInfo }) {
  const [enabled, setEnabled] = useState(initial?.enabled || false)
  const [botAPI, setBotAPI] = useState(initial?.botAPI || '')
  const [chatId, setChatId] = useState(initial?.chatId || '')
  const [messageThreadId, setMessageThreadId] = useState(initial?.messageThreadId || '')
  const [sendSilently, setSendSilently] = useState(!!initial?.sendSilently)
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
      await adminNotifications.setTelegram({
        enabled, botAPI, chatId, messageThreadId, sendSilently, embedPoster, notificationTypes: notifTypes,
      })
      if (onToast) onToast('Telegram settings saved', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to save', 'error')
    }
  }, [enabled, botAPI, chatId, messageThreadId, sendSilently, embedPoster, notifTypes, onToast])

  const handleTest = useCallback(async () => {
    setTesting(true)
    try {
      await adminNotifications.testTelegram({ botAPI, chatId, messageThreadId, sendSilently })
      if (onToast) onToast('Test sent via Telegram', 'success')
    } catch (err) {
      if (onToast) onToast(err.message || 'Failed to send test', 'error')
    } finally { setTesting(false) }
  }, [botAPI, chatId, messageThreadId, sendSilently, onToast])

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">
          Telegram
          <button type="button" className="agent-info-btn" onClick={() => onOpenAgentInfo?.('telegram')} title="How to configure" style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 'inherit', color: 'inherit', padding: 0, verticalAlign: 'middle' }}>&#9432;</button>
        </h2>
        <label className="slide-toggle" style={{ flexShrink: 0 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="slide-track" />
        </label>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Send Telegram notifications via a bot. Users can configure their own chat IDs in profile settings.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        <div>
          <label className="conn-label">Bot API Token</label>
          <input type="password" className="conn-input" placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" value={botAPI} onChange={(e) => setBotAPI(e.target.value)} autoComplete="off" />
          <span className="conn-hint">Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> on Telegram</span>
        </div>
        <div>
          <label className="conn-label">Chat ID</label>
          <input type="text" className="conn-input" placeholder="-1001234567890 or 123456789" value={chatId} onChange={(e) => setChatId(e.target.value)} />
          <span className="conn-hint">Group chat ID (with leading dash) or personal chat ID</span>
        </div>
        <div>
          <label className="conn-label">Message Thread ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span></label>
          <input type="text" className="conn-input" placeholder="Thread ID" value={messageThreadId} onChange={(e) => setMessageThreadId(e.target.value)} />
        </div>
        <Checkbox checked={sendSilently} onChange={(e) => setSendSilently(e.target.checked)}>Send silently (no notification sound)</Checkbox>
        <Checkbox checked={embedPoster} onChange={(e) => setEmbedPoster(e.target.checked)}>Send as photo with caption</Checkbox>
        <div>
          <p style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)', margin: '0 0 8px' }}>Notification Types</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {SHARED_NOTIFICATION_TYPES.map(t => (
              <Checkbox key={'tg-'+t.value} checked={notifTypes.includes(t.value)} onChange={() => toggleType(setNotifTypes, t.value)}>
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
