const fs = require('fs');
const path = require('path');

// Owner-only permissions for the files that hold credentials: the databases
// (raw Plex/Jellyfin tokens, connector keys, sessions), their WAL/SHM
// siblings, backups and .env. Best-effort throughout — a permission tweak must
// never stop the server from booting — and a no-op on Windows, where POSIX
// modes don't apply.

const isWindows = process.platform === 'win32';
const PRIVATE_UMASK = 0o077;
const DB_FILE = /^(diskovarr|sessions)\.db(-wal|-shm|-journal)?$/;

// The umask the process started with. Child processes and files other OS
// users must read (Tuberr's downloads that Sonarr imports, the DUMB install
// tree Plex reads) are created under it rather than the private one.
let sharedUmask = null;

function setUmask(mask) {
  try { return process.umask(mask); } catch { return null; } // unsupported in worker threads
}

// New files 0600 / directories 0700 from here on.
function usePrivateUmask() {
  if (isWindows) return;
  const prev = setUmask(PRIVATE_UMASK);
  if (sharedUmask === null && prev !== null) sharedUmask = prev;
}

// Runs fn (synchronously — e.g. a spawn or mkdir) under the boot-time umask.
function withSharedUmask(fn) {
  if (isWindows || sharedUmask === null) return fn();
  const prev = setUmask(sharedUmask);
  try { return fn(); } finally { if (prev !== null) setUmask(prev); }
}

// chmod p when it exists, belongs to this uid and isn't already `mode`.
// Symlinks are left alone (chmod would follow them). Returns true if changed.
function chmodIfOwned(p, mode) {
  if (isWindows) return false;
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o777) === mode) return false;
    fs.chmodSync(p, mode);
    return true;
  } catch {
    return false;
  }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/**
 * Switch to the private umask and tighten what an older install (or a
 * restored backup) left group/world-readable: the data dir and its og-cache/
 * backups dirs 0700; databases, backup files and `extraFiles` (.env) 0600.
 * Only touches known entries — never recurses into e.g. a Tuberr data dir
 * nested inside a Docker volume. Returns the paths it changed.
 */
function hardenDataDir(dataDir, extraFiles = []) {
  if (isWindows) return [];
  usePrivateUmask();
  const changed = [];
  const tighten = (p, mode) => { if (chmodIfOwned(p, mode)) changed.push(p); };

  tighten(dataDir, 0o700);
  for (const e of entries(dataDir)) {
    if (e.isFile() && DB_FILE.test(e.name)) tighten(path.join(dataDir, e.name), 0o600);
  }
  tighten(path.join(dataDir, 'og-cache'), 0o700);

  const backups = path.join(dataDir, 'backups');
  tighten(backups, 0o700);
  for (const e of entries(backups)) {
    const p = path.join(backups, e.name);
    if (e.isFile()) tighten(p, 0o600);
    else if (e.isDirectory()) {
      tighten(p, 0o700);
      for (const f of entries(p)) if (f.isFile()) tighten(path.join(p, f.name), 0o600);
    }
  }

  for (const f of new Set(extraFiles)) tighten(f, 0o600);
  if (changed.length) console.log(`[perms] restricted ${changed.length} data path(s) to owner-only access`);
  return changed;
}

module.exports = { hardenDataDir, usePrivateUmask, withSharedUmask, chmodIfOwned };
