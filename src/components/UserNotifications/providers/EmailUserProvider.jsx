import React, { useState } from 'react'

export default function EmailUserProvider({ settings, onToast, onSave }) {
  const [enabled, setEnabled] = useState(!!settings?.email_enabled)

  const handleSave = async () => {
    try {
      const { userApi } = await import('../../../services/api')
      await userApi.updateSettings({ email_enabled: enabled })
      if (onToast) onToast('Email settings saved', 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">Email</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>Receive notification emails. Requires an email address on file.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">Enable email notifications</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </section>
  )
}
