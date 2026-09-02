const client = require('./client');
const library = require('./library');

// Real-time library-add detection over Jellyfin's native websocket — the
// Jellyfin analog of the Plex notification stream in plex.js. Authenticates
// with the admin API key (no session-token dance needed), answers the server's
// keep-alive protocol, and reconnects with backoff.
//
// LibraryChanged events don't carry enough metadata to upsert directly, so an
// event just triggers an immediate (debounced) pollNewItems() — the same
// bounded, enabled-folder-aware code path the 10-minute fallback poll uses, so
// request fulfillment and monitor evaluation stay in one place.

let ws = null;
let wantRunning = false;
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

// Debounced so a bulk import (many LibraryChanged messages) runs one poll.
function triggerPoll(count) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    library.pollNewItems()
      .then(fresh => {
        if (fresh.length > 0) {
          console.log(`[jellyfin ws] LibraryChanged → picked up ${fresh.length} new item(s)`);
          onFreshItems?.(fresh);
        }
      })
      .catch(err => console.warn('[jellyfin ws] Poll after LibraryChanged failed:', err.message));
  }, 3000);
  debounceTimer.unref?.();
  console.log(`[jellyfin ws] LibraryChanged (${count} added) — polling shortly`);
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
  } else if (msg.MessageType === 'LibraryChanged') {
    const added = msg.Data?.ItemsAdded || [];
    if (added.length > 0) triggerPoll(added.length);
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
    console.log('[jellyfin ws] Connected to Jellyfin notification socket');
    // Establish pollNewItems' watermark now so the first LibraryChanged after
    // connect is actually picked up (its first call only sets the watermark).
    library.pollNewItems().catch(() => {});
  };
  socket.onmessage = (ev) => handleMessage(ev.data);
  socket.onerror = () => { /* onclose follows with the reconnect */ };
  socket.onclose = (ev) => {
    if (ws !== socket) return; // an intentional stop()/restart already replaced it
    ws = null;
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

module.exports = { sync, stop };
