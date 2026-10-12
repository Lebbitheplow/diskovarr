import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { dialogStack } from '../utils/dialogStack'

const focusedElement = () => (typeof document === 'undefined' ? null : document.activeElement)

/**
 * Registers a dialog in the shared layer stack (utils/dialogStack) while
 * `active`. Escape calls `onEscape` only when this dialog is the topmost one,
 * so closing a dialog opened from another leaves the first open; on close,
 * focus goes back to what had it when the dialog opened. Leave `onEscape` out
 * for a dialog that shouldn't close on Escape — it still keeps Escape from
 * reaching the dialogs beneath it. `priority` keeps a dialog above ones that
 * open after it (see dialogStack.push).
 *
 * Returns a stable function for a dialog that handles Back itself: it closes
 * the topmost dialog stacked on this one and returns true, or returns false
 * when this one is on top.
 */
export default function useDialogLayer(active, onEscape, { priority = 0 } = {}) {
  // The opener is read while rendering the open, before any autoFocus inside
  // the dialog has moved focus. Render-phase adjustment, React's recommended
  // alternative to syncing state from an effect.
  const [opener, setOpener] = useState(() => (active ? focusedElement() : null))
  const [wasActive, setWasActive] = useState(!!active)
  if (!!active !== wasActive) {
    setWasActive(!!active)
    setOpener(active ? focusedElement() : null)
  }

  // Latest handler without re-registering: re-pushing would move this dialog
  // above ones opened after it.
  const handleEscape = useEffectEvent((e) => { onEscape?.(e) })
  const popRef = useRef(null)

  useEffect(() => {
    if (!active) return undefined
    const pop = dialogStack.push({ onEscape: (e) => handleEscape(e), restoreFocus: opener, priority })
    popRef.current = pop
    return () => {
      popRef.current = null
      pop()
    }
  }, [active, opener, priority])

  return useCallback(() => dialogStack.dismissAbove(popRef.current), [])
}
