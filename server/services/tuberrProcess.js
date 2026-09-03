const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

// Supervises the bundled Tuberr instance (../../tuberr) as a child process:
// started when the YouTube integration is enabled, stopped when disabled, and
// restarted with backoff if it crashes. Skipped when TUBERR_URL is set (the
// Docker image's entrypoint runs its own Tuberr) or TUBERR_MANAGED=0.
//
// Child stdout/stderr are piped through this process (so journald/docker logs
// still carry them) and kept in a ring buffer for the admin YouTube dashboard.

const TUBERR_DIR = path.join(__dirname, '..', '..', 'tuberr');
const LOG_RING_SIZE = 500;

let child = null;
let wantRunning = false;
let restartTimer = null;
let restartDelayMs = 5000;
let startedAt = null;
let restarts = 0;
let lastExit = null;
const logRing = [];

function isManageable() {
  if (process.env.TUBERR_URL || process.env.TUBERR_MANAGED === '0') return false;
  return fs.existsSync(path.join(TUBERR_DIR, 'server.js'));
}

// Where the bundled Tuberr keeps its DB/cookies/key — used by the backup job
function dataDir() {
  return process.env.TUBERR_DATA_DIR || path.join(TUBERR_DIR, 'data');
}

function pushLog(level, msg) {
  logRing.push({ ts: Date.now(), level, msg });
  if (logRing.length > LOG_RING_SIZE) logRing.splice(0, logRing.length - LOG_RING_SIZE);
}

function attachStream(stream, isStderr) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const level = isStderr || /\b(error|failed|fatal)\b/i.test(line) ? 'error'
        : /\bwarn/i.test(line) ? 'warn' : 'info';
      pushLog(level, line);
      (isStderr ? process.stderr : process.stdout).write(line + '\n');
    }
  });
  stream.on('end', () => { if (buf.trim()) pushLog(isStderr ? 'error' : 'info', buf); });
}

function start() {
  if (child || restartTimer) return;
  child = spawn(process.execPath, ['server.js'], {
    cwd: TUBERR_DIR,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  startedAt = Date.now();
  attachStream(child.stdout, false);
  attachStream(child.stderr, true);
  console.log(`[tuberr] started bundled instance (pid ${child.pid})`);
  pushLog('info', `[supervisor] started bundled instance (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    child = null;
    lastExit = { code, signal, at: Date.now() };
    if (!wantRunning) return;
    restarts++;
    const msg = `[supervisor] exited (${signal || `code ${code}`}) — restarting in ${restartDelayMs / 1000}s`;
    console.warn(`[tuberr] ${msg}`);
    pushLog('error', msg);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restartDelayMs = Math.min(restartDelayMs * 2, 60_000);
      if (wantRunning) start();
    }, restartDelayMs);
    restartTimer.unref();
  });
  // A clean minute of uptime resets the crash backoff
  setTimeout(() => { if (child) restartDelayMs = 5000; }, 60_000).unref();
}

function stop() {
  wantRunning = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) {
    console.log('[tuberr] stopping bundled instance');
    pushLog('info', '[supervisor] stopping bundled instance');
    child.kill('SIGTERM');
  }
}

// Reconciles the child process with the youtube_enabled setting. Called at
// boot and after every /admin/connections/save.
function sync() {
  if (!isManageable()) return;
  const enabled = db.getSetting('youtube_enabled', '0') === '1';
  if (enabled && !wantRunning) {
    wantRunning = true;
    start();
  } else if (!enabled && wantRunning) {
    stop();
  }
}

function getProcessInfo() {
  return {
    managed: isManageable(),
    running: !!child,
    pid: child ? child.pid : null,
    startedAt: child ? startedAt : null,
    restarts,
    lastExit,
    restartPending: !!restartTimer,
  };
}

function getLogs(limit = 200) {
  const n = Math.max(1, Math.min(Number(limit) || 200, LOG_RING_SIZE));
  return logRing.slice(-n);
}

module.exports = { sync, stop, getProcessInfo, getLogs, isManageable, dataDir };
