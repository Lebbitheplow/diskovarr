import React from 'react'
import { PROVIDERS } from './constants'

export default function ProviderSidebar({ active, onChange, providerEnabled }) {
  return (
    <nav className="notif-sidebar" aria-label="Notification providers">
      {PROVIDERS.map((p) => {
        if (p.id === 'broadcast') return (
          <button
            key={p.id}
            className={`notif-sidebar-item ${active === p.id ? 'active' : ''}`}
            onClick={() => onChange(p.id)}
            style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
          >
            <span style={{ fontSize: '0.88rem', fontWeight: active === p.id ? 600 : 500 }}>Broadcast</span>
            <span className="notif-sidebar-sub">All users</span>
          </button>
        )
        const enabled = providerEnabled ? providerEnabled[p.id] : undefined
        return (
          <button
            key={p.id}
            className={`notif-sidebar-item ${active === p.id ? 'active' : ''}`}
            onClick={() => onChange(p.id)}
          >
            <span
              className={`notif-status-dot ${enabled === false ? 'disabled' : ''}`}
              style={{ display: enabled === undefined ? 'none' : undefined }}
            />
            <span style={{ fontSize: '0.88rem', fontWeight: active === p.id ? 600 : 500 }}>{p.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
