const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('../config');

// Self-managed yt-dlp. Distro packages go stale fast (YouTube starts 403ing
// them within months), so Tuberr downloads the official standalone binary into
// its own data dir on first boot and self-updates it daily — admins never
// install or update yt-dlp themselves. YTDLP_PATH env still overrides for
// anyone who wants to manage their own binary.

const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const ASSETS = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'win32-x64': 'yt-dlp.exe',
};

const binDir = path.join(config.dataDir, 'bin');
const managedPath = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// PyInstaller release binaries are glibc-only; on musl (Alpine — the Docker
// image) use the universal zipapp instead, which runs on the python3 the image
// ships. Bare-metal glibc hosts keep the fully standalone binary.
function assetName() {
  if (process.platform === 'linux' && fs.existsSync('/etc/alpine-release')) return 'yt-dlp';
  return ASSETS[`${process.platform}-${process.arch}`];
}

let lastUpdateCheck = 0;
let updateError = null;

function isOverridden() {
  return !!process.env.YTDLP_PATH;
}

// What the downloader should spawn right now. System yt-dlp is the last-ditch
// fallback while the managed download is still in flight on a cold start.
function binaryPath() {
  if (isOverridden()) return process.env.YTDLP_PATH;
  if (fs.existsSync(managedPath)) return managedPath;
  return 'yt-dlp';
}

function run(args) {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stderr.on('data', (c) => { err += c.toString('utf8'); });
    proc.on('error', (e) => resolve({ code: -1, out, err: err || e.message }));
    proc.on('close', (code) => resolve({ code, out, err }));
  });
}

async function version() {
  const { code, out } = await run(['--version']);
  return code === 0 ? out.trim() : null;
}

async function downloadBinary() {
  const asset = assetName();
  if (!asset) throw new Error(`no yt-dlp binary for ${process.platform}-${process.arch}`);
  console.log(`[ytdlp] downloading ${asset} …`);
  const res = await fetch(RELEASE_BASE + asset, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`yt-dlp download failed: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = managedPath + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o755 });
  fs.renameSync(tmp, managedPath);
  const v = await version();
  console.log(`[ytdlp] installed ${v || '(version unknown)'} at ${managedPath}`);
  return v;
}

// The standalone binary self-updates in place with -U (it lives in our data
// dir, so it's always writable).
async function selfUpdate() {
  lastUpdateCheck = Date.now();
  const { code, out, err } = await run(['-U']);
  if (code !== 0) {
    updateError = (err || out).trim().slice(-300);
    console.error(`[ytdlp] self-update failed: ${updateError.split('\n').pop()}`);
    return false;
  }
  updateError = null;
  const line = out.trim().split('\n').pop();
  if (line) console.log(`[ytdlp] ${line}`);
  return true;
}

async function ensureAndUpdate() {
  if (isOverridden()) return; // admin manages their own binary
  try {
    if (!fs.existsSync(managedPath)) {
      await downloadBinary();
      lastUpdateCheck = Date.now();
    } else {
      await selfUpdate();
    }
  } catch (e) {
    updateError = e.message;
    console.error(`[ytdlp] provisioning failed: ${e.message} — falling back to ${binaryPath()}`);
  }
}

function startAutoUpdate() {
  // fire-and-forget on boot, then daily; unref so the timer never holds the
  // process open
  ensureAndUpdate();
  setInterval(ensureAndUpdate, UPDATE_INTERVAL_MS).unref();
}

function status() {
  return {
    path: binaryPath(),
    managed: !isOverridden() && fs.existsSync(managedPath),
    overridden: isOverridden(),
    lastUpdateCheck: lastUpdateCheck || null,
    updateError,
  };
}

module.exports = { binaryPath, version, startAutoUpdate, ensureAndUpdate, status, managedPath };
