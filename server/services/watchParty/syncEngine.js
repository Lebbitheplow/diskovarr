// Watch Together sync decisions, kept free of I/O so they can be simulated in
// tests. The manager feeds one observation per member per tick (what that
// member's player reports) and sends whatever commands come back.
//
// The model: every member has the state the engine last *commanded*. A player
// that settles into the other state was changed by its viewer's own remote, and
// that pause/resume is mirrored to everyone. A position that jumps is a viewer
// seek and is mirrored the same way. Small drift is fixed by briefly holding
// (pausing) whoever is ahead — players land seeks seconds late, so re-seeking
// for fine alignment would never converge.

const TUNING = {
  SETTLE_MS: 3000,         // ignore a player's state this long after commanding it
  CONFIRM_TICKS: 2,        // consecutive ticks a viewer-made state must persist
  SEEK_JUMP_MS: 4000,      // position discontinuity that counts as a seek
  SEEK_GRACE_MS: 7000,     // let a seek land before judging positions again
  HOLD_THRESHOLD_MS: 2500, // lead over the slowest member that triggers a hold
  HOLD_COOLDOWN_MS: 5000,  // minimum gap between holds on one member
  GROUP_WINDOW_MS: 12000,  // further than this from the party → re-seek, not hold
  RESEEK_LIMIT: 3,         // give up on a member whose player ignores seeks
  MISSING_LIMIT: 6,        // ticks without a session before a member is dropped
  HOLD_OVERDUE_MS: 1500,   // tick releases a hold whose timer never fired
};

function createState({ hostId, desired = 'playing' } = {}) {
  return { hostId: hostId || null, desired, anchor: null, graceUntil: 0, members: new Map() };
}

// `commanded` is the state the member's player was last put in by the caller.
function addMember(state, userId, now, { commanded } = {}) {
  state.members.set(String(userId), {
    userId: String(userId), active: true, commanded: commanded || state.desired, commandedAt: now,
    obs: null, diverged: 0, missing: 0, hold: null, cooldownUntil: 0,
    seekGraceUntil: now + TUNING.SEEK_GRACE_MS, reseeks: 0, unsynced: false,
  });
}

function activeMembers(state) {
  return [...state.members.values()].filter(m => m.active);
}

// Where the party is right now, in ms into the title.
function partyPosition(state, now) {
  if (!state.anchor) return 0;
  return state.anchor.time + (state.desired === 'playing' ? now - state.anchor.at : 0);
}

function command(m, action, now, extra) {
  if (action !== 'seekTo') { m.commanded = action === 'play' ? 'playing' : 'paused'; m.commandedAt = now; m.diverged = 0; }
  return { userId: m.userId, action, ...extra };
}

function pauseAll(state, now, except) {
  const commands = [];
  state.desired = 'paused';
  for (const m of activeMembers(state)) {
    m.hold = null;
    if (m === except) { m.commanded = 'paused'; m.commandedAt = now; m.diverged = 0; continue; }
    if (m.commanded !== 'paused') commands.push(command(m, 'pause', now));
  }
  return commands;
}

function playAll(state, now, except) {
  const commands = [];
  state.desired = 'playing';
  if (state.anchor) state.anchor.at = now;
  for (const m of activeMembers(state)) {
    m.hold = null;
    m.cooldownUntil = now + TUNING.SETTLE_MS;
    if (m === except) { m.commanded = 'playing'; m.commandedAt = now; m.diverged = 0; continue; }
    commands.push(command(m, 'play', now));
  }
  return commands;
}

// Pause/resume requested from the party page rather than a player's remote.
function userCommand(state, action, now) {
  if (action === 'pause') return state.desired === 'paused' ? [] : pauseAll(state, now, null);
  return state.desired === 'playing' ? [] : playAll(state, now, null);
}

// Ends a drift hold. Called by the manager's timer; `force` is the tick's
// safety net for a timer that never fired.
function releaseHold(state, userId, now, force = false) {
  const m = state.members.get(String(userId));
  if (!m || !m.hold || (!force && now < m.hold.until - 50)) return [];
  m.hold = null;
  if (!m.active || state.desired !== 'playing') return [];
  m.cooldownUntil = now + TUNING.HOLD_COOLDOWN_MS;
  return [command(m, 'play', now)];
}

function dropMember(state, userId) {
  const m = state.members.get(String(userId));
  if (m) { m.active = false; m.hold = null; }
}

