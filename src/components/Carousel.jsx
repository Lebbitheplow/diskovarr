import React, { useRef, useEffect, useState, useCallback } from 'react'

export default function Carousel({ children, variant = 'home' }) {
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
      {!canScrollLeft && <button className="carousel-arrow carousel-arrow-prev" disabled aria-label="Previous">❮</button>}
      {canScrollLeft && (
        <button className="carousel-arrow carousel-arrow-prev" onClick={() => scrollByAmount(-scrollRef.current?.clientWidth || 0)} aria-label="Previous">❮</button>
      )}
      <div className={`card-grid ${variant === 'home' ? '' : ''}`} ref={scrollRef} style={variant === 'home' ? { gridTemplateRows: 'repeat(2, auto)', gridAutoFlow: 'column', gridAutoColumns: '160px' } : {}}>
        {children}
      </div>
      {!canScrollRight && <button className="carousel-arrow carousel-arrow-next" disabled aria-label="Next">❯</button>}
      {canScrollRight && (
        <button className="carousel-arrow carousel-arrow-next" onClick={() => scrollByAmount(scrollRef.current?.clientWidth || 0)} aria-label="Next">❯</button>
      )}
    </div>
  )
}
