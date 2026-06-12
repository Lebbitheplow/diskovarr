import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function PushbulletUserProvider({ settings, onToast, onSave }) {
  const { t } = useTranslation()
  const [token, setToken] = useState(settings?.pushbullet_access_token || '')
  const [enabled, setEnabled] = useState(!!settings?.pushbullet_enabled)

  const handleSave = async () => {
    try {
      const { userApi } = await import('../../../services/api')
      await userApi.updateSettings({ pushbullet_access_token: token || null, pushbullet_enabled: enabled })
      if (onToast) onToast('Pushbullet settings saved', 'success')
      if (onSave) onSave()
    } catch (e) {
      if (onToast) onToast(e.message || 'Save failed', 'error')
    }
  }

  return (
    <section className="admin-section">
      <div className="admin-section-header">
        <h2 className="section-title">{t('Pushbullet')}</h2>
      </div>
      <p className="section-desc" style={{ marginBottom: 16 }}>{t('Receive push notifications via Pushbullet.')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label className="conn-label">{t('Access Token')}</label>
          <input type="password" className="conn-input" placeholder={t('o.YourToken')} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <span className="conn-hint">{t('Get from')} <a href="https://www.pushbullet.com/#settings" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{t('Pushbullet Settings')}</a></span>
        </div>
        <div className="toggle-row">
          <label className="slide-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="slide-track" />
          </label>
          <span className="toggle-label">{t('Enable Pushbullet notifications')}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button className="btn-admin btn-primary" onClick={handleSave}>{t('Save')}</button>
        </div>
      </div>
    </section>
  )
}
