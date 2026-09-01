// Helpers for undoing a "not interested" dismissal.
//
// A dismissal removes one item from several parallel lists at once (top picks,
// movies, TV, anime, trending…). To put it back where it was, record the index
// it held in each list before removing it, then splice it back in on undo.
//
// Restoring a whole pre-dismiss snapshot would be simpler but wrong: it would
// also resurrect anything else dismissed in the meantime.

/** Index of `item` in every array-valued key of `state`, keyed by list name. */
export function capturePositions(state, matches) {
  const positions = {}
  for (const [key, list] of Object.entries(state || {})) {
    if (!Array.isArray(list)) continue
    const index = list.findIndex(matches)
    if (index >= 0) positions[key] = index
  }
  return positions
}

/** Splice `item` back into each recorded position, skipping lists it's already in. */
export function restorePositions(state, positions, item, matches) {
  if (!state) return state
  const next = { ...state }
  for (const [key, index] of Object.entries(positions)) {
    const list = next[key]
    if (!Array.isArray(list) || list.some(matches)) continue
    const copy = list.slice()
    // The list may have shrunk since; clamp rather than leaving a hole
    copy.splice(Math.min(index, copy.length), 0, item)
    next[key] = copy
  }
  return next
}
