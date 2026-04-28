import React from 'react'
import { USER_NOTIF_TYPES, ELEVATED_NOTIF_TYPES, ADMIN_ONLY_NOTIF_TYPES } from '../../components/admin/notifications/constants'

export default function NotificationTypesPanel({ types, onChange, isElevated, isAdmin }) {
  const allTypes = [
    ...USER_NOTIF_TYPES,
    ...(isElevated ? ELEVATED_NOTIF_TYPES : []),
    ...(isAdmin ? ADMIN_ONLY_NOTIF_TYPES : []),
  ]

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <p className="settings-section-title">Notification Types</p>
      <p className="settings-desc" style={{ marginBottom: 12 }}>Choose which events trigger notifications across all your enabled channels.</p>
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
              <strong style={{ color: '#fff', fontSize: '0.88rem' }}>{label}</strong>
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}> — {desc}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  )
}
