const db = require('../db/database');
const logger = require('./logger');
const tuberr = require('./tuberr');
const tuberrProcess = require('./tuberrProcess');
const { manager } = require('./notificationAgents');

// Periodic health + pipeline check for the YouTube integration. Tuberr is a
// separate process (bundled child or remote), so Diskovarr polls it: process
// state, /manage/health, /manage/status (queue, failures, refresh timestamps)
// and the Sonarr wiring (indexer + download client). Problems become admin
// notifications on state transitions only, so a long outage produces one
// alert and one recovery, not one per check.

const BOOT_DELAY_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const WIRING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UNREACHABLE_ALERT_AFTER_MS = 15 * 60 * 1000;
const REFRESH_STALE_MS = 12 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STAGING_WARN_BYTES = 50 * 1024 ** 3;
// A download client refused this long without any successful login in between
// has stale credentials (e.g. a hand-made client still on the pre-auth
// password); shorter streaks are Sonarr catching up after its wiring changed.
const AUTH_REJECT_GRACE_MS = 10 * 60 * 1000;
const AUTH_REJECT_RECENT_MS = 15 * 60 * 1000;

const state = {
  enabled: false, configured: false,
  managed: false, running: false, pid: null, restarts: 0, lastExit: null,
  reachable: null, lastCheckAt: null, lastOkAt: null, lastError: null,
  health: null, status: null,
  sonarrWiring: null, lastWiringCheckAt: null,
  alerts: [],
};

let unreachableSince = null;
let lastSeenFailureAt = 0;
const notified = { unreachable: false, refresh: false, botCheck: false, quota: false, process: false, qbitAuth: false };
let running = false;
let timer = null;

function notifyAdmins(type, title, body) {
  try {
    // Fan out to every enabled/configured agent. Each agent still self-filters
    // on the "YouTube downloader alerts" (tuberr_alert) type toggle at send
    // time, so ticking that box is what actually relays the alert externally.
    // The in-app bell (createOrBundleNotification) always fires regardless.
    const agentKeys = manager.getActiveAgents().map(a => a.key);
    for (const adminId of db.getAdminUserIds()) {
      const notifId = db.createOrBundleNotification({ userId: adminId, type, title, body, data: { source: 'tuberr' } });
      for (const agent of agentKeys) {
        db.enqueueNotification({ notificationId: notifId, agent, userId: adminId, payload: { type, title, body, posterUrl: null } });
      }
    }
    logger.warn(`[tuberr health] ${title} — ${body}`);
  } catch (e) {
    logger.warn('[tuberr health] admin notification failed:', e.message);
  }
}

// Fires once when `condition` becomes true and once when it clears again.
function transition(key, condition, onTitle, onBody, offTitle) {
  if (condition && !notified[key]) {
    notified[key] = true;
    notifyAdmins('tuberr_alert', onTitle, onBody);
  } else if (!condition && notified[key]) {
    notified[key] = false;
    if (offTitle) notifyAdmins('tuberr_alert', offTitle, 'The YouTube downloader is healthy again.');
  }
}

