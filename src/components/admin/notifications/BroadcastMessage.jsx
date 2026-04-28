import React, { useState } from 'react'
import { adminNotifications } from '../../../services/adminApi'

export default function BroadcastMessage({ onToast, onOpenAgentInfo }) {
  const [msg, setMsg] = useState('')
  const [result, setResult] = useState('')
  const [sending, setSending] = useState(false)

  const handleBroadcast = async () => {
    if (!msg.trim()) {
      if (onToast) onToast('Please enter a message', 'error')
      return
    }
    setSending(true)
    setResult('')
    try {
      const res = await adminNotifications.broadcast(msg.trim())
      setResult(res.data?.message || 'Notification sent')
      if (onToast) onToast('Broadcast sent', 'success')
    } catch (err) {
      setResult(err.message || 'Failed to send broadcast')
      if (onToast) onToast(err.message || 'Failed to send broadcast', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="admin-section notif-broadcast">
      <div className="admin-section-header">
        <h2 className="section-title">Broadcast Message</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>
        Send a custom message to all users via all configured notification channels (in-app bell, Discord, and Pushover).
      </p>
      <textarea
        className="conn-input"
        rows={3}
        placeholder="Type a message to send to all users..."
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        style={{ resize: 'vertical', minHeight: 80, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
        <button className="btn-admin btn-primary" onClick={handleBroadcast} disabled={sending}>
          {sending ? 'Sending...' : 'Notify All Users'}
        </button>
        <span style={{ fontSize: '0.82rem' }}>{result}</span>
      </div>
    </section>
  )
}
