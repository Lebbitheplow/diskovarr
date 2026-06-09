import React, { useRef, useEffect, useState, useCallback } from 'react'

// Horizontal scroller with edge navigation arrows, reusing the site-wide
// `.carousel-wrap`/`.carousel-arrow` styling (as on the Diskovarr home rows).
// Wraps a flex scroll row (the cast/crew rows) rather than the 2-row card grid,
// so it can't share the grid-based <Carousel> component directly.
function ScrollCarousel({ className, children }) {
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const checkScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 2)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkScroll, { passive: true })
    window.addEventListener('resize', checkScroll)
    return () => {
      el.removeEventListener('scroll', checkScroll)
      window.removeEventListener('resize', checkScroll)
    }
  }, [checkScroll])

  // Re-evaluate arrow visibility whenever the content (cast/crew list) changes.
  useEffect(() => { checkScroll() }, [checkScroll, children])

  const scrollByPage = (dir) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  return (
    <div className="carousel-wrap cast-crew-carousel">
      <button
        className="carousel-arrow carousel-arrow-prev"
        onClick={() => scrollByPage(-1)}
        disabled={!canScrollLeft}
        aria-label="Previous"
      >❮</button>
      <div className={className} ref={scrollRef}>
        {children}
      </div>
      <button
        className="carousel-arrow carousel-arrow-next"
        onClick={() => scrollByPage(1)}
        disabled={!canScrollRight}
        aria-label="Next"
      >❯</button>
    </div>
  )
}

const PLACEHOLDER_AVATAR = (
  <svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%">
    <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
  </svg>
)

const PROFILE_BASE = 'https://image.tmdb.org/t/p'

function profileUrl(path, size = 'w185') {
  return path ? `${PROFILE_BASE}/${size}${path}` : null
}

