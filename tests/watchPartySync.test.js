import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// Watch Together sync engine, driven against simulated players that behave
// like the real ones measured on a Samsung TV: position reported in whole
// seconds, commands landing after a short delay, seeks landing seconds late.
const nodeRequire = createRequire(import.meta.url)
const engine = nodeRequire('../server/services/watchParty/syncEngine.js')

class SimPlayer {
  constructor({ time = 0, seekLate = 0, latency = 80, phase = 0 } = {}) {
    Object.assign(this, { time, seekLate, latency, phase, state: 'playing', gone: false, queue: [] })
  }
  advance(dt) {
    if (this.state === 'playing') this.time += dt
  }
  apply(now) {
    while (this.queue.length && this.queue[0].at <= now) {
      const c = this.queue.shift()
      if (c.action === 'pause') this.state = 'paused'
      else if (c.action === 'play') this.state = 'playing'
      else if (c.action === 'seekTo') this.time = c.offset + this.seekLate
    }
  }
  send(command, now) { this.queue.push({ ...command, at: now + this.latency }) }
  observe() {
    if (this.gone) return null
    return { state: this.state, time: Math.floor((this.time + this.phase) / 1000) * 1000 }
  }
}

// Runs the manager's loop in miniature: 100ms steps, a tick each second, hold
// timers honoured. `script` maps a time (ms) to something a viewer does.
function simulate(players, { duration, script = {}, desired = 'playing' }) {
  const state = engine.createState({ hostId: 'a', desired })
  const events = []
  const timers = []
  const send = (commands, now) => {
    for (const c of commands) {
      players[c.userId].send(c, now)
      if (c.holdMs) timers.push({ at: now + c.holdMs, userId: c.userId })
    }
  }
  for (const id of Object.keys(players)) engine.addMember(state, id, 0)
  for (let now = 0; now <= duration; now += 100) {
    for (const p of Object.values(players)) { p.apply(now); p.advance(100) }
    if (script[now]) script[now](players, state, (commands) => send(commands, now))
    for (const t of timers.filter(x => x.at <= now && !x.done)) {
      t.done = true
      send(engine.releaseHold(state, t.userId, now), now)
    }
    if (now % 1000 === 0) {
      const observations = new Map(Object.entries(players).map(([id, p]) => [id, p.observe()]))
      const result = engine.tick(state, observations, now)
      events.push(...result.events.map(e => ({ ...e, at: now })))
      send(result.commands, now)
    }
  }
  return { state, events }
}

const spread = (players) => {
  const times = Object.values(players).map(p => p.time)
  return Math.max(...times) - Math.min(...times)
}

describe('drift correction', () => {
  it('holds the player that is ahead until the others catch up', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 66000, phase: 400 }) }
    const { events } = simulate(players, { duration: 30000 })
    expect(events.some(e => e.type === 'hold' && e.userId === 'b')).toBe(true)
    expect(spread(players)).toBeLessThan(1600)
    expect(players.a.state).toBe('playing')
    expect(players.b.state).toBe('playing')
  })

  it('leaves players alone when they are already close', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 61200, phase: 700 }) }
    const { events } = simulate(players, { duration: 40000 })
    expect(events).toEqual([])
  })

  it('does not treat its own hold as a viewer pausing', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 68000 }) }
    const { events, state } = simulate(players, { duration: 30000 })
    expect(events.filter(e => e.type === 'pause')).toEqual([])
    expect(state.desired).toBe('playing')
  })

  it('re-seeks a player that is far from the party instead of holding it', () => {
    const players = { a: new SimPlayer({ time: 600000 }), b: new SimPlayer({ time: 5000, seekLate: 6000 }), c: new SimPlayer({ time: 600500 }) }
    const { state } = simulate(players, { duration: 45000 })
    expect(spread(players)).toBeLessThan(1600)
    expect(players.a.time).toBeGreaterThan(600000)
    expect(state.members.get('b').unsynced).toBe(false)
  })

  it('gives up on a player that ignores seeks rather than dragging the party', () => {
    const stuck = new SimPlayer({ time: 5000 })
    stuck.send = () => {}
    const players = { a: new SimPlayer({ time: 600000 }), b: stuck }
    const { state, events } = simulate(players, { duration: 60000 })
    expect(state.members.get('b').unsynced).toBe(true)
    expect(events.filter(e => e.type === 'unsynced')).toHaveLength(1)
    expect(players.a.time).toBeGreaterThan(655000)
  })
})

