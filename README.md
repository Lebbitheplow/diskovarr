# Diskovarr — React Edition

A full-stack React + Express rewrite of [Diskovarr](https://github.com/Lebbitheplow/diskovarr), a personalized Plex recommendation app. This repo includes both the React frontend and the Express backend.

## Prerequisites

- Node.js 18+
- A Plex Media Server with an admin token
- (Optional) Tautulli for watch history data

## Quick Start

```bash
# 1. Install backend dependencies
cd server
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and fill in your Plex credentials (see Environment Variables below)

# 3. Start the server
node server.js
```

The app runs on `http://localhost:3232` by default. The pre-built frontend is included in `dist/` — no separate build step required.

## Environment Variables

All variables are set in `server/.env`. Copy `server/.env.example` to get started.

### Required

| Variable | Description |
|---|---|
| `PLEX_TOKEN` | Plex admin token (Settings → Account → Plex Token) |
| `PLEX_URL` | Local URL of your Plex server, e.g. `http://192.168.1.x:32400` |
| `PLEX_SERVER_ID` | Plex machine identifier (Settings → Troubleshooting → Server ID) |
| `PLEX_SERVER_NAME` | Display name for your server |
| `SESSION_SECRET` | Long random string used to sign session cookies |
| `ADMIN_PASSWORD` | Password for the `/admin` panel |

### Optional

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3232` | Port to listen on |
| `TAUTULLI_URL` | — | Tautulli base URL |
| `TAUTULLI_API_KEY` | — | Tautulli API key |
| `PLEX_MOVIES_SECTION_ID` | — | Plex library section ID for movies |
| `PLEX_TV_SECTION_ID` | — | Plex library section ID for TV shows |
| `TMDB_API_KEY` | — | TMDB API key for metadata |
| `RIVEN_SETTINGS_PATH` | `/opt/riven/settings.json` | Path to Riven settings file |
| `APP_URL` | auto-detected | Public URL (used for Plex OAuth callback) |

## Development

To modify the React frontend:

```bash
# Install frontend dependencies
npm install

# Start Vite dev server (proxies API calls to the Express backend)
# Make sure the Express server is also running
npm run dev

# Build for production
npm run build
```

## Project Structure

```
dist/          # Pre-built React frontend (served by Express)
server/        # Express backend
  routes/      # API route handlers
  services/    # Plex, Tautulli, TMDB, notification integrations
  db/          # SQLite database layer
  views/       # EJS templates for the /admin panel
  public/      # Static assets for the admin panel
src/           # React source
  components/  # Shared UI components
  context/     # Auth, Toast, Theme providers
  pages/       # Route-level page components
  services/    # Axios API client
```
