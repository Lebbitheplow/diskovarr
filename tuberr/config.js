const path = require('path');
const fs = require('fs');

// Overridable for tests and non-Docker installs that keep data elsewhere
const dataDir = process.env.TUBERR_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const downloadsDir = process.env.TUBERR_DOWNLOADS_DIR || path.join(dataDir, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

module.exports = {
  port: Number(process.env.TUBERR_PORT) || 9832,
  dataDir,
  downloadsDir,
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
};
