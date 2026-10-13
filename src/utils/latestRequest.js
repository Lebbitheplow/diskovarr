// Latest-request-wins guard for a list that refetches as its filters change.
// start() aborts whatever is still in flight and hands back a ticket; only a
// ticket that is still current may apply its response, so a slow reply for an
// old query can never overwrite the results of a newer one.

export function createLatestRequest() {
  let active = null

  return {
    /** Begins a request, superseding (and aborting) any in flight. */
    start() {
      active?.controller.abort()
      const controller = new AbortController()
      const ticket = {
        controller,
        signal: controller.signal,
        get current() { return active === ticket },
      }
      active = ticket
      return ticket
    },
    /** Marks the ticket's request done; true if it was still the current one. */
    finish(ticket) {
      if (active !== ticket) return false
      active = null
      return true
    },
    /** Aborts the request in flight, if any (unmount). */
    cancel() {
      active?.controller.abort()
      active = null
    },
    get busy() { return active !== null },
  }
}
