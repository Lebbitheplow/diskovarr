import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'

// Search / auto-detect the YouTube channel for a series mapping. Shared by the
// YouTube admin tab and the Connections "Manage Series" modal.
export default function ChannelPicker({ detail, onSet, onToast }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(!detail.channel_id)
  const [query, setQuery] = useState(detail.title || '')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)

  const search = async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      const { data } = await adminTuberr.searchChannels(query.trim())
      setResults(data || [])
      if (!(data || []).length) onToast?.(t('No channels found'), 'error')
    } catch (e) {
      onToast?.(e.message || 'Channel search failed', 'error')
    } finally { setBusy(false) }
  }

  const apply = async (ch) => {
    setBusy(true)
    try {
      await adminTuberr.createMapping({
        tvdbId: detail.tvdb_id,
        title: detail.title,
        channelId: ch.channelId,
        channelTitle: ch.title,
      })
      onToast?.(t('Channel set — auto-match running'))
      setOpen(false)
      onSet?.()
    } catch (e) {
      onToast?.(e.message || 'Failed to set channel', 'error')
    } finally { setBusy(false) }
  }

  const autoDetect = async () => {
    setBusy(true)
    try {
      const { data } = await adminTuberr.detectChannel(detail.id)
      if (data.detected) {
        onToast?.(t('Channel detected: {{name}} — auto-match running', { name: data.channel.title }))
        setOpen(false)
        onSet?.()
      } else {
        onToast?.(data.reason || t('Could not confidently detect a channel — pick one manually'), 'error')
      }
    } catch (e) {
      onToast?.(e.message || 'Detection failed', 'error')
    } finally { setBusy(false) }
  }

  if (!open) {
    return (
      <button className="btn-admin" onClick={() => setOpen(true)}>
        {detail.channel_id ? t('Change channel') : t('Set channel')}
      </button>
    )
  }
  return (
    <div style={{ flexBasis: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input type="text" className="conn-input" style={{ flex: 1, fontSize: '0.82rem' }}
          value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') search() }}
          placeholder={t('Channel name, @handle, or URL…')} />
        <button className="btn-admin" disabled={busy} onClick={search}>{t('Search')}</button>
        {!detail.channel_id && (
          <button className="btn-admin" disabled={busy} onClick={autoDetect}
            title={t('Search candidate channels and verify them against the episode list')}>
            {busy ? t('Detecting…') : t('Auto-detect')}
          </button>
        )}
        <button className="btn-admin" onClick={() => setOpen(false)}>{t('Cancel')}</button>
      </div>
      {results.map(ch => (
        <div key={ch.channelId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
          <button className="btn-admin" style={{ fontSize: '0.75rem' }} disabled={busy} onClick={() => apply(ch)}>{t('Use')}</button>
          {ch.thumbnail && <img src={ch.thumbnail} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} />}
          <span style={{ fontSize: '0.84rem' }}>{ch.title}</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.description}</span>
        </div>
      ))}
    </div>
  )
}
