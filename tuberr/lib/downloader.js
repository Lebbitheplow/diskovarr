const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const config = require('../config');
const ytdlp = require('./ytdlp');
const nfo = require('./nfo');
const paths = require('./paths');
const { getOptions } = require('./options');
const runtime = require('./state');

// Parallel yt-dlp downloads. Each one also costs an ffmpeg merge at the end,
// and too many parallel connections invites YouTube throttling/bot checks —
// 6 is a safe sweet spot for a fast home connection. Tunable via the
// max_concurrent setting (maxConcurrent in /manage/config) or TUBERR_MAX_CONCURRENT env.
function maxConcurrent() {
  return Number(process.env.TUBERR_MAX_CONCURRENT) || getOptions().maxConcurrent || 6;
}
const PROGRESS_PREFIX = 'PROG|';

// yt-dlp emits one parseable line per progress tick; values may be 'NA'
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`;

const FORMAT =
  'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';

// Errors that usually clear on their own (rate limits, flaky CDN fragments)
// get two more tries with growing backoff; everything else fails immediately.
const TRANSIENT_RE = /HTTP Error (?:403|429|5\d\d)|throttl|timed out|Connection reset|Temporary failure|fragment/i;
const BOT_CHECK_RE = /Sign in to confirm you.re not a bot|cookies are no longer valid|Please sign in/i;
const RETRY_DELAYS_MS = [30 * 1000, 120 * 1000];

// Cancelling (torrents/delete) sends SIGTERM to the yt-dlp process group
// (yt-dlp + its ffmpeg merge), then SIGKILL if it is still alive after this.
const CANCEL_GRACE_MS = 5000;
// Upper bound on how long cancel() waits for the job to wind down
const CANCEL_WAIT_MS = 15000;

const queue = [];
// infoHash → { proc, cancelled, wake, done } for every download being worked on
const jobs = new Map();

const stmtUpdateProgress = db.prepare(
  'UPDATE downloads SET progress = ?, size_bytes = ?, dlspeed = ?, eta = ?, state = ? WHERE info_hash = ?');
const stmtFinish = db.prepare(
  'UPDATE downloads SET state = ?, progress = ?, size_bytes = ?, dlspeed = 0, eta = 0, completed_on = ?, error = ? WHERE info_hash = ?');
const stmtNote = db.prepare("UPDATE downloads SET error = ?, state = 'downloading' WHERE info_hash = ?");

function num(text) {
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

// Retry backoff that a cancel can cut short
function cancellableSleep(job, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    job.wake = () => { clearTimeout(timer); resolve(); };
  });
}

// yt-dlp runs as its own process group (spawned detached) so the ffmpeg
// merge it starts dies with it.
function killTree(proc, signal) {
  if (!proc || !proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

function enqueue(infoHash) {
  if (queue.includes(infoHash) || jobs.has(infoHash)) return;
  queue.push(infoHash);
  pump();
}

function pump() {
  while (jobs.size < maxConcurrent() && queue.length > 0) {
    const infoHash = queue.shift();
    let row;
    try {
      row = db.prepare('SELECT * FROM downloads WHERE info_hash = ?').get(infoHash);
    } catch (e) {
      console.error(`[downloader] could not load ${infoHash}: ${e.message}`);
      continue;
    }
    if (!row || row.state === 'completed') continue;
    const job = { proc: null, cancelled: false, wake: null, done: null };
    jobs.set(infoHash, job);
    // done never rejects: failures before/around yt-dlp mark the row as error
    job.done = run(row, job)
      .catch(err => { if (!job.cancelled) markError(row, err); })
      .finally(() => {
        jobs.delete(infoHash);
        try { pump(); } catch (e) { console.error(`[downloader] queue pump failed: ${e.message}`); }
      });
  }
}

// Stops a queued or running download and resolves once its job has wound
// down (or CANCEL_WAIT_MS passed). A cancelled job never touches its row or
// writes files again, even if yt-dlp exits successfully after the signal.
// Resolves true if a running job was cancelled.
async function cancel(infoHash) {
  const queued = queue.indexOf(infoHash);
  if (queued !== -1) queue.splice(queued, 1);
  const job = jobs.get(infoHash);
  if (!job) return false;
  job.cancelled = true;
  if (job.wake) job.wake();
  if (job.proc) {
    killTree(job.proc, 'SIGTERM');
    const proc = job.proc;
    setTimeout(() => { if (job.proc === proc) killTree(proc, 'SIGKILL'); }, CANCEL_GRACE_MS).unref();
  }
  let timer;
  await Promise.race([job.done, new Promise(resolve => { timer = setTimeout(resolve, CANCEL_WAIT_MS); })]);
  clearTimeout(timer);
  console.log(`[downloader] cancelled ${infoHash}`);
  return true;
}

// Process shutdown: stop every yt-dlp so none outlives Tuberr and races the
// re-run that resumePending starts on the next boot.
function stopAll() {
  queue.length = 0;
  for (const job of jobs.values()) {
    job.cancelled = true;
    if (job.wake) job.wake();
    killTree(job.proc, 'SIGTERM');
  }
}

// Durable failure for errors outside yt-dlp itself (mkdir, cookie copy, path
// containment): handled like a yt-dlp failure — match marked broken, row
// removed, failure surfaced in /manage/status. Leaving an 'error' row would
// strand the episode: Sonarr never fails a qBittorrent item by its state
// ('error' and 'missingFiles' are both only warnings), so it would sit in
// Sonarr's queue forever instead of returning to wanted.
function markError(row, err) {
  const message = String((err && err.message) || err || 'download failed').slice(0, 1000);
  try {
    failDownload(row, message, 0);
  } catch (e) {
    console.error(`[downloader] could not record failure for ${row.info_hash}: ${e.message}`);
  }
}

function buildArgs(row, outTemplate, opts, cookiesFile) {
  const url = `https://www.youtube.com/watch?v=${row.video_id}`;
  // NOTE: no --no-progress here — it suppresses --progress-template output
  // entirely, which silently kills live progress reporting.
  // --js-runtimes node: yt-dlp needs a JS runtime for YouTube format extraction
  // (some videos otherwise expose no downloadable formats); node is guaranteed
  // present since it runs Tuberr itself.
  const args = [
    '--js-runtimes', 'node',
    '-f', FORMAT,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--newline',
    '--progress-template', PROGRESS_TEMPLATE,
    '--write-info-json', // consumed for the .nfo, then deleted
    '-o', outTemplate,
  ];
  if (cookiesFile) args.unshift('--cookies', cookiesFile);
  if (opts.embedMetadata) args.push('--embed-metadata', '--embed-thumbnail');
  if (opts.embedSubs) args.push('--write-subs', '--sub-langs', 'en.*', '--embed-subs');
  if (opts.sponsorblock) args.push('--sponsorblock-remove', 'sponsor,selfpromo');
  args.push(url);
  return args;
}