async function checkWiring(force) {
  const now = Date.now();
  // Wiring written by an older Diskovarr (e.g. the pre-auth download-client
  // password) is invisible to verifySonarrWiring, so it is re-applied once —
  // retried every check, not every 6 h, until it succeeds, because YouTube
  // downloads are broken in the meantime.
  const outdated = tuberr.sonarrWiringOutdated();
  if (!force && !outdated && state.lastWiringCheckAt && now - state.lastWiringCheckAt < WIRING_INTERVAL_MS) return;
  state.lastWiringCheckAt = now;
  const c = db.getConnectionSettings();
  if (!c.sonarrUrl || !c.sonarrApiKey) {
    state.sonarrWiring = { ok: false, message: 'Sonarr is not configured' };
    return;
  }
  try {
    let wiring = await tuberr.verifySonarrWiring();
    if (outdated && !wiring.downloadClient) {
      // No Tuberr download client in Sonarr → nothing old to migrate; a later
      // setupSonarr writes the current credentials anyway.
      tuberr.markSonarrWiringCurrent();
    } else if (outdated) {
      wiring = { ...wiring, ok: false, message: [wiring.ok ? '' : wiring.message, 'download client was set up by an older version and needs the current Tuberr credentials'].filter(Boolean).join('; ') };
    }
    if (!wiring.ok && db.getSetting('tuberr_auto_wire', '1') === '1') {
      try {
        const r = await tuberr.setupSonarr();
        wiring = await tuberr.verifySonarrWiring();
        wiring.message = `${r.message} (auto-repaired: ${wiring.message})`;
        logger.info(`[tuberr health] Sonarr wiring repaired: ${wiring.message}`);
      } catch (e) {
        wiring.message += ` — auto-repair failed: ${e.message}`;
      }
    } else if (outdated && wiring.downloadClient) {
      wiring.message += ' — click Set up Sonarr in Admin → Connections → YouTube (auto-repair is off)';
    }
    state.sonarrWiring = wiring;
  } catch (e) {
    state.sonarrWiring = { ok: false, message: `Could not verify Sonarr wiring: ${e.message}` };
  }
}