function CastCard({ member, onClick, onMonitor }) {
  const imgUrl = profileUrl(member.profilePath, 'w185')
  return (
    <div className="cast-card-wrap">
      <button type="button" className="cast-card" onClick={() => onClick?.(member)} title={`More with ${member.name}`}>
      <div className="cast-card-photo-wrap">
        {imgUrl ? (
          <img
            className="cast-card-photo"
            src={imgUrl}
            alt={member.name}
            loading="lazy"
            onError={e => {
              e.target.style.display = 'none'
              e.target.nextElementSibling.style.display = 'flex'
            }}
          />
        ) : null}
        <div className="cast-card-placeholder" style={{ display: imgUrl ? 'none' : 'flex' }}>
          {PLACEHOLDER_AVATAR}
        </div>
      </div>
      <div className="cast-card-info">
        <div className="cast-card-name">{member.name}</div>
        {member.character && <div className="cast-card-character">{member.character}</div>}
      </div>
      {onMonitor && (
        <button
          type="button"
          className="cast-card-monitor"
          onClick={(e) => { e.stopPropagation(); onMonitor(member); }}
          title={`Monitor "${member.name}"`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
          </svg>
        </button>
      )}
    </button>
    </div>
  )
}

function CastSkeleton() {
  return (
    <div className="cast-scroll-row">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="cast-card cast-card-skeleton">
          <div className="cast-card-photo-wrap">
            <div className="cast-card-skeleton-img shimmer" />
          </div>
          <div className="cast-card-info">
            <div className="cast-card-skeleton-line shimmer" style={{ width: '80%' }} />
            <div className="cast-card-skeleton-line shimmer" style={{ width: '60%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function CrewItem({ member, onClick }) {
  const imgUrl = profileUrl(member.profilePath, 'w185')
  return (
    <button type="button" className="crew-item" onClick={() => onClick?.(member)} title={`More with ${member.name}`}>
      <div className="crew-item-photo-wrap">
        {imgUrl ? (
          <img
            className="crew-item-photo"
            src={imgUrl}
            alt={member.name}
            loading="lazy"
            onError={e => {
              e.target.style.display = 'none'
              e.target.nextElementSibling.style.display = 'flex'
            }}
          />
        ) : null}
        <div className="crew-item-placeholder" style={{ display: imgUrl ? 'none' : 'flex' }}>
          {PLACEHOLDER_AVATAR}
        </div>
      </div>
      <div className="crew-item-info">
        <div className="crew-item-name" title={member.name}>{member.name}</div>
        <div className="crew-item-job" title={member.job}>{member.job}</div>
      </div>
    </button>
  )
}

function CrewSkeleton() {
  return (
    <div className="crew-scroll-row">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="crew-item crew-item-skeleton">
          <div className="crew-item-photo-wrap">
            <div className="crew-item-skeleton-img shimmer" />
          </div>
          <div className="crew-item-info">
            <div className="crew-item-skeleton-line shimmer" style={{ width: '80%' }} />
            <div className="crew-item-skeleton-line shimmer" style={{ width: '60%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

const CREW_SECTION_ORDER = [
  { key: 'director', label: 'Director', jobs: ['Director'] },
  { key: 'writer', label: 'Writing', jobs: ['Writer', 'Screenplay', 'Story', 'Creator'] },
  { key: 'producer', label: 'Production', jobs: ['Executive Producer', 'Producer'] },
  { key: 'music', label: 'Music', jobs: ['Composer', 'Original Music Composer'] },
  { key: 'cinematography', label: 'Cinematography', jobs: ['Cinematographer'] },
  { key: 'editor', label: 'Editing', jobs: ['Editor'] },
  { key: 'art', label: 'Art Direction', jobs: ['Production Design'] },
  { key: 'other', label: 'Other Crew', jobs: [] },
]

// Rank a crew member by its job so the flat carousel still leads with the most
// important roles (Director → Writing → Production → …), preserving TMDB's order
// within each tier.
function crewPriority(job) {
  for (let i = 0; i < CREW_SECTION_ORDER.length; i++) {
    const section = CREW_SECTION_ORDER[i]
    if (section.jobs.length && section.jobs.includes(job)) return i
  }
  return CREW_SECTION_ORDER.length // unmatched ("Other") sorts last
}

function sortCrewByPriority(crew) {
  return crew
    .map((member, index) => ({ member, index }))
    .sort((a, b) => crewPriority(a.member.job) - crewPriority(b.member.job) || a.index - b.index)
    .map(({ member }) => member)
}

export default function CastCrewTab({ cast, crew, loading, mediaType, onPersonClick, onMonitorCast }) {
  if (loading) {
    return (
      <div className="cast-crew-content">
        <div className="cast-crew-section">
          <div className="cast-crew-section-title">Cast</div>
          <CastSkeleton />
        </div>
        <div className="cast-crew-section">
          <div className="cast-crew-section-title">Crew</div>
          <CrewSkeleton />
        </div>
      </div>
    )
  }

  const hasCast = cast && cast.length > 0
  const hasCrew = crew && crew.length > 0
  if (!hasCast && !hasCrew) {
    return (
      <div className="cast-crew-empty">
        No cast or crew information available.
      </div>
    )
  }

  const sortedCrew = hasCrew ? sortCrewByPriority(crew) : []

  return (
    <div className="cast-crew-content">
      {hasCast && (
        <div className="cast-crew-section">
          <div className="cast-crew-section-title">Cast</div>
          <ScrollCarousel className="cast-scroll-row">
           {cast.map(member => (
                <CastCard key={member.id} member={member} onClick={onPersonClick} onMonitor={onMonitorCast} />
            ))}
          </ScrollCarousel>
        </div>
      )}

      {hasCrew && (
        <div className="cast-crew-section">
          <div className="cast-crew-section-title">
            {mediaType === 'tv' ? 'Key Crew' : 'Crew'}
          </div>
          <ScrollCarousel className="crew-scroll-row">
            {sortedCrew.map(member => (
              <CrewItem key={`${member.id}:${member.job}`} member={member} onClick={onPersonClick} />
            ))}
          </ScrollCarousel>
        </div>
      )}
    </div>
  )
}
