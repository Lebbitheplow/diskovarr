require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const SQLiteStore = require('connect-sqlite3')(session);

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dataDir }),
  secret: process.env.SESSION_SECRET || 'diskovarr-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));
app.use('/', require('./routes/pages'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3232;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Diskovarr running on http://0.0.0.0:${PORT}`);

  const plexService = require('./services/plex');
  const REFRESH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

  async function refreshLibrarySync() {
    try {
      plexService.invalidateCache(); // clear in-memory L1 so DB re-read triggers fresh Plex sync
      await plexService.warmCache(); // re-syncs both sections to DB + in-memory
      console.log(`[${new Date().toISOString()}] Library synced`);
    } catch (err) {
      console.warn('Library sync failed:', err.message);
    }
  }

  // On startup: load from DB if fresh, otherwise sync from Plex
  setTimeout(refreshLibrarySync, 2000);

  // Background re-sync every 2 hours
  setInterval(refreshLibrarySync, REFRESH_INTERVAL);
});
