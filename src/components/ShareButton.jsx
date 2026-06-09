import React, { useState } from 'react'
import ShareModal from './ShareModal'

// Trigger button for the review feed / detail card. Opens the full ShareModal.
// `review` carries title/username/rating/reviewText; older callers may pass
// reviewTitle/reviewAuthor instead, so we normalize.
export default function ShareButton({ reviewId, review, reviewTitle, reviewAuthor }) {
  const [open, setOpen] = useState(false)
  const data = review || { title: reviewTitle, username: reviewAuthor }

  return (
    <>
      <button
        className="review-action-btn"
        onClick={() => setOpen(true)}
        style={{
          display: 'flex', alignItems: 'center', gap: '5px', padding: '6px 12px', borderRadius: '20px',
          border: 'none', background: open ? 'var(--accent-dim)' : 'transparent',
          color: open ? 'var(--accent)' : 'var(--text-secondary)',
          cursor: 'pointer', fontSize: '0.82rem', fontWeight: '500', transition: 'all 0.15s',
        }}
        aria-label="Share this review"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
        <span style={{ fontSize: '0.82rem' }}>Share</span>
      </button>

      {open && <ShareModal reviewId={reviewId} review={data} onClose={() => setOpen(false)} />}
    </>
  )
}
