# Diskovarr

Personalized Plex content recommendations powered by your watch history.

Sign in with your Plex account and Diskovarr surfaces what to watch next — scored by your genre, director, actor, and decade preferences — with a full browse/filter view, private watchlist, and an admin panel to manage syncing and theming.

![Dark Netflix-style UI with card grid and recommendation sections](.github/screenshot.png)

## Features

- **Plex OAuth sign-in** — users authenticate with their own Plex account via the official PIN flow
- **Personalized recommendations** — scored from Tautulli watch history across genre, director, cast, decade, and rating
- **Four sections** — Top Picks, Movies, TV Shows, Anime (auto-detected by genre tag)
- **Diskovarr View** — full library browser with filters for type, decade, genre, min rating, sort order, and watched status
- **Diskovarr playlist** — private Plex playlist ("Diskovarr") separate from the Plex watchlist, so adding items here does not trigger any download automation
- **Dismiss** — hide individual items permanently; stored in SQLite per user
- **Background library sync** — library is cached in SQLite and refreshed from Plex every 2 hours; no cold-start timeouts
- **Per-user watched sync** — watched status pulled from Plex using user tokens; blocks only on first request, then refreshes in the background
- **Admin panel** — password-protected page to trigger manual syncs, manage caches, and change the theme color
- **Theme color picker** — color wheel + presets; all accent colors update globally in real time
- **Toast notifications** — slide-up confirmation when items are added to or removed from the watchlist
- **Poster proxy** — all poster images are proxied through the server; Plex tokens are never exposed to the browser
- **Dark UI** — Netflix-style card grid with shimmer skeleton loading, hover overlays, and CSS variable theming

## Requirements

- Node.js >= 20
- Plex Media Server (local network access)
- Tautulli (for watch history used in preference scoring)

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

- **Library Sync** — view item counts and last sync time; trigger a manual full sync; enable or disable the 2-hour auto-sync
- **User Watch Sync** — see watched counts per user; re-sync or clear individual users' watched history
- **Recommendation Cache** — clear the in-memory recommendation cache for all users or a specific user
- **Theme Color** — pick from presets or use the color wheel; the change applies immediately across all pages

## How Recommendations Work

1. **Watch history** — fetches up to 1,000 movies and 2,000 episodes from Tautulli for the signed-in user
2. **Preference profile** — builds weighted maps of genres, directors, actors, and decades from watched items; recent watches (top 50) get a 1.5× multiplier; fully-watched items get a 1.3× completion bonus
3. **Scoring** — every unwatched, non-dismissed library item is scored:
   - Genre overlap: up to 40 pts
   - Director match: up to 25 pts
   - Actor overlap (top 3 matches): up to 20 pts
   - Decade preference: up to 10 pts
   - Audience rating ≥ 8.0: +5 pts
   - Added to Plex within the last 7 days: +3 pts
4. **Sections** — top results are split into Movies, TV Shows, and Anime; Top Picks is a cross-section blend of the highest scorers
5. **Watched filtering** — uses Plex's own `unwatched=0` endpoint with the user's token; always reflects current Plex state
6. **Anime detection** — TV items where the "Anime" genre tag is present are separated into their own section

## Development

```bash
npm run dev    # node --watch server.js (auto-restarts on file changes)
```

Logs go to stdout. In production (systemd), use `journalctl -u diskovarr -f`.

## License

MIT
