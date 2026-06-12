import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { adminAutomation } from '../../../services/adminApi'
import ProfileEditorModal from './ProfileEditorModal'

const MODE_INFO = {
  dry_run: { label: 'Dry run', desc: 'reports matches, deletes nothing', color: 'var(--text-muted)' },
  review: { label: 'Review', desc: 'matches wait for your approval', color: '#64b5f6' },
  auto: { label: 'Automatic', desc: 'deletes after the grace period', color: '#e57373' },
}

export default function DeletionProfiles({ onToast }) {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState([])
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState(null)
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await adminAutomation.getProfiles()
      setProfiles(data.profiles || [])
    } catch (e) {
      onToast(e.message || 'Failed to load profiles', 'error')
    }
  }, [onToast])

  useEffect(() => { load() }, [load])

  const handleToggle = async (profile) => {
    try {
      await adminAutomation.updateProfile(profile.id, { enabled: !profile.enabled })
      load()
    } catch (e) {
      onToast(e.message || 'Update failed', 'error')
    }
  }

  const handleDelete = async (profile) => {
    if (!window.confirm(t('Delete profile "{{name}}"? Its match history is removed too (already-deleted media stays deleted).', { name: profile.name }))) return
    try {
      await adminAutomation.deleteProfile(profile.id)
      onToast(t('Profile deleted'))
      load()
    } catch (e) {
      onToast(e.message || 'Delete failed', 'error')
    }
  }

  const handleRunNow = async () => {
    setRunning(true)
    try {
      await adminAutomation.runNow()
      onToast(t('Evaluation started — check back in a moment'))
      setTimeout(load, 6000)
    } catch (e) {
      onToast(e.message || 'Run failed', 'error')
    } finally {
      setTimeout(() => setRunning(false), 6000)
    }
  }

  const openEditor = (profile = null) => {
    setEditingProfile(profile)
    setEditorOpen(true)
  }

  return (
    <>
      <div className="admin-section">
        <div className="admin-section-header">
          <div>
            <h2 className="section-title">{t('Deletion Profiles')}</h2>
            <p className="section-desc">
              {t('Profiles match library items by criteria and delete via Radarr/Sonarr (with re-grab protection) or Plex, then empty Plex trash. With no profiles, nothing is ever deleted. New profiles start in dry-run.')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {profiles.length > 0 && (
              <button className="btn-admin" onClick={handleRunNow} disabled={running}>
                {running ? t('Running…') : t('Evaluate now')}
              </button>
            )}
            <button className="btn-admin btn-primary" onClick={() => openEditor()}>{t('+ Add Profile')}</button>
          </div>
        </div>

        {profiles.length === 0 && (
          <p style={{ color: 'var(--text-muted)' }}>
            {t('No deletion profiles. Auto-deletion is completely off until you create one.')}
          </p>
        )}

        <div className="library-list">
          {profiles.map(profile => {
            const mode = MODE_INFO[profile.mode] || MODE_INFO.dry_run
            return (
              <div key={profile.id} className={`library-item ${profile.enabled ? '' : 'library-item-disabled'}`}>
                <div className="library-item-info" style={{ minWidth: 0 }}>
                  <span className="library-item-name">
                    {profile.name}
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: mode.color, textTransform: 'uppercase' }}>
                      {t(mode.label)}
                    </span>
                    <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                      ({t(mode.desc)})
                    </span>
                  </span>
                  <span className="library-item-count" style={{ display: 'block' }}>
                    {profile.mediaType === 'show' ? t('TV shows') : t('Movies')}
                    {' · '}{profile.criteria.length} {t('criteria')}
                    {' · '}{profile.matchedCount} {t('matched')}
                    {profile.pendingReviewCount > 0 && <> {' · '}<span style={{ color: '#64b5f6' }}>{profile.pendingReviewCount} {t('awaiting review')}</span></>}
                    {profile.mode === 'auto' && profile.gracePeriodDays > 0 && <>{' · '}{t('{{n}}d grace', { n: profile.gracePeriodDays })}</>}
                    {' · '}{t('max {{n}}/run', { n: profile.maxDeletionsPerRun })}
                  </span>
                  {profile.lastRun?.error && (
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--error, #e57373)' }}>{profile.lastRun.error}</span>
                  )}
                </div>
                <div className="library-item-controls" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn-admin btn-sm" onClick={() => openEditor(profile)}>{t('Edit')}</button>
                  <button className="btn-admin btn-sm btn-danger" onClick={() => handleDelete(profile)}>{t('Delete')}</button>
                  <label className="slide-toggle">
                    <input type="checkbox" checked={profile.enabled} onChange={() => handleToggle(profile)} />
                    <span className="slide-track" />
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {editorOpen && (
        <ProfileEditorModal
          profile={editingProfile}
          onClose={() => setEditorOpen(false)}
          onSaved={() => { setEditorOpen(false); load() }}
          onToast={onToast}
        />
      )}
    </>
  )
}
