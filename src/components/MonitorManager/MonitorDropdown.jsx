import React, { useState, useRef, useEffect } from 'react'
import { monitorsApi } from '../../services/monitorsApi'
import MonitorEditor from './MonitorEditor'
import { useToast } from '../../context/ToastContext'
import { useTranslation } from 'react-i18next'

export default function MonitorDropdown({ item, onClose }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleQuickCreate = async (label, criteria) => {
    setSaving(true)
    const name = `All ${label} content`
    try {
      await monitorsApi.quickCreate({ name, criteria })
      toast.success(`Monitoring "${name}"`)
      setSaving(false)
      if (onClose) onClose()
    } catch (err) {
      toast.error('Failed to create monitor')
      setSaving(false)
    }
  }

  const handleCustom = (label, criteria) => {
    const name = `All ${label} content`
    setCreating({ name, criteria })
    setOpen(false)
  }

  const mediaType = item.mediaType || item.type
  const isMovie = mediaType === 'movie'
  const isShow = mediaType === 'tv' || mediaType === 'show'
  const genres = item.genres || []
  const cast = item.structuredCast || item.cast || []
  const directors = item.directors || []
  const studio = item.studio || ''
  const collections = item.collections || []

  const items = []

  if (item.tmdbId) {
    items.push({
      label: `Monitor this ${isMovie ? 'movie' : 'series'}`,
      criteria: [{ type: isMovie ? 'movie' : 'tv_series', entityId: String(item.tmdbId), entityName: item.title }],
      custom: false,
    })
  }

  genres.forEach(g => {
    items.push({
      label: `Monitor "${g}"`,
      criteria: [{ type: 'genre', entityName: g }],
      custom: true,
    })
  })

  if (studio) {
    items.push({
      label: `Monitor "${studio}"`,
      criteria: [{ type: isShow ? 'network' : 'studio', entityName: studio }],
      custom: true,
    })
  }

  collections.forEach(c => {
    const name = typeof c === 'string' ? c : (c.name || '')
    if (name) {
      items.push({
        label: `Monitor "${name}"`,
        criteria: [{ type: 'collection', entityName: name }],
        custom: true,
      })
    }
  })

  directors.forEach(d => {
    items.push({
      label: `Monitor "${d}"`,
      criteria: [{ type: 'director', entityName: d }],
      custom: true,
    })
  })

  const castList = Array.isArray(cast) ? cast : []
  castList.slice(0, 10).forEach(c => {
    const name = typeof c === 'string' ? c : (c.name || '')
    if (name) {
      items.push({
        label: `Monitor "${name}"`,
        criteria: [{ type: 'cast', entityName: name }],
        custom: true,
      })
    }
  })

  if (items.length === 0) return null

  return (
    <div className="modal-monitor-wrap" ref={ref}>
      <button
        className="modal-btn modal-btn-monitor"
        onClick={() => setOpen(!open)}
        disabled={saving}
      >
        {saving ? '...' : 'Monitor'}
      </button>

      {open && (
        <div className="modal-monitor-dropdown">
          <div className="monitor-dropdown-header">{t('Create Monitor')}</div>
          {items.map((item, i) => (
            <button
              key={i}
              className="monitor-dropdown-item"
              onClick={() => item.custom ? handleCustom(item.label, item.criteria) : handleQuickCreate(item.label, item.criteria)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {creating && (
        <MonitorEditor
          monitor={null}
          prefillName={creating.name}
          prefillCriteria={creating.criteria}
          onSave={() => { setCreating(false); if (onClose) onClose() }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  )
}
