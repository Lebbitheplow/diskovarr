const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const config = require('../config');
const ytdlp = require('./ytdlp');
const nfo = require('./nfo');
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

const queue = [];
const active = new Set();

const stmtUpdateProgress = db.prepare(
  'UPDATE downloads SET progress = ?, size_bytes = ?, dlspeed = ?, eta = ?, state = ? WHERE info_hash = ?');
const stmtFinish = db.prepare(
  'UPDATE downloads SET state = ?, progress = ?, size_bytes = ?, dlspeed = 0, eta = 0, completed_on = ?, error = ? WHERE info_hash = ?');
const stmtNote = db.prepare("UPDATE downloads SET error = ?, state = 'downloading' WHERE info_hash = ?");

function num(text) {
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function enqueue(infoHash) {
  if (queue.includes(infoHash) || active.has(infoHash)) return;
  queue.push(infoHash);
  pump();
}

function pump() {
  while (active.size < maxConcurrent() && queue.length > 0) {
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

function spawnYtdlp(row, args) {
  const stderrTail = [];
  return new Promise((resolve) => {
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
      resolve({ exitCode: -1, stderr: stderrTail.join('') });
    });
    proc.on('close', (code) => resolve({ exitCode: code, stderr: stderrTail.join('') }));
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
      fs.writeFileSync(path.join(outDir, `${row.release_title}.nfo`), xml);
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

async function run(row) {
  const opts = getOptions();
  const outDir = path.join(row.save_path, row.release_title);
  fs.mkdirSync(outDir, { recursive: true });
  const outTemplate = path.join(outDir, `${row.release_title}.%(ext)s`);
  const tempCookies = tempCookiesFor(row);
  const args = buildArgs(row, outTemplate, opts, tempCookies);

  stmtUpdateProgress.run(0, row.size_bytes, 0, 0, 'downloading', row.info_hash);
  console.log(`[downloader] starting ${row.video_id} → ${outDir}`);

  let result;
  let attemptsMade = 0;
  for (;;) {
    result = await spawnYtdlp(row, args);
    attemptsMade++;
    if (result.exitCode === 0) break;
    if (BOT_CHECK_RE.test(result.stderr)) runtime.state.cookies.botCheckAt = Date.now();
    const retriesLeft = RETRY_DELAYS_MS.length - (attemptsMade - 1);
    if (retriesLeft <= 0 || !TRANSIENT_RE.test(result.stderr)) break;
    const delay = RETRY_DELAYS_MS[attemptsMade - 1];
    const lastLine = result.stderr.trim().split('\n').filter(Boolean).pop() || `exit ${result.exitCode}`;
    stmtNote.run(`retry ${attemptsMade}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s: ${lastLine.slice(-300)}`, row.info_hash);
    console.warn(`[downloader] transient failure for ${row.video_id} (attempt ${attemptsMade}), retrying in ${delay / 1000}s: ${lastLine}`);
    await sleep(delay);
    if (tempCookies) fs.copyFileSync(path.join(config.dataDir, 'cookies.txt'), tempCookies);
  }

  if (tempCookies) {
    try { fs.unlinkSync(tempCookies); } catch { /* already gone */ }
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

module.exports = { enqueue, resumePending, ytdlpVersion, buildArgs, TRANSIENT_RE, BOT_CHECK_RE };
