import React from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Carousel from './Carousel'

// Gradient is the fallback shown before the artwork loads (or if it fails).
// Artwork lives in public/genres/<slug>.webp — regenerate with scripts/gen-genre-art.py
// and bump GENRE_ART_VERSION so CDN/browser caches pick up the new files.
const GENRE_META = {
  'Action':          { gradient: 'linear-gradient(145deg, #7f1d1d 0%, #c2410c 60%, #ea580c 100%)' },
  'Adventure':       { gradient: 'linear-gradient(145deg, #164e63 0%, #0369a1 60%, #0891b2 100%)' },
  'Animation':       { gradient: 'linear-gradient(145deg, #4c1d95 0%, #7c3aed 60%, #a855f7 100%)' },
  'Comedy':          { gradient: 'linear-gradient(145deg, #78350f 0%, #d97706 60%, #fbbf24 100%)' },
  'Crime':           { gradient: 'linear-gradient(145deg, #0f172a 0%, #1e293b 60%, #334155 100%)' },
  'Documentary':     { gradient: 'linear-gradient(145deg, #14532d 0%, #15803d 60%, #4ade80 100%)' },
  'Drama':           { gradient: 'linear-gradient(145deg, #3b0764 0%, #6d28d9 60%, #8b5cf6 100%)' },
  'Fantasy':         { gradient: 'linear-gradient(145deg, #312e81 0%, #4338ca 60%, #818cf8 100%)' },
  'Horror':          { gradient: 'linear-gradient(145deg, #1a0000 0%, #7f1d1d 60%, #b91c1c 100%)' },
  'Mystery':         { gradient: 'linear-gradient(145deg, #0c1a3b 0%, #1e3a5f 60%, #1d4ed8 100%)' },
  'Romance':         { gradient: 'linear-gradient(145deg, #500724 0%, #be185d 60%, #f472b6 100%)' },
  'Science Fiction': { gradient: 'linear-gradient(145deg, #0c4a6e 0%, #0e7490 60%, #22d3ee 100%)' },
  'Thriller':        { gradient: 'linear-gradient(145deg, #0c0a09 0%, #292524 60%, #57534e 100%)' },
  'War':             { gradient: 'linear-gradient(145deg, #1c1009 0%, #44301e 60%, #78716c 100%)' },
  'Western':         { gradient: 'linear-gradient(145deg, #451a03 0%, #92400e 60%, #d97706 100%)' },
  'Family':          { gradient: 'linear-gradient(145deg, #064e3b 0%, #059669 60%, #34d399 100%)' },
  'Music':           { gradient: 'linear-gradient(145deg, #4a044e 0%, #86198f 60%, #e879f9 100%)' },
  'Reality':         { gradient: 'linear-gradient(145deg, #7c2d12 0%, #c2410c 60%, #fb923c 100%)' },
}
const GENRES = Object.keys(GENRE_META)

const GENRE_ART_VERSION = '2'
const FALLBACK_META = { gradient: 'linear-gradient(145deg, #1e293b, #334155)' }
const genreArt = (genre) => `/genres/${genre.toLowerCase().replace(/\s+/g, '-')}.webp?v=${GENRE_ART_VERSION}`

/**
 * Horizontal carousel of genre tiles. `linkFor(genre)` decides where a tile
 * goes, so the same shelf can point at the library filter (Home) or at TMDB
 * search (Explore) while looking identical.
 */
export default function GenreTiles({ linkFor, genres = GENRES }) {
  const { t } = useTranslation()
  return (
    <Carousel variant="genre">
      {genres.map((genre) => {
        const meta = GENRE_META[genre] || FALLBACK_META
        return (
          <Link
            key={genre}
            to={linkFor(genre)}
            className="genre-tile"
            style={{ background: meta.gradient }}
          >
            <img
              className="genre-tile-art"
              src={genreArt(genre)}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
            <div className="genre-tile-footer">
              <span className="genre-tile-name">{t(genre)}</span>
            </div>
          </Link>
        )
      })}
    </Carousel>
  )
}
