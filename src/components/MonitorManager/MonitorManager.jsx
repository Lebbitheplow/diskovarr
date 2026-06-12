import React, { useState, useCallback, useEffect } from 'react'
import { monitorsApi } from '../../services/monitorsApi'
import MonitorEditor from './MonitorEditor'
import { useToast } from '../../context/ToastContext'
import { useTranslation } from 'react-i18next'

export default function MonitorManager() {
  const { t } = useTranslation()
  const toast = useToast()
  const [monitors, setMonitors] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingMonitor, setEditingMonitor] = useState(null)
  const [creating, setCreating] = useState(false)

  const loadMonitors = useCallback(async () => {
    try {
      const { data } = await monitorsApi.getMonitors()
      setMonitors(data || [])
    } catch (err) {
      toast.error('Failed to load monitors')
    }
    setLoading(false)
  }, [toast])

  useEffect(() => {
    ;(async () => { await loadMonitors() })()
  }, [loadMonitors])

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete monitor "${name}"?`)) return
    try {
      await monitorsApi.deleteMonitor(id)
      toast.success('Monitor deleted')
      loadMonitors()
    } catch (err) {
      toast.error('Failed to delete monitor')
    }
  }

  const handleToggle = async (monitor) => {
    try {
      await monitorsApi.toggleMonitor(monitor.id, !monitor.enabled)
      loadMonitors()
    } catch (err) {
      toast.error('Failed to toggle monitor')
    }
  }

  const formatTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    return d.toLocaleDateString()
  }

  if (loading) return <div className="monitor-manager">{t('Loading...')}</div>

  return (
    <div className="monitor-manager">
      <div className="monitor-manager-header">
        <h3>{t('Content Monitors')}</h3>
        <button className="btn-admin btn-primary" onClick={() => setCreating(true)}>
          {t('+ Create Monitor')}
        </button>
      </div>

      {monitors.length === 0 ? (
        <div className="monitor-empty">
          <p>{t('No monitors yet. Create one to get notified when new content matching your interests becomes available.')}</p>
        </div>
      ) : (
        <div className="monitor-list">
          {monitors.map(m => (
            <div key={m.id} className={`monitor-card${m.enabled ? '' : ' monitor-disabled'}`}>
              <div className="monitor-card-header">
                <div className="monitor-card-title">
                  <span className="monitor-name">{m.name}</span>
                  <span className="monitor-match-badge">{m.matchMode}</span>
                </div>
                <label className="slide-toggle">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    onChange={() => handleToggle(m)}
                  />
                  <span className="slide-track" />
                </label>
              </div>

              <div className="monitor-card-criteria">
                {m.criteria?.slice(0, 3).map((c, i) => (
                  <span key={i} className="monitor-chip">
                    {c.type}: {c.entityName}
                  </span>
                ))}
                {m.criteria?.length > 3 && (
                  <span className="monitor-chip">+{m.criteria.length - 3} more</span>
                )}
              </div>

              <div className="monitor-card-footer">
                <span className="monitor-meta">
                  {m.criteria?.length || 0} criteria &middot; Created {formatTime(m.createdAt)}
                </span>
                <div className="monitor-card-actions">
                  <button
                    className="chip-sm"
                    onClick={() => setEditingMonitor(m)}
                  >
                    {t('Edit')}
                  </button>
                  <button
                    className="chip-sm chip-danger"
                    onClick={() => handleDelete(m.id, m.name)}
                  >
                    {t('Delete')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <MonitorEditor
          onSave={() => { setCreating(false); loadMonitors() }}
          onCancel={() => setCreating(false)}
        />
      )}

      {editingMonitor && (
        <MonitorEditor
          monitor={editingMonitor}
          onSave={() => { setEditingMonitor(null); loadMonitors() }}
          onCancel={() => setEditingMonitor(null)}
        />
      )}
    </div>
  )
}
