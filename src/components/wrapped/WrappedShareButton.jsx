import React, { useState } from 'react'
import ShareModal from '../ShareModal'
import { wrappedSummary } from '../../utils/shareTargets'
import { useTranslation } from 'react-i18next'

// Per-section share trigger. Reuses the review ShareModal in its parametrized
// form: the image is the server-rendered wrapped card for this category,
// addressed by the user's unguessable share slug.
export default function WrappedShareButton({ slug, year, category, statLine, compact = false }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (!slug) return null

  return (
    <>
      <button
        className={`wrapped-share-btn ${compact ? 'compact' : ''}`}
        onClick={() => setOpen(true)}
        aria-label={t('Share this stat')}
        title={t('Share this stat')}
      >
        <svg width={compact ? 14 : 16} height={compact ? 14 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        {!compact && <span>{t('Share')}</span>}
      </button>

      {open && (
        <ShareModal
          onClose={() => setOpen(false)}
          share={{
            path: '',
            imageBase: `/og/wrapped/${slug}/${category}`,
            filenameBase: `diskovarr-wrapped-${year}-${category}`,
            summary: wrappedSummary({ year, statLine }),
            subject: `My ${year} Diskovarr Wrapped`,
            heading: t('Share your Wrapped'),
            subheading: statLine || t('Your year in review'),
          }}
        />
      )}
    </>
  )
}
