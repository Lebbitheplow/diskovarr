import React from 'react'
import { useTranslation } from 'react-i18next'
import StatePill from './StatePill'
import { fmtAgo, pillStyle } from './format'

const th = { textAlign: 'left', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
const td = { padding: '8px', borderBottom: '1px solid var(--border)', fontSize: '0.85rem', verticalAlign: 'middle' }

function matchColor(status) {
  if (status === 'matched') return '#4ade80'
  if (status === 'partial') return '#f59e0b'
  return '#94a3b8'
}

// Series list for the YouTube tab and the Connections modal. `mappings` rows
// come from GET /admin/tuberr/mappings (state, counts, and timestamps may be
// missing on older backends — every cell tolerates that).
export default function SeriesTable({ mappings, onReview, onChanged, onToast, compact = false }) {
  const { t } = useTranslation()

  if (mappings === null) return <p style={{ color: 'var(--text-muted)' }}>{t('Loading…')}</p>
  if (!mappings.length) {
    return (
      <p style={{ color: 'var(--text-muted)' }}>
        {t('No YouTube series yet. Request a TV show and pick “YouTube” as the downloader to create one.')}
      </p>
    )
  }

  return (
    <div className="table-scroll-wrap" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>{t('Series')}</th>
            <th style={th}>{t('Channel')}</th>
            <th style={th}>{t('State')}</th>
            <th style={th}>{t('Matched')}</th>
            {!compact && <th style={th}>{t('Skipped')}</th>}
            {!compact && <th style={th}>{t('Last new video')}</th>}
            {!compact && <th style={th}>{t('Last grab')}</th>}
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {mappings.map(m => {
            const total = Number(m.total_episodes || 0)
            const matched = Number(m.matched_episodes || 0)
            const skipped = Number(m.skipped_episodes || 0)
            return (
              <tr key={m.id}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{m.title}</div>
                  <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>tvdb:{m.tvdb_id}</div>
                </td>
                <td style={{ ...td, color: m.channel_title ? 'inherit' : 'var(--text-muted)' }}>
                  {m.channel_title || t('no channel set')}
                </td>
                <td style={td}>
                  <StatePill mapping={m} onChanged={onChanged} onToast={onToast} compact />
                </td>
                <td style={td}>
                  <span style={{ marginRight: 6 }}>{matched}/{total}</span>
                  {m.match_status && <span style={pillStyle(matchColor(m.match_status))}>{t(m.match_status)}</span>}
                </td>
                {!compact && <td style={{ ...td, color: skipped ? 'inherit' : 'var(--text-muted)' }}>{skipped || '—'}</td>}
                {!compact && <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtAgo(m.last_new_video_at)}</td>}
                {!compact && <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtAgo(m.last_grab_at)}</td>}
                <td style={{ ...td, textAlign: 'right' }}>
                  <button className="btn-admin" onClick={() => onReview(m.id)}>{t('Review')}</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
