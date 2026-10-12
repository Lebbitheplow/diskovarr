// The stack of open dialogs, so stacked flows (detail → request, detail →
// movie night) behave as layers: Escape reaches only the topmost dialog, and
// closing one hands focus back to whatever had it when that dialog opened.
// Kept free of React so the ordering rules can be tested directly.

function canFocus(el, doc) {
  return !!el && el !== doc?.body && el.isConnected !== false && typeof el.focus === 'function'
}

export function createDialogStack(doc) {
  const layers = []
  // Layer behind each function push() returned, for dismissAbove
  const layerOf = new WeakMap()
  // Focus target of a dialog that just closed, restored on the next microtask
  // unless another dialog opens first and claims it
  let pendingFocus = null

  const onKeyDown = (e) => {
    // A widget inside the dialog that uses Escape itself (an open suggestion
    // list) calls preventDefault to keep the dialog open.
    if (e.key !== 'Escape' || e.defaultPrevented || layers.length === 0) return
    layers[layers.length - 1].onEscape?.(e)
  }

  return {
    /**
     * Adds a dialog on top. `onEscape` runs when Escape is pressed while it is
     * the topmost layer (omit it for dialogs that shouldn't close on Escape —
     * they still shield the ones beneath). `restoreFocus` is the element to
     * refocus on close. A higher `priority` keeps a dialog above ones opened
     * after it (the first-login taste quiz over a deep-linked detail modal
     * that finished loading later). Returns the function that removes the layer.
     */
    push({ onEscape, restoreFocus = null, priority = 0 } = {}) {
      // Opening as another dialog closes (detail → page's request dialog):
      // if this one's opener went away with the closed dialog, return focus
      // where that one would have. Also stops StrictMode's remount from
      // bouncing focus out of a freshly opened dialog.
      if (pendingFocus) {
        if (!canFocus(restoreFocus, doc)) restoreFocus = pendingFocus
        pendingFocus = null
      }
      const layer = { onEscape, restoreFocus, priority }
      // Slide under any layer that outranks this one
      let at = layers.length
      while (at > 0 && layers[at - 1].priority > priority) at--
      layers.splice(at, 0, layer)
      if (layers.length === 1) doc?.addEventListener('keydown', onKeyDown)
      const pop = () => {
        const i = layers.indexOf(layer)
        if (i === -1) return
        layers.splice(i, 1)
        if (layers.length === 0) doc?.removeEventListener('keydown', onKeyDown)
        if (i < layers.length) {
          // Removed from under another dialog — its parent unmounting first.
          // The one above was opened from inside it, so its own focus target
          // is going away too; hand it this layer's target instead. Not for
          // a layer that is only above because it outranks this one.
          if (layers[i].priority <= layer.priority) layers[i].restoreFocus = layer.restoreFocus
          return
        }
        const el = layer.restoreFocus
        if (!canFocus(el, doc)) return
        pendingFocus = el
        queueMicrotask(() => {
          if (pendingFocus !== el) return
          pendingFocus = null
          if (canFocus(el, doc)) el.focus({ preventScroll: true })
        })
      }
      layerOf.set(pop, layer)
      return pop
    },
    /**
     * Back for a dialog that keeps a history entry (DetailModal): Back, like
     * Escape, should close only the topmost dialog. When other dialogs sit
     * above the one `pop` removes, the topmost gets its Escape action (none
     * for one that shields) and this returns true; false when that dialog is
     * itself on top or no longer open.
     */
    dismissAbove(pop) {
      const i = layers.indexOf(layerOf.get(pop))
      if (i === -1 || i === layers.length - 1) return false
      layers[layers.length - 1].onEscape?.()
      return true
    },
    get depth() { return layers.length },
  }
}

export const dialogStack = createDialogStack(typeof document === 'undefined' ? null : document)