describe('mirroring a viewer\'s own remote', () => {
  it('pauses everyone when one viewer pauses, and resumes when they resume', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 60300 }) }
    const { events, state } = simulate(players, {
      duration: 40000,
      script: {
        12000: (p) => { p.b.state = 'paused' },
        16000: (p) => { expect(p.a.state).toBe('paused') },
        24000: (p) => { p.a.state = 'playing' },
      },
    })
    expect(events.map(e => `${e.type}:${e.userId}`)).toEqual(['pause:b', 'play:a'])
    expect(state.desired).toBe('playing')
    expect(players.b.state).toBe('playing')
  })

  it('ignores a pause that only flickers for a moment', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 60300 }) }
    const { events } = simulate(players, {
      duration: 25000,
      script: { 12000: (p) => { p.b.state = 'paused' }, 12500: (p) => { p.b.state = 'playing' } },
    })
    expect(events.filter(e => e.type === 'pause')).toEqual([])
    expect(players.a.state).toBe('playing')
  })

  it('does not mistake buffering for a pause', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 60300 }) }
    const { events } = simulate(players, {
      duration: 30000,
      script: { 12000: (p) => { p.b.state = 'buffering' }, 15500: (p) => { p.b.state = 'playing' } },
    })
    expect(events.filter(e => e.type === 'pause' || e.type === 'seek')).toEqual([])
    // a ran ahead while b buffered, so a is the one held back afterwards
    expect(events.some(e => e.type === 'hold' && e.userId === 'a')).toBe(true)
    expect(spread(players)).toBeLessThan(1600)
  })

  it('follows a viewer who seeks, even though players land seeks late', () => {
    const players = { a: new SimPlayer({ time: 60000, seekLate: 7000 }), b: new SimPlayer({ time: 60300, seekLate: 5000 }) }
    const { events } = simulate(players, {
      duration: 50000,
      script: { 12000: (p) => { p.a.time = 900000 } },
    })
    const seeks = events.filter(e => e.type === 'seek')
    expect(seeks).toHaveLength(1)
    expect(seeks[0].userId).toBe('a')
    expect(players.b.time).toBeGreaterThan(900000)
    expect(spread(players)).toBeLessThan(1600)
  })

  it('follows a seek made while paused and stays paused', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 60300 }) }
    const { state } = simulate(players, {
      duration: 40000,
      script: { 10000: (p) => { p.a.state = 'paused' }, 20000: (p) => { p.a.time = 300000 } },
    })
    expect(state.desired).toBe('paused')
    expect(players.b.state).toBe('paused')
    expect(Math.abs(players.b.time - 300000)).toBeLessThan(1000)
  })
})

describe('party page controls and membership', () => {
  it('pauses and resumes everyone from the page', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 60300 }) }
    const { events, state } = simulate(players, {
      duration: 30000,
      script: {
        10000: (p, s, send) => send(engine.userCommand(s, 'pause', 10000)),
        14000: (p) => { expect(p.a.state).toBe('paused'); expect(p.b.state).toBe('paused') },
        18000: (p, s, send) => send(engine.userCommand(s, 'play', 18000)),
      },
    })
    expect(events.filter(e => e.type === 'pause' || e.type === 'play')).toEqual([])
    expect(state.desired).toBe('playing')
    expect(players.a.state).toBe('playing')
  })

  it('drops a member who stops watching without disturbing the rest', () => {
    const players = { a: new SimPlayer({ time: 60000 }), b: new SimPlayer({ time: 60300 }) }
    const { events, state } = simulate(players, {
      duration: 30000,
      script: { 10000: (p) => { p.b.gone = true } },
    })
    expect(events.map(e => e.type)).toEqual(['left'])
    expect(state.members.get('b').active).toBe(false)
    expect(players.a.state).toBe('playing')
  })

  it('ends once nobody is watching', () => {
    const players = { a: new SimPlayer({ time: 60000 }) }
    const { events } = simulate(players, { duration: 20000, script: { 5000: (p) => { p.a.gone = true } } })
    expect(events.some(e => e.type === 'ended')).toBe(true)
  })
})