function spawnYtdlp(row, args, job) {
  const stderrTail = [];
  return new Promise((resolve) => {
    // detached: own process group, so cancel() can signal yt-dlp + ffmpeg together
    const proc = spawn(ytdlp.binaryPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    job.proc = proc;
    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith(PROGRESS_PREFIX) || job.cancelled) continue;
        const [downloaded, total, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|').map(num);
        const size = total || row.size_bytes;
        const progress = size > 0 ? Math.min(downloaded / size, 0.99) : 0;
        try {
          stmtUpdateProgress.run(progress, size, speed, eta, 'downloading', row.info_hash);
        } catch { /* progress is best effort; a busy db must not crash the process */ }
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail.push(chunk.toString('utf8'));
      if (stderrTail.length > 20) stderrTail.shift();
    });
    const finish = (exitCode) => {
      if (job.proc === proc) job.proc = null;
      resolve({ exitCode, stderr: stderrTail.join('') });
    };
    proc.on('error', (err) => {
      stderrTail.push(err.message);
      finish(-1);
    });
    proc.on('close', (code) => finish(code));
  });
}

// Age-restricted videos need YouTube account cookies. Each run gets its own
// temp COPY of the jar: yt-dlp writes rotated cookies back to the file it is
// given, so parallel downloads sharing the master file would clobber each
// other and corrupt the session.
function tempCookiesFor(row) {
  const cookiesFile = path.join(config.dataDir, 'cookies.txt');
  if (!fs.existsSync(cookiesFile)) return null;
  const temp = path.join(config.dataDir, `.cookies-${row.info_hash.slice(0, 12)}.tmp`);
  fs.copyFileSync(cookiesFile, temp);
  return temp;
}

