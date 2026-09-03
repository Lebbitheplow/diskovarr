import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminTuberr } from '../../../services/adminApi'
import { extractPlaylistIds, parseJsonArray } from './format'

// Explicit playlist sources for a mapping (T5). Channels with more uploads than
// Tuberr's per-mapping cap lose their oldest videos; a playlist covering the
// early seasons makes them matchable again.
export default function PlaylistsEditor({ mapping, onSaved, onToast }) {
  const { t } = useTranslation()
  const current = parseJsonArray(mapping.playlist_ids)
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(current.join('\n'))
  const [saving, setSaving] = useState(false)
  const parsed = extractPlaylistIds(text)

  const save = async () => {
    setSaving(true)
    try {
      await adminTuberr.updateMapping(mapping.id, { playlistIds: parsed })
      onToast?.(parsed.length ? t('Playlists saved — refresh to pull their videos') : t('Playlists cleared'))
      setOpen(false)
      onSaved?.()
    } catch (e) {
      onToast?.(e.message || 'Failed to save playlists', 'error')
    } finally { setSaving(false) }
  }

  if (!open) {
    return (
      <button className="btn-admin" onClick={() => { setText(current.join('\n')); setOpen(true) }}
        title={t('Add YouTube playlists whose videos should be matched for this series')}>
        {t('Playlists')}{current.length ? ` (${current.length})` : ''}
      </button>
    )
  }

  return (
    <div style={{ flexBasis: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8 }}>
      <label className="conn-field-label" style={{ display: 'block', marginBottom: 6 }}>{t('Playlist URLs or IDs (one per line)')}</label>
      <textarea
        className="conn-input"
        rows={4}
        style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.78rem', resize: 'vertical' }}
        placeholder={'https://www.youtube.com/playlist?list=PL…\nPLxxxxxxxxxxxxxxxx'}
        value={text}
        onChange={e => setText(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', flex: 1 }}>
          {parsed.length
            ? t('{{n}} playlist(s) recognised', { n: parsed.length })
            : t('Videos from these playlists are added to the channel uploads when matching.')}
        </span>
        <button className="btn-admin btn-primary" disabled={saving} onClick={save}>{saving ? t('Saving…') : t('Save playlists')}</button>
        <button className="btn-admin" disabled={saving} onClick={() => setOpen(false)}>{t('Cancel')}</button>
      </div>
    </div>
  )
}
