import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'
import { mappingState, STATE_COLORS, pillStyle } from './format'

// Mapping state pill with Pause / Resume / Mark unavailable actions (T6).
// Paused and unavailable mappings are skipped by Tuberr's refresh and RSS.
export default function StatePill({ mapping, onChanged, onToast, compact = false }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const state = mappingState(mapping)
  const color = STATE_COLORS[state]

  const setState = async (next, reason) => {
    setBusy(true)
    try {
      await adminTuberr.updateMapping(mapping.id, { state: next, ...(reason != null ? { stateReason: reason } : {}) })
      onToast?.(t('Series marked {{state}}', { state: next }))
      onChanged?.()
    } catch (e) {
      onToast?.(e.message || 'Failed to update series state', 'error')
    } finally { setBusy(false) }
  }

  const markUnavailable = () => {
    const reason = window.prompt(t('Why is this series unavailable on YouTube? (optional)'), mapping.state_reason || '')
    if (reason === null) return
    setState('unavailable', reason.trim() || null)
  }

  const btn = { fontSize: '0.72rem', padding: '2px 8px' }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={pillStyle(color)} title={mapping.state_reason || ''}>{t(state)}</span>
      {!compact && mapping.state_reason && (
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mapping.state_reason}</span>
      )}
      {state === 'active' && (
        <button className="btn-admin" style={btn} disabled={busy} onClick={() => setState('paused')}>{t('Pause')}</button>
      )}
      {state !== 'active' && (
        <button className="btn-admin" style={btn} disabled={busy} onClick={() => setState('active', '')}>{t('Resume')}</button>
      )}
      {state !== 'unavailable' && (
        <button className="btn-admin" style={btn} disabled={busy} onClick={markUnavailable}
          title={t('Stop refreshing and searching — the videos are not on YouTube')}>
          {t('Mark unavailable')}
        </button>
      )}
    </span>
  )
}
