const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/database');

// Dynamic theme CSS — overrides all accent CSS variables with the current color
router.get('/theme.css', (req, res) => {
  const color = db.getThemeColor();
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  // Compute a slightly lighter hover color (~15% brighter)
  const rh = Math.min(255, Math.round(r + (255 - r) * 0.15));
  const gh = Math.min(255, Math.round(g + (255 - g) * 0.15));
  const bh = Math.min(255, Math.round(b + (255 - b) * 0.15));
  const hover = `#${rh.toString(16).padStart(2,'0')}${gh.toString(16).padStart(2,'0')}${bh.toString(16).padStart(2,'0')}`;

  const css = `:root {
  --accent: ${color};
  --accent-dim: rgba(${r}, ${g}, ${b}, 0.15);
  --accent-dim2: rgba(${r}, ${g}, ${b}, 0.20);
  --accent-glow: rgba(${r}, ${g}, ${b}, 0.08);
  --accent-border: rgba(${r}, ${g}, ${b}, 0.4);
  --accent-shadow: rgba(${r}, ${g}, ${b}, 0.4);
  --accent-hover: ${hover};
}\n`;
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(css);
});

// Login page
router.get('/login', (req, res) => {
  if (req.session && req.session.plexUser) {
    return res.redirect('/');
  }
  const error = req.query.error || null;
  res.render('login', { error });
});

// Home page — requires auth
router.get('/', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('home', { userId, username, thumb, currentPath: '/' });
});

// Discover page — requires auth
router.get('/discover', requireAuth, (req, res) => {
  const { id: userId, username, thumb } = req.session.plexUser;
  res.render('discover', { userId, username, thumb, currentPath: '/discover' });
});

module.exports = router;
