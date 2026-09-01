import React, { useState } from 'react'
import { userApi } from '../../../services/api'
import { useTranslation } from 'react-i18next'

export default function EmailUserProvider({ settings, onToast, onSave }) {
  const { t } = useTranslation()
  const [address, setAddress] = useState(settings?.email_address || '')
  const [enabled, setEnabled] = useState(!!settings?.email_enabled)

  const handleSave = async () => {
    const addr = address.trim()
    // Enabling without an address is the state that silently sends nothing,
    // so it is worth catching here rather than failing quietly later.
    if (enabled && !addr) {
      if (onToast) onToast('Enter an email address to receive notifications at', 'error')
      return
    }
    try {
      await userApi.updateSettings({ email_address: addr || null, email_enabled: enabled })
      if (onToast) onToast('Email settings saved', 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">{t('Email')}</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>
        {t('Receive notification emails at an address of your choosing. Your address is stored only for this purpose and only while email notifications are on — clear the field and save to remove it.')}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="conn-label">{t('Email Address')}</label>
          <input
            type="email"
            className="conn-input"
            placeholder={t('you@example.com')}
            autoComplete="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">{t('Enable email notifications')}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>{t('Save')}</button>
        </div>
      </div>
    </section>
  )
}
