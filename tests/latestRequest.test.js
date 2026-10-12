import { describe, it, expect } from 'vitest'
import { createLatestRequest } from '../src/utils/latestRequest'

// A response the test resolves by hand, to model a slow network
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

// The way Discover uses it: apply a reply only while its ticket is current
async function run(requests, reply, shown) {
  const ticket = requests.start()
  try {
    const data = await reply.promise
    if (ticket.current) shown.push(data)
  } finally {
    requests.finish(ticket)
  }
  return ticket
}

describe('createLatestRequest', () => {
  it('drops a slow reply for an older query once a newer one has started', async () => {
    const requests = createLatestRequest()
    const shown = []
    const movie1 = deferred()
    const movie12 = deferred()
    const first = run(requests, movie1, shown)
    const second = run(requests, movie12, shown)
    movie12.resolve('Movie 12')
    movie1.resolve('Movie 1') // arrives last, must not win
    await Promise.all([first, second])
    expect(shown).toEqual(['Movie 12'])
  })

  it('aborts the superseded request', () => {
    const requests = createLatestRequest()
    const old = requests.start()
    const next = requests.start()
    expect(old.signal.aborted).toBe(true)
    expect(old.current).toBe(false)
    expect(next.signal.aborted).toBe(false)
    expect(next.current).toBe(true)
  })

  it('is busy only while the current request is unfinished', () => {
    const requests = createLatestRequest()
    expect(requests.busy).toBe(false)
    const old = requests.start()
    const next = requests.start()
    expect(requests.finish(old)).toBe(false) // stale: leaves the newer one in charge
    expect(requests.busy).toBe(true)
    expect(requests.finish(next)).toBe(true)
    expect(requests.busy).toBe(false)
  })

  it('cancel aborts the request in flight and retires its ticket', () => {
    const requests = createLatestRequest()
    const ticket = requests.start()
    requests.cancel()
    expect(ticket.signal.aborted).toBe(true)
    expect(ticket.current).toBe(false)
    expect(requests.busy).toBe(false)
  })
})
