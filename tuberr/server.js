const express = require('express');
const path = require('path');
const config = require('./config');
const { getSetting } = require('./db');
const downloader = require('./lib/downloader');
const ytdlp = require('./lib/ytdlp');
const scheduler = require('./lib/scheduler');
const janitor = require('./lib/janitor');

const app = express();
// Express 5 defaults to the "simple" query parser; keep qs semantics.
app.set('query parser', 'extended');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// torrents/add uploads arrive as multipart; keep the raw body for lib/multipart
app.use(express.raw({ type: 'multipart/form-data', limit: '10mb' }));

app.get('/ping', (req, res) => res.json({ ok: true }));

app.use('/api/v2', require('./routes/qbit'));
app.use('/torznab', require('./routes/torznab'));
app.use('/manage', require('./routes/manage'));

app.listen(config.port, () => {
  console.log(`[tuberr] listening on :${config.port}`);
  console.log(`[tuberr] downloads dir: ${config.downloadsDir}`);
  // Never log the key itself: logs end up in journald/docker logs and
  // Diskovarr's log viewer. The last 4 characters are enough to tell keys apart.
  const apiKey = getSetting('api_key');
  console.log(`[tuberr] management api key: …${apiKey.slice(-4)} (full key in ${path.join(config.dataDir, 'api_key.txt')})`);
  ytdlp.startAutoUpdate();   // bootstrap + daily self-update of the bundled yt-dlp
  scheduler.start();         // periodic episode/video re-sync + auto-match
  janitor.start();           // purge staging copies Sonarr has already imported
  downloader.resumePending();
});

// yt-dlp runs in its own process group, so stop it explicitly on shutdown;
// otherwise it outlives Tuberr and races the re-run resumePending starts on
// the next boot.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    downloader.stopAll();
    process.exit(0);
  });
}