// observations: Map userId -> { state: 'playing'|'paused'|'buffering', time } or
// null when the member's player has no session for the title.
function tick(state, observations, now) {
  const commands = [];
  const events = [];
  const settled = (m) => now - m.commandedAt >= TUNING.SETTLE_MS;

  for (const m of activeMembers(state)) {
    const o = observations.get(m.userId) || null;
    m.jump = null;
    if (!o) {
      m.obs = null;
      if (++m.missing >= TUNING.MISSING_LIMIT) {
        dropMember(state, m.userId);
        events.push({ type: 'left', userId: m.userId });
      }
      continue;
    }
    m.missing = 0;
    const prev = m.obs;
    m.obs = { state: o.state, time: o.time, at: now };
    if (prev) m.jump = o.time - (prev.time + (prev.state === 'playing' ? now - prev.at : 0));
    const steady = o.state === 'playing' || o.state === 'paused';
    m.diverged = steady && o.state !== m.commanded ? m.diverged + 1 : 0;
    if (m.hold && now >= m.hold.until + TUNING.HOLD_OVERDUE_MS) commands.push(...releaseHold(state, m.userId, now, true));
  }

  const live = activeMembers(state).filter(m => m.obs);
  if (!activeMembers(state).length) {
    events.push({ type: 'ended' });
    return { commands, events };
  }

  // A viewer paused or resumed with their own remote.
  const actor = live.find(m => m.diverged >= TUNING.CONFIRM_TICKS && settled(m));
  if (actor) {
    if (actor.obs.state === 'paused') {
      commands.push(...pauseAll(state, now, actor));
      events.push({ type: 'pause', userId: actor.userId });
    } else if (actor.hold || state.desired === 'playing') {
      // Resumed out of a drift hold — let them run, drift is re-judged later.
      actor.hold = null;
      actor.commanded = 'playing'; actor.commandedAt = now; actor.diverged = 0;
      actor.cooldownUntil = now + TUNING.HOLD_COOLDOWN_MS;
    } else {
      commands.push(...playAll(state, now, actor));
      events.push({ type: 'play', userId: actor.userId });
    }
  }

  // A viewer seeked: bring everyone else to the same spot.
  const seeker = live.find(m => m.jump != null && Math.abs(m.jump) > TUNING.SEEK_JUMP_MS && now >= m.seekGraceUntil && !m.unsynced);
  if (seeker) {
    const target = seeker.obs.time;
    for (const m of activeMembers(state)) {
      m.seekGraceUntil = now + TUNING.SEEK_GRACE_MS;
      m.reseeks = 0;
      if (m === seeker) continue;
      commands.push(command(m, 'seekTo', now, { offset: target }));
      if (m.hold) {
        m.hold = null;
        if (state.desired === 'playing') commands.push(command(m, 'play', now));
      }
    }
    state.anchor = { time: target, at: now };
    state.graceUntil = now + TUNING.SEEK_GRACE_MS;
    events.push({ type: 'seek', userId: seeker.userId, offset: target });
  }

  if (now < state.graceUntil || !live.length) return { commands, events };

  // Re-anchor on the slowest member of the main group. Held members are paused
  // ahead of it on purpose, so they do not define the reference.
  // With no anchor yet (or nobody near it) the host's position is the party's.
  const eligible = live.filter(m => !m.unsynced && now >= m.seekGraceUntil);
  const near = (t) => eligible.filter(m => Math.abs(m.obs.time - t) <= TUNING.GROUP_WINDOW_MS);
  let group = state.anchor ? near(partyPosition(state, now)) : [];
  if (!group.length) {
    const lead = eligible.find(m => m.userId === state.hostId) || eligible[0];
    if (!lead) return { commands, events };
    group = near(lead.obs.time);
  }
  const reference = group.some(m => !m.hold) ? group.filter(m => !m.hold) : group;
  const partyTime = Math.min(...reference.map(m => m.obs.time));
  state.anchor = { time: partyTime, at: now };

  for (const m of live) {
    if (m.unsynced || now < m.seekGraceUntil) continue;
    if (!group.includes(m)) {
      // Far from the party (rejoined, or its player missed a seek).
      if (m.reseeks >= TUNING.RESEEK_LIMIT) {
        m.unsynced = true;
        events.push({ type: 'unsynced', userId: m.userId });
        continue;
      }
      m.reseeks++;
      m.seekGraceUntil = now + TUNING.SEEK_GRACE_MS;
      commands.push(command(m, 'seekTo', now, { offset: partyTime }));
      continue;
    }
    m.reseeks = 0;
    if (state.desired !== 'playing' || m.hold || m.obs.state !== 'playing' || m.commanded !== 'playing') continue;
    if (!settled(m) || now < m.cooldownUntil) continue;
    const lead = m.obs.time - partyTime;
    if (lead > TUNING.HOLD_THRESHOLD_MS) {
      m.hold = { until: now + lead };
      commands.push(command(m, 'pause', now, { holdMs: lead }));
      events.push({ type: 'hold', userId: m.userId, ms: lead });
    }
  }

  return { commands, events };
}

module.exports = { TUNING, createState, addMember, dropMember, activeMembers, partyPosition, userCommand, releaseHold, tick };
