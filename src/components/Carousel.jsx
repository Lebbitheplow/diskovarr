import React, { useRef, useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

export default function Carousel({ children, variant = 'home' }) {
  const { t } = useTranslation()
  const scrollRef = useRef(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)

  const checkScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 2)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
  }, [])

  useEffect(() => {
    checkScroll()
    const el = scrollRef.current
    if (el) {
      el.addEventListener('scroll', checkScroll, { passive: true })
      return () => el.removeEventListener('scroll', checkScroll)
    }
  }, [checkScroll])

  const scrollByAmount = (amount) => {
    scrollRef.current?.scrollBy({ left: amount, behavior: 'smooth' })
  }

  // One button per side, disabled at the end of the track rather than swapped
  // for a second element: the same node keeps its opacity transition, so an
  // arrow fades out at the end instead of popping as a fresh element.
  return (
    <div className="carousel-wrap">
      <button
        className="carousel-arrow carousel-arrow-prev"
        disabled={!canScrollLeft}
        onClick={() => scrollByAmount(-scrollRef.current?.clientWidth || 0)}
        aria-label={t('Previous')}
      >❮</button>
      {/* Track shape comes from .carousel-wrap .card-grid in CSS. It used to be
          set inline here, which silently beat the ≤600px rule that narrows the
          columns for phones. */}
      <div className="card-grid" data-variant={variant} ref={scrollRef}>
        {children}
      </div>
      <button
        className="carousel-arrow carousel-arrow-next"
        disabled={!canScrollRight}
        onClick={() => scrollByAmount(scrollRef.current?.clientWidth || 0)}
        aria-label={t('Next')}
      >❯</button>
    </div>
  )
}
