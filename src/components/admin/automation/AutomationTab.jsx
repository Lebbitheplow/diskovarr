import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import AutoRequest from './AutoRequest'
import DeletionProfiles from './DeletionProfiles'
import DeletionQueue from './DeletionQueue'

const SECTIONS = [
  { id: 'autorequest', label: 'Auto Request' },
  { id: 'deletion', label: 'Deletion Profiles' },
  { id: 'activity', label: 'Activity' },
]

export default function AutomationTab({ onToast }) {
  const { t } = useTranslation()
  const [section, setSection] = useState('autorequest')

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={`btn-admin ${section === s.id ? 'btn-primary' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {t(s.label)}
          </button>
        ))}
      </div>
      {section === 'autorequest' && <AutoRequest onToast={onToast} />}
      {section === 'deletion' && <DeletionProfiles onToast={onToast} />}
      {section === 'activity' && <DeletionQueue onToast={onToast} />}
    </div>
  )
}
