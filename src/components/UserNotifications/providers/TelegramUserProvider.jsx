import React, { useState } from 'react'

export default function TelegramUserProvider({ settings, onToast, onSave }) {
  const [chatId, setChatId] = useState(settings?.telegram_chat_id || '')
  const [threadId, setThreadId] = useState(settings?.telegram_message_thread_id || '')
  const [silent, setSilent] = useState(!!settings?.telegram_send_silently)
  const [enabled, setEnabled] = useState(!!settings?.telegram_enabled)

  const handleSave = async () => {
    try {
      const { userApi } = await import('../../../services/api')
      await userApi.updateSettings({
        telegram_chat_id: chatId || null,
        telegram_message_thread_id: threadId || null,
        telegram_send_silently: silent,
        telegram_enabled: enabled,
      })
      if (onToast) onToast('Telegram settings saved', 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">Telegram</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Get notifications via Telegram. Your admin must have configured a Telegram bot.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="conn-label">Chat ID</label>
          <input type="text" className="conn-input" placeholder="Chat ID" value={chatId} onChange={(e) => setChatId(e.target.value)} />
        </div>
        <div>
          <label className="conn-label">Thread ID <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional, forum topics)</span></label>
          <input type="text" className="conn-input" placeholder="Thread ID" value={threadId} onChange={(e) => setThreadId(e.target.value)} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem' }}>
          <input type="checkbox" className="themed-checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} />
          Send silently (no sound)
        </label>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">Enable Telegram notifications</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </section>
  )
}