// Series/episode identity for the NFO: the grab row → mapping/episode_matches.
function episodeMetaFor(row) {
  const grab = db.prepare('SELECT mapping_id, season, episode FROM grabs WHERE info_hash = ?').get(row.info_hash);
  const meta = { videoId: row.video_id };
  if (grab && grab.mapping_id) {
    const m = db.prepare('SELECT title FROM series_mappings WHERE id = ?').get(grab.mapping_id);
    const ep = db.prepare('SELECT episode_title FROM episode_matches WHERE mapping_id = ? AND season = ? AND episode = ?')
      .get(grab.mapping_id, grab.season, grab.episode);
    Object.assign(meta, { showTitle: m ? m.title : '', season: grab.season, episode: grab.episode, title: ep ? ep.episode_title : '' });
  } else {
    const m = /\.S(\d{1,4})E(\d{1,3})\./i.exec(row.release_title || '');
    if (m) Object.assign(meta, { season: Number(m[1]), episode: Number(m[2]) });
  }
  return meta;
}

function writeNfoAndCleanup(row, outDir, opts) {
  const infoPath = path.join(outDir, `${row.release_title}.info.json`);
  if (!fs.existsSync(infoPath)) return;
  try {
    if (opts.writeNfo) {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      const xml = nfo.buildEpisodeNfo(nfo.fromInfoJson(info, episodeMetaFor(row)));
      // re-checked here: a symlink planted in the release dir must not redirect the write
      fs.writeFileSync(paths.assertInsideDownloads(path.join(outDir, `${row.release_title}.nfo`), 'nfo path'), xml);
    }
  } catch (e) {
    console.error(`[downloader] nfo for ${row.video_id} failed: ${e.message}`);
  } finally {
    try { fs.unlinkSync(infoPath); } catch { /* already gone */ }
  }
}

function failDownload(row, stderr, attemptsMade) {
  const error = stderr.trim().slice(-1000) || 'yt-dlp exited abnormally';
  const lastLine = error.split('\n').filter(Boolean).pop() || error;
  // Mark the match broken so torznab stops offering this video, then drop the
  // download row: a lingering errored item makes Sonarr treat the episode as
  // "already in queue" and it never retries. With the row gone, Sonarr sees
  // the download vanish, returns the episode to wanted, and a later re-match
  // (or cookies fix) grabs it cleanly — with a fresh infohash thanks to the
  // attempts counter, so Sonarr's blocklist does not get in the way.
  const grab = db.prepare('SELECT mapping_id, season, episode FROM grabs WHERE info_hash = ?').get(row.info_hash);
  let attempts = 0;
  if (grab && grab.mapping_id) {
    db.prepare('UPDATE episode_matches SET broken = 1, attempts = attempts + 1 WHERE mapping_id = ? AND season = ? AND episode = ?')
      .run(grab.mapping_id, grab.season, grab.episode);
    const r = db.prepare('SELECT attempts FROM episode_matches WHERE mapping_id = ? AND season = ? AND episode = ?')
      .get(grab.mapping_id, grab.season, grab.episode);
    attempts = r ? r.attempts : 0;
  } else {
    db.prepare('UPDATE episode_matches SET broken = 1, attempts = attempts + 1 WHERE video_id = ?').run(row.video_id);
    const r = db.prepare('SELECT MAX(attempts) AS attempts FROM episode_matches WHERE video_id = ?').get(row.video_id);
    attempts = r ? (r.attempts || 0) : 0;
  }
  db.prepare('DELETE FROM downloads WHERE info_hash = ?').run(row.info_hash);
  runtime.recordFailure({ videoId: row.video_id, releaseTitle: row.release_title, error: lastLine, attempts });
  console.error(`[downloader] failed ${row.video_id} after ${attemptsMade} attempt(s) (removed from queue): ${lastLine}`);
}

