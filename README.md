# Diskovarr

Personalized Plex content recommendations powered by your watch history.

Sign in with your Plex account and Diskovarr surfaces what to watch next — scored by your genre, director, actor, and decade preferences — with a full browse/filter view, private watchlist, and an admin panel to manage syncing and theming.

![Home screen showing Top Picks, Movies, TV Shows, and Anime carousels](docs/screenshots/home.png)

## Features

- **Plex OAuth sign-in** — users authenticate with their own Plex account via the official PIN flow; PIN is created browser-side so the server IP is never exposed in Plex's security warning
- **Personalized recommendations** — scored from Tautulli watch history across genre, director, cast, decade, and rating; fresh random sample drawn on every page load and shuffle
- **Four sections** — Top Picks, Movies, TV Shows, Anime (auto-detected by genre tag); each a 2-row carousel with pagination and a ↺ shuffle button
- **Diskovarr View** — full library browser with filters for type, decade, genre, min rating, sort order, and watched status
- **Detail modal** — click any card to open a full overlay with poster, Rotten Tomatoes scores, genres, summary, director and cast credits, and watchlist/dismiss actions

  ![Detail modal showing poster, Rotten Tomatoes scores, genres, summary, and cast](docs/screenshots/movie-info.png)

- **Watchlist sync** — items sync to the native Plex.tv Watchlist by default (visible in the Plex app under Discover → Watchlist); server owners can switch to **Playlist mode** in the admin panel for a private "Diskovarr" server playlist — useful when the Plex Watchlist triggers download automation (e.g. pd_zurg)
- **Dismiss** — hide individual items permanently per user; stored in SQLite
- **Background library sync** — cached in SQLite, refreshed from Plex every 2 hours; no cold-start delays
- **Per-user watched sync** — fetched via Plex admin token + accountID; catches fully-watched and in-progress content; syncs on first request then refreshes in the background every 30 minutes
- **Admin panel** — password-protected; manage library syncs, per-user caches, server owner account, watchlist/playlist mode, and theme color
- **Theme color picker** — color wheel + presets; accent color updates globally in real time
- **Poster proxy** — all poster images proxied through the server; Plex tokens never reach the browser
- **Dark UI** — Netflix-style card grid with shimmer skeleton loading, hover overlays, and CSS variable theming

## Requirements

- Node.js >= 20
- Plex Media Server (local network access)
- Tautulli (for watch history used in preference scoring)

> **Important:** Diskovarr is designed for a **single Plex server and its users**. Recommendations and watched-status filtering are built from Tautulli history and Plex library data specific to your server. Users who sign in must have an account on your Plex server — the app verifies server membership during OAuth and uses each user's personal Plex token to read their watched state. It will not work correctly for Plex users who are not members of the configured server.

## Dependencies

| Package | Purpose |
|---|---|
| `express` | Web framework and routing |
| `express-session` | Session middleware |
| `connect-sqlite3` | SQLite-backed session store |
| `better-sqlite3` | Synchronous SQLite for library/watched/settings data |
| `ejs` | Server-side HTML templating |
| `dotenv` | Environment variable loading |

All HTTP requests to Plex and Tautulli use Node.js 20's built-in `fetch` — no additional HTTP client needed.

## Setup

```bash
git clone https://github.com/Lebbitheplow/diskovarr
cd diskovarr
cp .env.example .env
# Edit .env with your values (see Configuration below)
npm install
npm start
```

Open `http://your-server:3232` and sign in with your Plex account. The library will sync from Plex on first startup (this takes 30–60 seconds depending on library size). Subsequent starts load from the local SQLite cache instantly.

### Running as a systemd service

```bash
sudo nano /etc/systemd/system/diskovarr.service
```

```ini
[Unit]
Description=Diskovarr - Plex Recommendation App
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/diskovarr
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now diskovarr
```

## Configuration

Copy `.env.example` to `.env` and fill in all values. The `.env` file is gitignored and never committed.

