'use strict';

// Installs the DUMB Traktless container from Diskovarr when Docker is reachable
// from this process, or hands the admin a compose file to run themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_IMAGE = process.env.DUMB_IMAGE || 'ghcr.io/lebbitheplow/dumb-traktless:latest';
const DEFAULT_DIR = process.env.DUMB_INSTALL_DIR || path.join(os.homedir(), 'docker', 'DUMB');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 15000, cwd: opts.cwd, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') }));
  });
}

// Docker availability from *this* process's point of view (systemd unit or
// container). A Diskovarr container without the docker socket mounted reports
// available=false and the UI falls back to manual instructions.
async function dockerStatus() {
  if (process.env.DISKOVARR_DISABLE_DOCKER === '1') return { available: false, compose: false, reason: 'disabled by DISKOVARR_DISABLE_DOCKER' };
  const version = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (!version.ok) return { available: false, compose: false, reason: version.stderr.trim().split('\n')[0] || 'docker CLI not found' };
  const compose = await run('docker', ['compose', 'version', '--short']);
  return {
    available: true,
    compose: compose.ok,
    serverVersion: version.stdout.trim(),
    composeVersion: compose.ok ? compose.stdout.trim() : null,
    reason: compose.ok ? null : 'docker compose plugin not found',
  };
}

// Also reports where the container's /mnt/debrid lives on the host — that is
// the prefix a native Plex needs to see the symlink library.
async function containerStatus(name = 'DUMB') {
  const r = await run('docker', ['inspect', '--format', '{{.State.Status}}|{{.Config.Image}}|{{range .Mounts}}{{.Destination}}={{.Source}};{{end}}', name]);
  if (!r.ok) return { exists: false };
  const [state, image, mounts = ''] = r.stdout.trim().split('|');
  const debridMount = mounts.split(';').map(m => m.split('=')).find(([dest]) => dest === '/mnt/debrid');
  return { exists: true, state, image, debridHostPath: debridMount ? debridMount[1] : null };
}

function composeYaml({ image = DEFAULT_IMAGE, tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', puid = 1000, pgid = 1000 } = {}) {
  return `services:
  DUMB:
    container_name: DUMB
    image: ${image}
    stop_grace_period: 30s
    shm_size: 128mb
    stdin_open: true
    tty: true
    volumes:
      - ./config:/config
      - ./log:/log
      - ./data:/data
      - ./data/zurg:/zurg
      - ./data/riven:/riven
      - ./data/postgres:/postgres_data
      # Debrid mount + symlink library. Plex must see this at the SAME path
      # DUMB uses (/mnt/debrid) — see the Plex step of the setup wizard.
      - ./mnt/debrid:/mnt/debrid:shared
    environment:
      - TZ=${tz}
      - PUID=${puid}
      - PGID=${pgid}
    # Host networking keeps every DUMB service on localhost (API :8000, Riven
    # :8080, Sonarr :8989 …) so Diskovarr can reach them without port maps.
    network_mode: host
    devices:
      - /dev/fuse:/dev/fuse:rwm
    cap_add:
      - SYS_ADMIN
    security_opt:
      - apparmor:unconfined
    restart: unless-stopped
`;
}

function sanitizeDir(dir) {
  const resolved = path.resolve(String(dir || DEFAULT_DIR));
  if (resolved === '/' || resolved.includes('\0')) throw new Error('Invalid install directory');
  return resolved;
}

// Writes the compose file and brings the container up. Never overwrites an
// existing compose file unless asked, so a hand-tuned deployment survives.
async function install({ dir, image, overwrite = false } = {}) {
  const target = sanitizeDir(dir);
  const docker = await dockerStatus();
  if (!docker.available || !docker.compose) {
    return { ok: false, manual: true, reason: docker.reason, dir: target, compose: composeYaml({ image }) };
  }
  fs.mkdirSync(target, { recursive: true });
  for (const sub of ['config', 'log', 'data', 'mnt/debrid']) fs.mkdirSync(path.join(target, sub), { recursive: true });
  const composePath = path.join(target, 'docker-compose.yml');
  const existed = fs.existsSync(composePath);
  if (!existed || overwrite) fs.writeFileSync(composePath, composeYaml({ image }));
  const up = await run('docker', ['compose', 'up', '-d'], { cwd: target, timeout: 10 * 60 * 1000 });
  return {
    ok: up.ok, dir: target, composePath, wroteCompose: !existed || overwrite,
    output: (up.stdout + '\n' + up.stderr).trim().slice(-4000),
    hint: up.ok ? 'DUMB is starting; its API appears on http://127.0.0.1:8000 within a minute or two.' : 'docker compose up failed — see output',
  };
}

module.exports = { DEFAULT_IMAGE, DEFAULT_DIR, dockerStatus, containerStatus, composeYaml, install, sanitizeDir };
