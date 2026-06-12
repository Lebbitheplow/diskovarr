import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'
import ListEditorModal from './ListEditorModal'

function formatAgo(ts) {
  if (!ts) return 'Never'
  const diffMin = Math.floor((Date.now() / 1000 - ts) / 60)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`
  return `${Math.floor(diffMin / 1440)}d ago`
}

const VISIBILITY_LABELS = { home: 'Home', recommended: 'Recommended', library: 'Library' }

function CredentialsSection({ onToast }) {
  const { t } = useTranslation()
  const [traktClientId, setTraktClientId] = useState('')
  const [mdblistApiKey, setMdblistApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    adminAutomation.getCredentials()
      .then(({ data }) => {
        setTraktClientId(data.traktClientId || '')
        setMdblistApiKey(data.mdblistApiKey || '')
      })
      .catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await adminAutomation.setCredentials({ traktClientId, mdblistApiKey })
      onToast(t('Credentials saved'))
    } catch (e) {
      onToast(e.message || 'Failed to save credentials', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <div>
          <h2 className="section-title">{t('List Source Credentials')}</h2>
          <p className="section-desc">
            {t('Trakt lists need a free client ID (trakt.tv/oauth/applications). MDBList lists need a free API key (mdblist.com/preferences). IMDb, TMDB, Letterboxd and AniList need no credentials.')}
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div className="conn-field-group">
          <label className="conn-field-label">{t('Trakt Client ID')}</label>
          <input type="text" className="conn-input" style={{ maxWidth: 320 }} placeholder={t('Client ID')}
            value={traktClientId} onChange={(e) => setTraktClientId(e.target.value)} />
        </div>
        <div className="conn-field-group">
          <label className="conn-field-label">{t('MDBList API Key')}</label>
          <input type="text" className="conn-input" style={{ maxWidth: 320 }} placeholder={t('API key')}
            value={mdblistApiKey} onChange={(e) => setMdblistApiKey(e.target.value)} />
        </div>
      </div>
      <div className="admin-actions">
        <button className="btn-admin btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('Saving...') : t('Save')}
        </button>
      </div>
    </div>
  )
}

export default function AutoRequest({ onToast }) {
  const { t } = useTranslation()
  const [lists, setLists] = useState([])
  const [presets, setPresets] = useState([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingList, setEditingList] = useState(null)
  const pollRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const [{ data: listData }, { data: presetData }] = await Promise.all([
        adminAutomation.getLists(),
        adminAutomation.getPresets(),
      ])
      setLists(listData.lists || [])
      setPresets(presetData.presets || [])
      return listData.lists || []
    } catch (e) {
      onToast(e.message || 'Failed to load lists', 'error')
      return []
    }
  }, [onToast])

  useEffect(() => { load() }, [load])
  useEffect(() => () => clearInterval(pollRef.current), [])

  // Poll while any list is syncing so lastStatus updates appear
  const startPolling = useCallback(() => {
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      const updated = await load()
      if (!updated.some(l => l.syncing)) clearInterval(pollRef.current)
    }, 4000)
  }, [load])

  const handleSyncNow = async (list) => {
    try {
      await adminAutomation.syncListNow(list.id)
      onToast(t('Sync started'))
      setLists(prev => prev.map(l => l.id === list.id ? { ...l, syncing: true } : l))
      startPolling()
    } catch (e) {
      onToast(e.message || 'Sync failed to start', 'error')
    }
  }

  const handleToggle = async (list) => {
    try {
      await adminAutomation.updateList(list.id, { enabled: !list.enabled })
      load()
    } catch (e) {
      onToast(e.message || 'Update failed', 'error')
    }
  }

  const handleDelete = async (list) => {
    if (!window.confirm(t('Delete list "{{name}}"? Already-requested items are not affected.', { name: list.name }))) return
    let deleteCollection = false
    if (list.collectionEnabled && list.collectionRatingKey) {
      deleteCollection = window.confirm(t('Also delete its Plex collection?'))
    }
    try {
      await adminAutomation.deleteList(list.id, deleteCollection)
      onToast(t('List deleted'))
      load()
    } catch (e) {
      onToast(e.message || 'Delete failed', 'error')
    }
  }

  const openEditor = (list = null) => {
    setEditingList(list)
    setEditorOpen(true)
  }

  return (
    <>
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Monitored Lists')}</h2>
            <p className="section-desc">
              {t('Lists are checked on their own schedule; new items are requested automatically (or queued for approval) and can be mirrored into a Plex collection.')}
            </p>
          </div>
          <button className="btn-admin btn-primary" onClick={() => openEditor()}>{t('+ Add List')}</button>
        </div>

        {lists.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>{t('No monitored lists yet. Add a preset, paste a list URL from Trakt, IMDb, TMDB, Letterboxd, MDBList or AniList, or build a criteria list (genre, cast, network, …).')}</p>
        )}

        <div className="library-list">
          {lists.map(list => (
            <div key={list.id} className={`library-item ${list.enabled ? '' : 'library-item-disabled'}`}>
              <div className="library-item-info" style={{ minWidth: 0 }}>
                <span className="library-item-name">
                  {list.name}
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                    {list.presetKey ? t('preset') : list.sourceType === 'criteria' ? `${t('criteria')} · ${list.matchMode}` : list.sourceType}
                  </span>
                  {list.collectionEnabled && (
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent, #e5a00d)' }}>
                      ◆ {t('Collection')}: {t(VISIBILITY_LABELS[list.collectionVisibility] || list.collectionVisibility)}
                    </span>
                  )}
                </span>
                <span className="library-item-count" style={{ display: 'block' }}>
                  {list.approvalMode === 'auto' ? t('Auto-approve') : t('Needs approval')}
                  {' · '}{t('every {{n}}h', { n: list.syncIntervalHours })}
                  {' · '}{list.requestedCount} {t('requested')}, {list.inLibraryCount} {t('in library')}
                  {' · '}{t('Last sync')}: {list.syncing ? t('running…') : formatAgo(list.lastSyncedAt)}
                </span>
                {(list.lastError || list.lastStatus) && (
                  <span style={{ display: 'block', fontSize: 11, color: list.lastError ? 'var(--error, #e57373)' : 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {list.lastError || list.lastStatus}
                  </span>
                )}
              </div>
              <div className="library-item-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn-admin btn-sm" onClick={() => handleSyncNow(list)} disabled={list.syncing}>
                  {list.syncing ? t('Syncing…') : t('Sync now')}
                </button>
                <button className="btn-admin btn-sm" onClick={() => openEditor(list)}>{t('Edit')}</button>
                <button className="btn-admin btn-sm btn-danger" onClick={() => handleDelete(list)}>{t('Delete')}</button>
                <label className="slide-toggle">
                  <input type="checkbox" checked={list.enabled} onChange={() => handleToggle(list)} />
                  <span className="slide-track" />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      <CredentialsSection onToast={onToast} />

      {editorOpen && (
        <ListEditorModal
          list={editingList}
          presets={presets}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); load() }}
          onToast={onToast}
        />
      )}
    </>
  )
}
