import { useEffect } from 'react'

let openCount = 0

/**
 * Marks <html data-modal-open> while a page-covering modal is mounted.
 *
 * The ambient curtain and the hero's looping animations pause under it: the
 * modal hides them anyway, and a still backdrop means the compositor can keep
 * the modal's backdrop blur instead of recomputing it every frame. Counted,
 * so stacked modals (detail → request) only clear it when the last closes.
 */
export default function useModalOpen(active = true) {
  useEffect(() => {
    if (!active) return undefined
    openCount += 1
    document.documentElement.setAttribute('data-modal-open', '')
    return () => {
      openCount -= 1
      if (openCount === 0) document.documentElement.removeAttribute('data-modal-open')
    }
  }, [active])
}
