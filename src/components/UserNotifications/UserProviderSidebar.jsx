import React from 'react'
import { PROVIDERS } from '../admin/notifications/constants'

const ICON_MAP = Object.fromEntries(PROVIDERS.map(p => [p.id, p.icon]))

export default function UserProviderSidebar({ providers, active, onChange, providerEnabled }) {
  return (
    <nav className="notif-sidebar" aria-label="Notification providers">
      <button
        className={`notif-sidebar-item ${active === 'types' ? 'active' : ''}`}
        onClick={() => onChange('types')}
      >
        <svg className="notif-provider-icon" aria-hidden="true">
          <use href="/icons.svg#notif-types-icon" />
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: '0.88rem', fontWeight: active === 'types' ? 600 : 500 }}>Types</span>
          <span className="notif-sidebar-sub">What to receive</span>
        </div>
      </button>
      {providers.map(p => (
        <button
          key={p.id}
          className={`notif-sidebar-item ${active === p.id ? 'active' : ''}`}
          onClick={() => onChange(p.id)}
        >
          {ICON_MAP[p.id] && (
            <svg className="notif-provider-icon" aria-hidden="true">
              <use href={`/icons.svg#${ICON_MAP[p.id]}`} />
            </svg>
          )}
          <span style={{ fontSize: '0.88rem', fontWeight: active === p.id ? 600 : 500 }}>{p.label}</span>
          {providerEnabled && (
            <span
              className={`notif-status-dot${providerEnabled[p.id] ? '' : ' disabled'}`}
              style={{ marginLeft: 'auto' }}
            />
          )}
        </button>
      ))}
      {providers.length === 0 && (
        <div style={{ padding: '12px 0', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
          No providers available. Contact your admin.
        </div>
      )}
    </nav>
  )
}
