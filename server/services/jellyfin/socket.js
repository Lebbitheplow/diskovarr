const db = require('../../db/database');
const client = require('./client');
const library = require('./library');
const userData = require('./userData');

// Real-time library-add detection over Jellyfin's native websocket — the
// Jellyfin analog of the Plex notification stream in plex.js. Authenticates
// with the admin API key (no session-token dance needed), answers the server's
// keep-alive protocol, and reconnects with backoff.
//
// LibraryChanged events carry the added item ids (Data.ItemsAdded). Small
// batches are fetched directly by id (library.upsertItemsByIds); anything
// larger, or a message with no id list, falls back to a debounced
// pollNewItems() — the same bounded, enabled-folder-aware path the 10-minute
// fallback poll uses, so request fulfillment and monitor evaluation stay in
// one place.

const MAX_DIRECT_IDS = 50;

// ── Per-play watch history from Sessions messages ────────────────────────────
// After SessionsStart the server pushes the full session list every 1.5 s. We
// remember what each session is playing; when the item disappears (stopped,
// switched, session gone) we write one watch_history row with the real
// played length and progress — Jellyfin's core API only tracks item-level
// played state, so this is what gives Wrapped/Popular per-play data.
const SESSIONS_INTERVAL = '0,1500';
const MIN_PLAY_SECONDS = 30; // shorter "plays" are channel-surfing noise
const nowPlaying = new Map(); // sessionId → { item, userId, userName, userThumb, startTicks, maxTicks, startedAt, lastSeen }

function ticksOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
  const pos = ticksOf(s.PlayState?.PositionTicks);
  const current = nowPlaying.get(sid);
  if (current && current.item.Id === itemId) {
    current.maxTicks = Math.max(current.maxTicks, pos);
    current.lastSeen = now;
    return;
  }
  nowPlaying.set(sid, {
    item: { ...item, Id: itemId },
    userId: String(s.UserId),
    userName: s.UserName || '',
    userThumb: client.getAvatarPath(String(s.UserId), s.UserPrimaryImageTag || null),
    startTicks: pos,
    maxTicks: pos,
    startedAt: now,
    lastSeen: now,
  });
}

function finalizePlay(sid, play, now) {
  nowPlaying.delete(sid);
  try {
    const runtimeTicks = ticksOf(play.item.RunTimeTicks);
    const wall = Math.max(0, now - play.startedAt);
    // Progress made this play (position delta) — bounded by wall-clock time so a
    // seek to the end can't claim a full watch — falls back to wall time when
    // the player never reported positions.
    const progressed = Math.max(0, play.maxTicks - play.startTicks) / 10_000_000;
    const duration = Math.round(progressed > 0 ? Math.min(progressed, wall + 5) : wall);
    if (duration < MIN_PLAY_SECONDS) return;
    const canonicalId = db.resolveCanonicalUserId(`jf_${play.userId}`);
    const row = userData.historyRowFor(play.userId, canonicalId, play.userName, play.userThumb, play.item, { ts: now, duration });
    if (runtimeTicks) row.percentComplete = Math.min(100, Math.round((play.maxTicks / runtimeTicks) * 100));
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

// Flush everything still playing (socket closing / server stopping).
function flushPlays() {
  const now = Math.floor(Date.now() / 1000);
  for (const [sid, play] of [...nowPlaying]) finalizePlay(sid, play, now);
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

// Direct by-id upsert; a failure degrades to the poll fallback.
function fetchAdded(ids) {
  console.log(`[jellyfin ws] LibraryChanged (${ids.length} added) — fetching by id`);
  return library.upsertItemsByIds(ids)
    .then(fresh => deliver(fresh, 'LibraryChanged'))
    .catch(err => {
      console.warn('[jellyfin ws] Fetch by id failed, falling back to poll:', err.message);
      triggerPoll('fallback');
    });
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
    if (added.length === 0) return; // updates/removals only — nothing to add
    if (added.length > MAX_DIRECT_IDS) return triggerPoll(`${added.length} added`);
    return fetchAdded(added.map(String));
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
