const path = require('path');
const fs = require('fs');

// The one place that decides where runtime data lives (databases, backups,
// share-card cache). Overridable for tests and non-Docker installs that keep
// data elsewhere; everything else should build paths through dataPath().
const dataDir = process.env.DISKOVARR_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function dataPath(...parts) {
  return path.join(dataDir, ...parts);
}

module.exports = { dataDir, dataPath };
