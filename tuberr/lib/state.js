// In-memory runtime telemetry surfaced by GET /manage/status. Nothing here is
// persisted: it describes what this process has seen since it started. All
// timestamps are epoch milliseconds (Diskovarr's health job does `now - x`).

const FAILURE_RING_SIZE = 50;

const state = {
  lastRefreshAt: null,
  lastRefreshDurationMs: null,
  lastRefreshError: null,
  lastFastTickAt: null,
  lastGrabAt: null,
  lastCompletedAt: null,
  quota: { exceededAt: null, lastError: null },
  cookies: { botCheckAt: null },
  janitor: { lastRunAt: null, removed: 0, freedBytes: 0, lastError: null },
  // qBittorrent-API logins. `rejectingSince` starts a streak of refused logins
  // and a successful login ends it, so Diskovarr can tell a download client
  // with stale credentials (refused for minutes on end) from a brief gap
  // while its own wiring is being updated.
  qbitAuth: { lastLoginAt: null, rejectedAt: null, rejectingSince: null, rejectedUser: null, rejectedFrom: null },
  recentFailures: [],
};

function recordFailure({ videoId, releaseTitle, error, attempts }) {
  state.recentFailures.unshift({
    videoId: videoId || null,
    releaseTitle: releaseTitle || null,
    error: String(error || '').slice(-500),
    at: Date.now(),
    attempts: Number(attempts) || 0,
  });
  if (state.recentFailures.length > FAILURE_RING_SIZE) state.recentFailures.length = FAILURE_RING_SIZE;
}

function noteQbitLogin(ok, { username, from } = {}) {
  const a = state.qbitAuth;
  const now = Date.now();
  if (ok) {
    a.lastLoginAt = now;
    a.rejectingSince = null;
    return;
  }
  a.rejectedAt = now;
  a.rejectingSince = a.rejectingSince || now;
  a.rejectedUser = String(username ?? '').slice(0, 64);
  a.rejectedFrom = String(from || '').slice(0, 64);
}

function noteQuotaExceeded(message) {
  state.quota.exceededAt = Date.now();
  state.quota.lastError = String(message || 'quotaExceeded').slice(0, 300);
}

function noteQuotaOk() {
  state.quota.exceededAt = null;
}

module.exports = { state, recordFailure, noteQbitLogin, noteQuotaExceeded, noteQuotaOk };
