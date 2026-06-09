import React from 'react'

// Rotten Tomatoes critic (Tomatometer) and audience badges. Reads the Plex-sourced
// rating fields (rating / audienceRating + their *Image strings) off an item.
// Shared by DetailModal and ReviewModal so the scores look identical everywhere.
function getRatings(item) {
  const criticScore = item.rating ? Math.round(item.rating * 10) : null
  const audienceScore = item.audienceRating ? Math.round(item.audienceRating * 10) : null
  const isFresh = item.ratingImage && item.ratingImage.includes('.ripe')
  const isUpright = item.audienceRatingImage && item.audienceRatingImage.includes('.upright')
  const isRT = item.ratingImage && item.ratingImage.includes('rottentomatoes')
  return { criticScore, audienceScore, isFresh, isUpright, isRT }
}

export default function RatingBadges({ item, className = '' }) {
  const { criticScore, audienceScore, isFresh, isUpright, isRT } = getRatings(item)
  if (!criticScore && !audienceScore) return null

  return (
    <div className={'detail-modal-ratings' + (className ? ' ' + className : '')} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
      {criticScore && isRT && (
        <div className={'rating-badge rating-critic' + (isFresh ? ' fresh' : ' rotten')}>
          <span className="rating-icon">🍅</span>
          <span className="rating-label">Tomatometer</span>
          <span className="rating-score">{criticScore}%</span>
        </div>
      )}
      {audienceScore && (
        <div className={'rating-badge rating-audience' + (isUpright ? ' upright' : ' spilled')}>
          <span className="rating-icon">🍿</span>
          <span className="rating-label">Audience</span>
          <span className="rating-score">{audienceScore}%</span>
        </div>
      )}
    </div>
  )
}
