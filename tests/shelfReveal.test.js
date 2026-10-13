import { describe, it, expect } from 'vitest'
import { isOnScreen } from '../src/hooks/useShellMotion'

// The reveal gate shows a grid in place (no entrance, before its first paint)
// when this says it is on screen, and leaves it to the scroll observer when not
const box = (top, height, left = 0, width = 1000) =>
  ({ top, height, bottom: top + height, left, width, right: left + width })

describe('shelf reveal: on-screen check', () => {
  const W = 1440
  const H = 900

  it('counts a grid inside the viewport', () => {
    expect(isOnScreen(box(200, 500), W, H)).toBe(true)
  })

  it('counts a grid only partly in view, at either edge', () => {
    expect(isOnScreen(box(850, 500), W, H)).toBe(true)
    expect(isOnScreen(box(-450, 500), W, H)).toBe(true)
  })

  it('leaves a grid below or above the viewport to the observer', () => {
    expect(isOnScreen(box(900, 500), W, H)).toBe(false)
    expect(isOnScreen(box(1600, 500), W, H)).toBe(false)
    expect(isOnScreen(box(-500, 500), W, H)).toBe(false)
  })

  it('leaves a grid scrolled off sideways to the observer', () => {
    expect(isOnScreen(box(200, 500, 1440), W, H)).toBe(false)
    expect(isOnScreen(box(200, 500, -1000), W, H)).toBe(false)
  })

  it('never counts a box with no size, such as one under display:none', () => {
    expect(isOnScreen(box(0, 0, 0, 0), W, H)).toBe(false)
    expect(isOnScreen(box(200, 0), W, H)).toBe(false)
    expect(isOnScreen(box(200, 500, 0, 0), W, H)).toBe(false)
  })
})