async function check({ force = false } = {}) {
  if (running) return state;
  running = true;
  const now = Date.now();
  try {
    const c = db.getConnectionSettings();
    state.enabled = !!c.youtubeEnabled;
    state.configured = !!(c.tuberrUrl && c.tuberrApiKey);
    Object.assign(state, tuberrProcess.getProcessInfo());
    state.lastCheckAt = now;
    const alerts = [];

    if (!state.enabled) {
      state.alerts = [];
      return state;
    }
    if (!state.configured) {
      state.alerts = ['Tuberr address or API key is not set — open Admin → Connections → YouTube'];
      return state;
    }

    try {
      state.health = await tuberr.health();
      state.status = await tuberr.status().catch(() => null); // older Tuberr builds lack /manage/status
      state.reachable = true;
      state.lastOkAt = now;
      state.lastError = null;
      unreachableSince = null;
    } catch (e) {
      state.reachable = false;
      state.lastError = e.message;
      unreachableSince = unreachableSince || now;
      alerts.push(`Tuberr unreachable: ${e.message}`);
    }

    transition('unreachable', !state.reachable && now - (unreachableSince || now) >= UNREACHABLE_ALERT_AFTER_MS,
      'YouTube downloader unreachable', `Tuberr at ${c.tuberrUrl} has not answered for 15+ minutes: ${state.lastError}. New YouTube episodes will not download until it is back.`,
      'YouTube downloader is back');

    transition('process', state.managed && !state.running && !state.restartPending,
      'YouTube downloader process is not running', `The bundled Tuberr process exited (${state.lastExit ? (state.lastExit.signal || `code ${state.lastExit.code}`) : 'unknown'}) and is not scheduled to restart.`,
      'YouTube downloader process restarted');
    if (state.managed && !state.running) alerts.push('Bundled Tuberr process is not running');

    const h = state.health;
    if (h) {
      if (!h.sonarr) alerts.push('Tuberr has no Sonarr credentials — re-save Connections to push them');
      if (!h.youtubeKey) alerts.push('YouTube API key missing in Tuberr — matching cannot run');
      if (!h.ytDlp || h.ytDlp === 'missing') alerts.push('yt-dlp binary missing — downloads will fail');
      if (h.ytDlpStatus?.updateError) alerts.push(`yt-dlp self-update failing: ${h.ytDlpStatus.updateError}`);
    }

    const s = state.status;
    if (s) {
      const refreshStale = !!s.lastRefreshError && (!s.lastRefreshAt || now - s.lastRefreshAt > REFRESH_STALE_MS);
      if (s.lastRefreshError) alerts.push(`Last refresh failed: ${s.lastRefreshError}`);
      transition('refresh', refreshStale, 'YouTube matching has been failing for 12+ hours', `Tuberr's refresh cycle keeps failing: ${s.lastRefreshError}`, 'YouTube matching recovered');

      const botCheck = !!(s.cookies?.botCheckAt && now - s.cookies.botCheckAt < RECENT_WINDOW_MS);
      if (botCheck) alerts.push('YouTube is asking for sign-in ("confirm you\'re not a bot") — refresh the cookies in Admin → Connections → YouTube');
      transition('botCheck', botCheck, 'YouTube downloads blocked by bot check', 'yt-dlp hit a "Sign in to confirm you\'re not a bot" wall. Export fresh YouTube cookies and paste them into Admin → Connections → YouTube.', null);

      const quota = !!(s.quota?.exceededAt && now - s.quota.exceededAt < RECENT_WINDOW_MS);
      if (quota) alerts.push('YouTube Data API quota exceeded — matching pauses until the daily reset');
      transition('quota', quota, 'YouTube API quota exceeded', s.quota?.lastError || 'The YouTube Data API returned quotaExceeded. Matching resumes after the daily reset (midnight Pacific).', null);

      const qa = s.qbitAuth;
      const authRefused = !!(qa?.rejectedAt && qa.rejectingSince
        && now - qa.rejectedAt < AUTH_REJECT_RECENT_MS && now - qa.rejectingSince >= AUTH_REJECT_GRACE_MS);
      if (authRefused) alerts.push(`Tuberr keeps refusing a download client's login (user '${qa.rejectedUser}' from ${qa.rejectedFrom}) — in Sonarr set it to username tuberr and the Tuberr API key as password, or click Set up Sonarr`);
      transition('qbitAuth', authRefused, 'Sonarr cannot log in to the YouTube downloader',
        `A qBittorrent download client (user '${qa?.rejectedUser}' from ${qa?.rejectedFrom}) has been failing to log in to Tuberr for 10+ minutes, so YouTube episodes will not download. In Sonarr, set that client's username to tuberr and its password to the Tuberr API key (Admin → Connections → YouTube), or click Set up Sonarr.`,
        'Sonarr can log in to the YouTube downloader again');

      const failures = Array.isArray(s.recentFailures) ? s.recentFailures.filter(f => f.at > lastSeenFailureAt) : [];
      if (failures.length) {
        lastSeenFailureAt = Math.max(...failures.map(f => f.at));
        const sample = failures.slice(0, 3).map(f => `${f.releaseTitle || f.videoId}: ${(f.error || '').split('\n').pop().slice(0, 120)}`).join('\n');
        notifyAdmins('tuberr_alert', `${failures.length} YouTube download${failures.length === 1 ? '' : 's'} failed`, sample);
      }
      if (Array.isArray(s.recentFailures) && s.recentFailures.some(f => now - f.at < RECENT_WINDOW_MS)) {
        alerts.push(`${s.recentFailures.filter(f => now - f.at < RECENT_WINDOW_MS).length} download failure(s) in the last 24h — see the YouTube dashboard`);
      }
      if (s.staging?.bytes > STAGING_WARN_BYTES) {
        alerts.push(`Staging folder holds ${(s.staging.bytes / 1024 ** 3).toFixed(1)} GB of completed downloads — run cleanup`);
      }
    }

    await checkWiring(force);
    if (state.sonarrWiring && !state.sonarrWiring.ok) alerts.push(`Sonarr wiring: ${state.sonarrWiring.message}`);

    state.alerts = alerts;
    return state;
  } catch (e) {
    state.lastError = e.message;
    logger.warn('[tuberr health] check failed:', e.message);
    return state;
  } finally {
    running = false;
  }
}

function getStatus() {
  return { ...state };
}

function start() {
  if (timer) return;
  setTimeout(() => check({ force: true }).catch(() => {}), BOOT_DELAY_MS).unref();
  timer = setInterval(() => check().catch(() => {}), CHECK_INTERVAL_MS);
  timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, check, getStatus };
