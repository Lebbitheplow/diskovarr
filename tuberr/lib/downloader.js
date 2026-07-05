const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const ytdlp = require('./ytdlp');

const MAX_CONCURRENT = 2;
const PROGRESS_PREFIX = 'PROG|';

// yt-dlp emits one parseable line per progress tick; values may be 'NA'
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`;

const FORMAT =
  'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';

const queue = [];
const active = new Set();

const stmtUpdateProgress = db.prepare(
  'UPDATE downloads SET progress = ?, size_bytes = ?, dlspeed = ?, eta = ?, state = ? WHERE info_hash = ?');
const stmtFinish = db.prepare(
  'UPDATE downloads SET state = ?, progress = ?, size_bytes = ?, dlspeed = 0, eta = 0, completed_on = ?, error = ? WHERE info_hash = ?');

function num(text) {
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function enqueue(infoHash) {
  if (queue.includes(infoHash) || active.has(infoHash)) return;
  queue.push(infoHash);
  pump();
}

function pump() {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const infoHash = queue.shift();
    const row = db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(infoHash);
    if (!row || row.state === 'completed') continue;
    active.add(infoHash);
    run(row).finally(() => {
      active.delete(infoHash);
      pump();
    });
  }
}

async function run(row) {
  const outDir = path.join(row.save_path, row.release_title);
  fs.mkdirSync(outDir, { recursive: true });
  const outTemplate = path.join(outDir, `${row.release_title}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${row.video_id}`;
  const args = [
    '-f', FORMAT,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-progress',
    '--newline',
    '--progress-template', PROGRESS_TEMPLATE,
    '-o', outTemplate,
    url,
  ];

  stmtUpdateProgress.run(0, row.size_bytes, 0, 0, 'downloading', row.info_hash);
  console.log(`[downloader] starting ${row.video_id} → ${outDir}`);

  const stderrTail = [];
  const exitCode = await new Promise((resolve) => {
    const proc = spawn(ytdlp.binaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith(PROGRESS_PREFIX)) continue;
        const [downloaded, total, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|').map(num);
        const size = total || row.size_bytes;
        const progress = size > 0 ? Math.min(downloaded / size, 0.99) : 0;
        stmtUpdateProgress.run(progress, size, speed, eta, 'downloading', row.info_hash);
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail.push(chunk.toString('utf8'));
      if (stderrTail.length > 20) stderrTail.shift();
    });
    proc.on('error', (err) => {
      stderrTail.push(err.message);
      resolve(-1);
    });
    proc.on('close', resolve);
  });

  if (exitCode === 0) {
    let finalSize = 0;
    try {
      for (const f of fs.readdirSync(outDir)) {
        finalSize += fs.statSync(path.join(outDir, f)).size;
      }
    } catch { /* size stays at estimate */ }
    stmtFinish.run('completed', 1, finalSize || row.size_bytes, Math.floor(Date.now() / 1000), null, row.info_hash);
    console.log(`[downloader] completed ${row.video_id} (${finalSize} bytes)`);
  } else {
    const error = stderrTail.join('').trim().slice(-1000) || `yt-dlp exited with code ${exitCode}`;
    stmtFinish.run('error', row.progress || 0, row.size_bytes, 0, error, row.info_hash);
    // Stop offering this video for its episode so Sonarr can move on after blocklisting
    db.prepare('UPDATE episode_matches SET broken = 1 WHERE video_id = ?').run(row.video_id);
    console.error(`[downloader] failed ${row.video_id}: ${error.split('\n').pop()}`);
  }
}

function resumePending() {
  const rows = db.prepare("SELECT info_hash FROM downloads WHERE state IN ('queued', 'downloading')").all();
  for (const r of rows) enqueue(r.info_hash);
  if (rows.length) console.log(`[downloader] resumed ${rows.length} pending download(s)`);
}

function ytdlpVersion() {
  return ytdlp.version();
}

module.exports = { enqueue, resumePending, ytdlpVersion };
