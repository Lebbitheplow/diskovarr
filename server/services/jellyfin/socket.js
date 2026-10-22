const db = require('../../db/database');
const client = require('./client');
const library = require('./library');
const userData = require('./userData');

// Real-time library-add detection over Jellyfin's native websocket — the
// Jellyfin analog of the Plex notification stream in plex.js. Authenticates
// with the admin API key (no session-token dance needed), answers the server's
// keep-alive protocol, and reconnects with backoff.
//
// LibraryChanged events carry the added and updated item ids (Data.ItemsAdded,
// Data.ItemsUpdated). Added ids are fetched by id in chunks
// (library.upsertItemsByIds, which resolves episodes/seasons to their series);
// updated ids refresh rows already in the library (library.refreshKnownItems).
// A message with no id list, or a failed fetch, falls back to a debounced
// pollNewItems() — the same enabled-folder-aware path the 10-minute fallback
// poll uses, so request fulfillment and monitor evaluation stay in one place.

// ── Per-play watch history from Sessions messages ────────────────────────────
// After SessionsStart the server pushes the full session list every 1.5 s. We
// follow what each session is playing; when the item disappears (stopped,
// switched, session gone) we write one watch_history row with the time
// actually spent playing and the final progress — Jellyfin's core API only
// tracks item-level played state, so this is what gives Wrapped/Popular
// per-play data.
//
// Played time accumulates between observations while the player is not
// paused (PlayState.IsPaused), each gap capped so a missed stretch of updates
// can't claim a long play. When the player reports positions, that time is
// also bounded by the forward progress playback can explain: a jump further
// than the elapsed playing time allows (a seek) or a jump backwards is not
// progress, while a replayed section is. So pauses, seeks and faster playback
// speeds can't inflate a play. Progress for the row comes from the last
// reported position.
const SESSIONS_INTERVAL = '0,1500';
const MIN_PLAY_SECONDS = 30; // shorter "plays" are channel-surfing noise
const MAX_GAP_SECONDS = 60; // most playing time one observation gap may add
const MAX_PLAYBACK_RATE = 2.5; // fastest playback speed treated as progress
const REPORT_SLACK_SECONDS = 15; // clients report their position every ~10 s
const RESUME_GAP_SECONDS = 5 * 60; // a play flushed by a socket drop resumes within this
const nowPlaying = new Map(); // sessionId → play (see startPlay)
const suspended = new Map(); // `${sessionId}|${itemId}` → { play, at } — flushed by a socket drop

function ticksOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The reported position, or null when the player sent none.
function positionOf(s) {
  const raw = s.PlayState?.PositionTicks;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function startPlay(s, item, itemId, pos, now) {
  return {
    sessionId: String(s.Id),
    item: { ...item, Id: itemId },
    userId: String(s.UserId),
    userName: s.UserName || '',
    userThumb: client.getAvatarPath(String(s.UserId), s.UserPrimaryImageTag || null),
    startedAt: now, // identity and watched_at of the play
    lastObsAt: now,
    paused: !!s.PlayState?.IsPaused,
    playingSec: 0, // wall time observed while not paused
    progressSec: 0, // forward position movement that playback explains
    positionsSeen: pos != null,
    anchorTicks: pos, // last distinct reported position…
    anchorPlayingSec: 0, // …and playingSec when it was first seen
    lastTicks: pos ?? 0,
  };
}

// Fold one observation (at `now`) into the play's timers.
function observe(play, now, pos, paused) {
  const gap = Math.min(Math.max(0, now - play.lastObsAt), MAX_GAP_SECONDS);
  if (!play.paused) play.playingSec += gap;
  if (pos != null) {
    if (play.anchorTicks == null) {
      play.anchorTicks = pos;
      play.anchorPlayingSec = play.playingSec;
    } else if (pos !== play.anchorTicks) {
      const delta = (pos - play.anchorTicks) / 10_000_000;
      const window = play.playingSec - play.anchorPlayingSec;
      if (delta > 0 && delta <= window * MAX_PLAYBACK_RATE + REPORT_SLACK_SECONDS) play.progressSec += delta;
      play.anchorTicks = pos;
      play.anchorPlayingSec = play.playingSec;
    }
    play.positionsSeen = true;
    play.lastTicks = pos;
  }
  play.paused = paused;
  play.lastObsAt = now;
}

function trackSession(s, now) {
  const item = s.NowPlayingItem;
  const sid = String(s.Id || '');
  if (!sid) return;
  const active = nowPlaying.get(sid);
  const itemId = item?.Id ? String(item.Id) : null;
  const trackable = itemId && (item.Type === 'Movie' || item.Type === 'Episode') && s.UserId;
  if (active && active.item.Id !== itemId) finalizePlay(sid, active, now); // switched or stopped
  if (!trackable) return;
  const pos = positionOf(s);
  const paused = !!s.PlayState?.IsPaused;
  const current = nowPlaying.get(sid);
  if (current && current.item.Id === itemId) {
    observe(current, now, pos, paused);
    return;
  }
  // Same session and item back right after a socket drop: one play, not two.
  const key = `${sid}|${itemId}`;
  const resumed = suspended.get(key);
  suspended.delete(key);
  const age = resumed ? now - resumed.at : -1;
  if (resumed && age >= 0 && age <= RESUME_GAP_SECONDS && resumed.play.userId === String(s.UserId)) {
    const play = resumed.play;
    Object.assign(play, { lastObsAt: now, paused, anchorTicks: pos, anchorPlayingSec: play.playingSec });
    if (pos != null) { play.positionsSeen = true; play.lastTicks = pos; }
    nowPlaying.set(sid, play);
    return;
  }
  nowPlaying.set(sid, startPlay(s, item, itemId, pos, now));
}

// `suspend`: the socket is going away, not the play — keep it resumable.
function finalizePlay(sid, play, now, { suspend = false } = {}) {
  nowPlaying.delete(sid);
  observe(play, now, null, play.paused); // the stretch since the last observation
  if (suspend) suspended.set(`${sid}|${play.item.Id}`, { play, at: now });
  try {
    const runtimeTicks = ticksOf(play.item.RunTimeTicks);
    const duration = Math.round(play.positionsSeen
      ? Math.min(play.playingSec, play.progressSec + REPORT_SLACK_SECONDS)
      : play.playingSec);
    if (duration < MIN_PLAY_SECONDS) return;
    const canonicalId = db.resolveCanonicalUserId(`jf_${play.userId}`);
    const row = userData.historyRowFor(play.userId, canonicalId, play.userName, play.userThumb, play.item, {
      ts: play.startedAt, duration, origin: 'session',
      historyId: `jfs:${play.userId}:${play.item.Id}:${play.sessionId}:${play.startedAt}`,
    });
    if (runtimeTicks && play.positionsSeen) row.percentComplete = Math.min(100, Math.round((play.lastTicks / runtimeTicks) * 100));
    row.watchedStatus = row.percentComplete >= userData.COMPLETE_PERCENT ? 'complete' : 'incomplete';
    userData.replaceJellyfinHistoryRow(row);
    console.log(`[jellyfin ws] play recorded: "${row.parentTitle ? `${row.parentTitle} — ` : ''}${row.title}" ${duration}s (${row.percentComplete}%) for ${canonicalId}`);
  } catch (err) {
    console.warn('[jellyfin ws] Failed to record play:', err.message);
  }
}

function handleSessions(list) {
  if (!Array.isArray(list)) return;
  const now = Math.floor(Date.now() / 1000);
  for (const [key, entry] of [...suspended]) {
    if (now - entry.at > RESUME_GAP_SECONDS) suspended.delete(key);
  }
  const seen = new Set();
  for (const s of list) {
    try {
      if (!s?.Id) continue;
      seen.add(String(s.Id));
      trackSession(s, now);
    } catch (err) {
      console.warn('[jellyfin ws] Bad session entry:', err.message);
    }
  }
  for (const [sid, play] of [...nowPlaying]) {
    if (!seen.has(sid)) finalizePlay(sid, play, now); // session vanished
  }
}

// Flush everything still playing (socket closing / server stopping). Each play
// is recorded now and stays resumable for RESUME_GAP_SECONDS, so a reconnect
// continues it under the same row instead of starting a second play.
function flushPlays() {
  const now = Math.floor(Date.now() / 1000);
  for (const [sid, play] of [...nowPlaying]) finalizePlay(sid, play, now, { suspend: true });
}

let ws = null;
let wantRunning = false;
let connected = false; // true between onopen and onclose (admin status pill)
let reconnectTimer = null;
let reconnectDelayMs = 5000;
let keepAliveTimer = null;
let debounceTimer = null;
let onFreshItems = null; // set once by server.js at boot
let connConfig = ''; // url + key the current socket was opened with

function currentConfig() {
  return `${client.getJellyfinUrl()}|${client.getJellyfinKey()}`;
}

function socketUrl() {
  const base = client.getJellyfinUrl().replace(/^http/i, 'ws');
  return `${base}/socket?api_key=${encodeURIComponent(client.getJellyfinKey())}&deviceId=diskovarr-app`;
}

function clearTimers() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect(reason) {
  if (!wantRunning || reconnectTimer) return;
  console.warn(`[jellyfin ws] Disconnected (${reason}) — reconnecting in ${reconnectDelayMs / 1000}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
    if (wantRunning && client.isEnabled()) connect();
  }, reconnectDelayMs);
  reconnectTimer.unref?.();
}

function deliver(fresh, label) {
  if (fresh.length > 0) {
    console.log(`[jellyfin ws] ${label} → picked up ${fresh.length} new item(s)`);
    onFreshItems?.(fresh);
  }
}

// Debounced so a bulk import (many LibraryChanged messages) runs one poll.
function triggerPoll(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    library.pollNewItems()
      .then(fresh => deliver(fresh, 'LibraryChanged poll'))
      .catch(err => console.warn('[jellyfin ws] Poll after LibraryChanged failed:', err.message));
  }, 3000);
  debounceTimer.unref?.();
  console.log(`[jellyfin ws] LibraryChanged (${reason}) — polling shortly`);
}

// By-id work runs one batch at a time, so an import burst queues up instead
// of fanning out concurrent requests.
let byIdQueue = Promise.resolve();
function enqueue(task) {
  byIdQueue = byIdQueue.then(task, task);
  return byIdQueue;
}

// Direct by-id upsert; a failure degrades to the poll fallback.
function fetchAdded(ids) {
  console.log(`[jellyfin ws] LibraryChanged (${ids.length} added) — fetching by id`);
  return enqueue(() => library.upsertItemsByIds(ids)
    .then(fresh => deliver(fresh, 'LibraryChanged'))
    .catch(err => {
      console.warn('[jellyfin ws] Fetch by id failed, falling back to poll:', err.message);
      triggerPoll('fallback');
    }));
}

function refreshUpdated(ids) {
  return enqueue(() => library.refreshKnownItems(ids)
    .then(fresh => deliver(fresh, 'LibraryChanged update'))
    .catch(err => console.warn('[jellyfin ws] Refresh of updated items failed:', err.message)));
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.MessageType === 'ForceKeepAlive') {
    // Data is the inactivity timeout in seconds; answer at half that rate.
    const timeoutSec = Number(msg.Data) || 60;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      try { ws?.send(JSON.stringify({ MessageType: 'KeepAlive' })); } catch { /* closing */ }
    }, Math.max(5, timeoutSec / 2) * 1000);
    keepAliveTimer.unref?.();
  } else if (msg.MessageType === 'Sessions') {
    handleSessions(msg.Data);
  } else if (msg.MessageType === 'LibraryChanged') {
    const added = msg.Data?.ItemsAdded;
    if (!Array.isArray(added)) return triggerPoll('no id list'); // unexpected shape — be safe
    const updated = Array.isArray(msg.Data?.ItemsUpdated) ? msg.Data.ItemsUpdated.map(String) : [];
    if (added.length > 0) fetchAdded(added.map(String));
    if (updated.length > 0) refreshUpdated(updated);
  }
}

function connect() {
  if (ws) return;
  connConfig = currentConfig();
  let socket;
  try {
    socket = new WebSocket(socketUrl());
  } catch (err) {
    scheduleReconnect(err.message);
    return;
  }
  ws = socket;

  socket.onopen = () => {
    reconnectDelayMs = 5000;
    connected = true;
    console.log('[jellyfin ws] Connected to Jellyfin notification socket');
    // Subscribe to session updates (per-play history). Without this the server
    // never sends Sessions messages.
    try { socket.send(JSON.stringify({ MessageType: 'SessionsStart', Data: SESSIONS_INTERVAL })); } catch { /* closing */ }
    // Establish pollNewItems' watermark now so the first LibraryChanged after
    // connect is actually picked up (its first call only sets the watermark).
    library.pollNewItems().catch(() => {});
  };
  socket.onmessage = (ev) => handleMessage(ev.data);
  socket.onerror = () => { /* onclose follows with the reconnect */ };
  socket.onclose = (ev) => {
    if (ws !== socket) return; // an intentional stop()/restart already replaced it
    ws = null;
    connected = false;
    flushPlays();
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    scheduleReconnect(`code ${ev.code || 'unknown'}`);
  };
}

function stop() {
  wantRunning = false;
  clearTimers();
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (ws) {
    const socket = ws;
    ws = null; // mark intentional so onclose doesn't reconnect
    connected = false;
    flushPlays();
    try { socket.send(JSON.stringify({ MessageType: 'SessionsStop' })); } catch { /* closing */ }
    try { socket.close(); } catch { /* already closed */ }
    console.log('[jellyfin ws] Stopped');
  }
}

// Reconciles the socket with the jellyfin settings. Called at boot (with the
// fresh-items handler) and after every /admin/connections/save.
function sync(handler) {
  if (handler) onFreshItems = handler;
  if (!client.isEnabled()) {
    if (wantRunning || ws) stop();
    return;
  }
  if (ws && connConfig !== currentConfig()) stop(); // URL/key changed — reconnect
  wantRunning = true;
  if (!ws && !reconnectTimer) connect();
}

// True while the notification socket is open (admin status pill).
function isConnected() { return connected; }

// Test hook: how many sessions are currently being tracked.
function trackedPlays() { return nowPlaying.size; }

module.exports = { sync, stop, isConnected, handleMessage, handleSessions, flushPlays, trackedPlays };
