const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('../db/database');

// Supervises the bundled Tuberr instance (../../tuberr) as a child process:
// started when the YouTube integration is enabled, stopped when disabled, and
// restarted with backoff if it crashes. Skipped when TUBERR_URL is set (the
// Docker image's entrypoint runs its own Tuberr) or TUBERR_MANAGED=0.

const TUBERR_DIR = path.join(__dirname, '..', '..', 'tuberr');

let child = null;
let wantRunning = false;
let restartTimer = null;
let restartDelayMs = 5000;

function isManageable() {
  if (process.env.TUBERR_URL || process.env.TUBERR_MANAGED === '0') return false;
  return fs.existsSync(path.join(TUBERR_DIR, 'server.js'));
}

function start() {
  if (child || restartTimer) return;
  child = spawn(process.execPath, ['server.js'], {
    cwd: TUBERR_DIR,
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  console.log(`[tuberr] started bundled instance (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    child = null;
    if (!wantRunning) return;
    console.warn(`[tuberr] exited (${signal || `code ${code}`}) — restarting in ${restartDelayMs / 1000}s`);
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

module.exports = { sync, stop };
