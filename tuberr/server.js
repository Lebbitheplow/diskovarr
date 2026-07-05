const express = require('express');
const config = require('./config');
const { getSetting } = require('./db');
const downloader = require('./lib/downloader');
const ytdlp = require('./lib/ytdlp');
const scheduler = require('./lib/scheduler');

const app = express();
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
  console.log(`[tuberr] management api key: ${getSetting('api_key')}`);
  ytdlp.startAutoUpdate();   // bootstrap + daily self-update of the bundled yt-dlp
  scheduler.start();         // periodic episode/video re-sync + auto-match
  downloader.resumePending();
});
