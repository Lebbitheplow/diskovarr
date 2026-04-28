import React from 'react'

export default function UserProviderSidebar({ providers, active, onChange }) {
  return (
    <nav className="notif-sidebar" aria-label="Notification providers">
      <button
        className={`notif-sidebar-item ${active === 'types' ? 'active' : ''}`}
        onClick={() => onChange('types')}
        style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
      >
        <span style={{ fontSize: '0.88rem', fontWeight: active === 'types' ? 600 : 500 }}>Types</span>
        <span className="notif-sidebar-sub">What to receive</span>
      </button>
      {providers.map(p => (
        <button
          key={p.id}
          className={`notif-sidebar-item ${active === p.id ? 'active' : ''}`}
          onClick={() => onChange(p.id)}
        >
          <span style={{ fontSize: '0.88rem', fontWeight: active === p.id ? 600 : 500 }}>{p.label}</span>
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
