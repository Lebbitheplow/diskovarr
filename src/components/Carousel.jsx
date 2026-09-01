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

  return (
    <div className="carousel-wrap">
      {!canScrollLeft && <button className="carousel-arrow carousel-arrow-prev" disabled aria-label={t('Previous')}>❮</button>}
      {canScrollLeft && (
        <button className="carousel-arrow carousel-arrow-prev" onClick={() => scrollByAmount(-scrollRef.current?.clientWidth || 0)} aria-label={t('Previous')}>❮</button>
      )}
      {/* Track shape comes from .carousel-wrap .card-grid in CSS. It used to be
          set inline here, which silently beat the ≤600px rule that narrows the
          columns for phones. */}
      <div className="card-grid" data-variant={variant} ref={scrollRef}>
        {children}
      </div>
      {!canScrollRight && <button className="carousel-arrow carousel-arrow-next" disabled aria-label={t('Next')}>❯</button>}
      {canScrollRight && (
        <button className="carousel-arrow carousel-arrow-next" onClick={() => scrollByAmount(scrollRef.current?.clientWidth || 0)} aria-label={t('Next')}>❯</button>
      )}
    </div>
  )
}
