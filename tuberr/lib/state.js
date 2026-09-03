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

function noteQuotaExceeded(message) {
  state.quota.exceededAt = Date.now();
  state.quota.lastError = String(message || 'quotaExceeded').slice(0, 300);
}

function noteQuotaOk() {
  state.quota.exceededAt = null;
}

module.exports = { state, recordFailure, noteQuotaExceeded, noteQuotaOk };
