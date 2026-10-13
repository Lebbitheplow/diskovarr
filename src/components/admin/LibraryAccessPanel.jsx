import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import adminApi from '../../services/adminApi'

// Admin → Users: per-user library access mirrored from Plex sharing and
// Jellyfin user policy (server/services/libraryAccess) — the kill switch, each
// user's snapshot, and a manual refresh.

const GRID = 'minmax(140px,1fr) 110px minmax(180px,1.6fr) 90px minmax(120px,1fr)'

const ROLE_LABELS = {
  owner: 'Owner',
  shared: 'Shared',
  home: 'Plex Home',
  removed: 'No access',
  jellyfin: 'Jellyfin',
  unknown: 'Unknown',
}

function useAgo() {
  const { t } = useTranslation()
  return useCallback((ts) => {
    if (!ts) return t('Never')
    const min = Math.floor((Date.now() - ts * 1000) / 60000)
    if (min < 1) return t('Just now')
    if (min < 60) return t('{{n}}m ago', { n: min })
    if (min < 24 * 60) return t('{{n}}h ago', { n: Math.floor(min / 60) })
    return t('{{n}}d ago', { n: Math.floor(min / 1440) })
  }, [t])
}

function SectionList({ snap }) {
  const { t } = useTranslation()
  if (snap.role === 'removed') return <span style={{ color: 'var(--text-muted)' }}>{t('None')}</span>
  if (snap.allSections && !snap.filteredSections.length) return <span>{t('All libraries')}</span>
  const filtered = new Set(snap.filteredSections.map(s => s.id))
  const names = snap.sections.map(s => ({ ...s, partial: filtered.has(s.id) }))
  if (!names.length) return <span style={{ color: 'var(--text-muted)' }}>{t('None')}</span>
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {snap.allSections && <span>{t('All libraries')}</span>}
      {names.map(s => (
        <span
          key={s.id}
          title={s.partial ? t('Partial: {{n}} titles visible (content restrictions)', { n: snap.visibleItems }) : s.id}
          style={{ padding: '1px 6px', borderRadius: 6, fontSize: '0.75rem', background: 'var(--bg-elevated)', border: s.partial ? '1px dashed var(--accent)' : '1px solid var(--border)' }}
        >
          {s.title || s.id}{s.partial ? ' *' : ''}
        </span>
      ))}
    </span>
  )
}

export default function LibraryAccessPanel({ onToast }) {
  const { t } = useTranslation()
  const ago = useAgo()
  const [data, setData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get('/library-access')
      setData(res.data)
    } catch (err) {
      onToast?.(err.message || t('Failed to load library access'), 'error')
    }
  }, [onToast, t])

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
  useEffect(() => { load() }, [load])

  const handleToggle = async (enforced) => {
    setSaving(true)
    try {
      await adminApi.post('/library-access/settings', { enforced })
      setData(d => (d ? { ...d, enforced } : d))
      onToast?.(enforced ? t('Library sharing is respected') : t('Every user now sees every library'))
    } catch (err) {
      onToast?.(err.message || t('Failed to save'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      // A full refresh can outlast the default client timeout
      const res = await adminApi.post('/library-access/refresh', null, { timeout: 60000 })
      setData(res.data)
      onToast?.(t('Library access refreshed'))
    } catch (err) {
      onToast?.(err.message || t('Refresh failed'), 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const rows = (data?.users || []).flatMap(u => (u.snapshots.length ? u.snapshots : [null]).map(snap => ({ u, snap })))

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('Library Access')}</h2>
          <p className="section-desc" style={{ margin: 0 }}>
            {t('Users only see titles from the libraries their Plex or Jellyfin account can reach, including Plex content restrictions and Jellyfin parental controls. The server owner sees everything; admin screens are never filtered.')}
          </p>
        </div>
        <div className="conn-toggle-row" style={{ margin: 0, gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('Respect Plex/Jellyfin library sharing')}</span>
          <label className="slide-toggle">
            <input
              type="checkbox"
              checked={!!data?.enforced}
              onChange={(e) => handleToggle(e.target.checked)}
              disabled={!data || saving}
            />
            <span className="slide-track" />
          </label>
        </div>
      </div>

      <div className="admin-actions" style={{ marginBottom: 12, gap: 12, alignItems: 'center' }}>
        <button className="btn-admin btn-primary btn-sm" onClick={handleRefresh} disabled={refreshing || data?.refreshing}>
          {refreshing || data?.refreshing ? t('Refreshing...') : t('Refresh library access')}
        </button>
        {data?.lastRefresh && (
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {t('Last full refresh {{when}}: {{changed}} changed, {{failed}} failed', {
              when: ago(data.lastRefresh.at), changed: data.lastRefresh.changed, failed: data.lastRefresh.errors,
            })}
          </span>
        )}
      </div>

      <div className="user-table-wrap">
        <div className="user-table">
          <div className="user-table-header" style={{ gridTemplateColumns: GRID }}>
            <span>{t('User')}</span>
            <span>{t('Access')}</span>
            <span>{t('Libraries')}</span>
            <span>{t('Checked')}</span>
            <span>{t('Status')}</span>
          </div>
          {!data ? (
            <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('Loading...')}</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('No users found.')}</div>
          ) : rows.map(({ u, snap }) => (
            <div className="user-table-row" key={`${u.userId}:${snap?.source || '-'}`} style={{ gridTemplateColumns: GRID }}>
              <span className="user-id">
                <div>
                  <span>{u.username}</span>
                  <span className="user-id-sub">{u.userId}</span>
                </div>
              </span>
              <span>
                {u.owner ? t('Owner · unrestricted') : snap ? t(ROLE_LABELS[snap.role] || snap.role) : t('Not checked yet')}
                {snap && snap.source === 'jellyfin' && snap.role !== 'jellyfin' && <span style={{ color: 'var(--text-muted)' }}> · Jellyfin</span>}
              </span>
              <span>{snap?.fetchedAt ? <SectionList snap={snap} /> : <span style={{ color: 'var(--text-muted)' }}>{t('None until checked')}</span>}</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>{ago(snap?.fetchedAt)}</span>
              <span style={{ fontSize: '0.8rem', color: snap?.lastError ? 'var(--danger, #ef4444)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={snap?.lastError || ''}>
                {snap?.lastError || (snap?.fetchedAt ? t('OK') : '—')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