// Where a row downloads to: <save_path>/<release_title>. Re-validated at run
// time (rows can predate validation, or come back via resumePending).
function outDirFor(row) {
  if (!paths.isSafeSegment(row.release_title)) {
    throw new Error(`unsafe release name ${JSON.stringify(String(row.release_title).slice(0, 200))}`);
  }
  return paths.assertInsideDownloads(path.join(String(row.save_path || ''), row.release_title), 'download dir');
}

// Thrown errors (bad path, mkdir/cookie-copy failures) reject; pump() hands
// them to markError, which removes the row. A cancelled job returns without
// touching anything.
async function run(row, job) {
  const opts = getOptions();
  const outDir = outDirFor(row);
  fs.mkdirSync(outDir, { recursive: true });
  const outTemplate = path.join(outDir, `${row.release_title}.%(ext)s`);
  let tempCookies = null;
  let result;
  let attemptsMade = 0;
  try {
    tempCookies = tempCookiesFor(row);
    const args = buildArgs(row, outTemplate, opts, tempCookies);

    stmtUpdateProgress.run(0, row.size_bytes, 0, 0, 'downloading', row.info_hash);
    console.log(`[downloader] starting ${row.video_id} → ${outDir}`);

    for (;;) {
      if (job.cancelled) return;
      result = await spawnYtdlp(row, args, job);
      attemptsMade++;
      if (job.cancelled) return;
      if (result.exitCode === 0) break;
      if (BOT_CHECK_RE.test(result.stderr)) runtime.state.cookies.botCheckAt = Date.now();
      const retriesLeft = RETRY_DELAYS_MS.length - (attemptsMade - 1);
      if (retriesLeft <= 0 || !TRANSIENT_RE.test(result.stderr)) break;
      const delay = RETRY_DELAYS_MS[attemptsMade - 1];
      const lastLine = result.stderr.trim().split('\n').filter(Boolean).pop() || `exit ${result.exitCode}`;
      stmtNote.run(`retry ${attemptsMade}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s: ${lastLine.slice(-300)}`, row.info_hash);
      console.warn(`[downloader] transient failure for ${row.video_id} (attempt ${attemptsMade}), retrying in ${delay / 1000}s: ${lastLine}`);
      await cancellableSleep(job, delay);
      if (job.cancelled) return;
      if (tempCookies) fs.copyFileSync(path.join(config.dataDir, 'cookies.txt'), tempCookies);
    }
  } finally {
    if (tempCookies) {
      try { fs.unlinkSync(tempCookies); } catch { /* already gone */ }
    }
  }

  if (result.exitCode === 0) {
    writeNfoAndCleanup(row, outDir, opts);
    let finalSize = 0;
    try {
      for (const f of fs.readdirSync(outDir)) {
        finalSize += fs.statSync(path.join(outDir, f)).size;
      }
    } catch { /* size stays at estimate */ }
    stmtFinish.run('completed', 1, finalSize || row.size_bytes, Math.floor(Date.now() / 1000), null, row.info_hash);
    runtime.state.lastCompletedAt = Date.now();
    console.log(`[downloader] completed ${row.video_id} (${finalSize} bytes)`);
  } else {
    failDownload(row, result.stderr, attemptsMade);
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

function isActive(infoHash) {
  return jobs.has(infoHash);
}

module.exports = { enqueue, cancel, stopAll, isActive, resumePending, ytdlpVersion, buildArgs, TRANSIENT_RE, BOT_CHECK_RE };