| Variable | Description |
|---|---|
| `PLEX_URL` | Local URL of your Plex server, e.g. `http://192.168.1.x:32400` |
| `PLEX_TOKEN` | Plex admin token — used for library fetching and poster proxy |
| `PLEX_SERVER_ID` | Plex machine identifier |
| `PLEX_SERVER_NAME` | Display name for your server (used in OAuth flow) |
| `PLEX_MOVIES_SECTION_ID` | Library section ID for movies (default: `1`) |
| `PLEX_TV_SECTION_ID` | Library section ID for TV shows and anime (default: `2`) |
| `TAUTULLI_URL` | URL of your Tautulli instance, e.g. `http://192.168.1.x:8181` |
| `TAUTULLI_API_KEY` | Tautulli API key (Settings → Web Interface) |
| `ADMIN_PASSWORD` | Password for the `/admin` panel |
| `SESSION_SECRET` | Random string used to sign session cookies — use a long random value |
| `PORT` | Port to listen on (default: `3232`) |

### Finding your Plex Machine ID

```
http://your-plex:32400/identity
```
The `machineIdentifier` field is your `PLEX_SERVER_ID`.

### Finding library section IDs

```
http://your-plex:32400/library/sections?X-Plex-Token=YOUR_TOKEN
```
Each `<Directory>` element has a `key` attribute — that is the section ID.

### Tautulli user IDs

The Plex OAuth user ID returned at sign-in is the same ID Tautulli uses. No translation or extra configuration is needed.

## Admin Panel

Visit `/admin` and enter the `ADMIN_PASSWORD` from your `.env`.

![Admin panel showing library sync stats and user watch history table](docs/screenshots/admin-panel.png)

- **Library Sync** — view item counts and last sync time; trigger a manual full sync; enable or disable the 2-hour auto-sync
- **User Watch Sync** — see watched counts per user; re-sync or clear individual users' watched history

![Admin panel showing per-user controls and recommendation cache section](docs/screenshots/user-clear-cache.png)

- **Recommendation Cache** — clear the in-memory recommendation cache for all users or a specific user
- **Server Owner & Watchlist Mode** — select which Plex account is the server owner; toggle between Watchlist mode (plex.tv native Watchlist, default) and Playlist mode (private server playlist) for that account only
- **Theme Color** — pick from presets or use the color wheel; the change applies immediately across all pages

![Admin panel showing theme color picker, server owner selector, and library stats](docs/screenshots/theme-server-owner.png)

## How Recommendations Work

1. **Watch history** — fetches up to 1,000 movies and 2,000 episodes from Tautulli for the signed-in user
2. **Preference profile** — builds weighted maps of genres, directors, actors, and decades from watched items; recent watches (top 50) get a 1.5× multiplier; fully-watched items get a 1.3× completion bonus
3. **Scoring** — every unwatched, non-dismissed library item is scored:
   - Genre overlap: up to 20 pts (each genre capped at 7 pts to prevent single-genre dominance)
   - Director match: up to 30 pts
   - Actor overlap (top 3 matches): up to 25 pts
   - Studio match: up to 15 pts
   - Decade preference: up to 8 pts
   - Star rating multipliers: items the user rated 5 stars score 2.5×; low-rated items are suppressed
   - Recency multipliers: most recently watched items contribute up to 1.8× weight to the profile
   - Reason tags: "Because you like Sci-Fi", "Directed by X", "Starring Y" shown on each card
4. **Top Picks diversity** — seeds from highest scorers then injects picks for top directors, actors, and studios to avoid genre-bubble recommendations
5. **Sections** — results split into Movies, TV Shows, and Anime; Top Picks is a cross-section blend
6. **Watched filtering** — uses Plex admin token with `accountID` parameter to reliably fetch watched state for any user regardless of token type; works for Plex Friends and managed users alike
6. **Anime detection** — TV items where the "Anime" genre tag is present are separated into their own section

## Development

```bash
npm run dev    # node --watch server.js (auto-restarts on file changes)
```

Logs go to stdout. In production (systemd), use `journalctl -u diskovarr -f`.

## License

MIT
