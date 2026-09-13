import React from 'react'
import { visibleNotifTypes } from '../../components/admin/notifications/constants'
import { useTranslation } from 'react-i18next'

export default function NotificationTypesPanel({ types, onChange, isElevated, isAdmin }) {
  const { t } = useTranslation()
  const allTypes = visibleNotifTypes({ isAdmin, isElevated })

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <p className="settings-section-title">{t('Notification Types')}</p>
      <p className="settings-desc" style={{ marginBottom: 12 }}>{t('Choose which events trigger notifications across all your enabled channels.')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {allTypes.map(({ key, label, desc }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              className="themed-checkbox"
              checked={types[key] !== false}
              onChange={(e) => onChange(key, e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <span>
              <strong style={{ color: '#fff', fontSize: '0.88rem' }}>{t(label)}</strong>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}> — {t(desc)}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
