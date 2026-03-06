# Diskovarr — Design Document

## Overview

Diskovarr is a self-hosted web application that sits alongside Plex and Tautulli to deliver personalized content recommendations. Users sign in with their Plex account and see their library scored by personal taste — not global popularity. An optional Diskovarr Requests tab surfaces content not yet in the library (sourced from TMDB) with direct request integration to Overseerr, Radarr, and Sonarr. A secondary browse view lets users filter the full library by type, genre, decade, rating, and sort order.

The app is intentionally server-side heavy: all Plex API calls, token handling, scoring, and SQLite I/O happen on the Node.js server. The browser receives pre-scored data and renders it; it never holds a Plex token or API key.

---

## Architecture

```
Browser
  │  Sign in → Plex OAuth PIN flow
  │  GET /api/recommendations (JSON)
  │  GET /api/discover/recommendations (JSON)
  │  POST /api/watchlist/add | /remove
  │  POST /api/dismiss
  │  POST /api/request
  └──────────────────────────────────────────────
         Express (Node.js 20, port 3232)
           ├── routes/auth.js              Plex OAuth
           ├── routes/api.js               JSON API (recommendations, watchlist, dismiss, request)
           ├── routes/admin.js             Admin panel + update check
           ├── routes/pages.js             Page rendering + /theme.css
           ├── routes/discover.js          Diskovarr Requests page + recommendation API
           ├── services/plex.js            Plex HTTP client + library/watched cache
           ├── services/tautulli.js        Tautulli HTTP client (watch history)
           ├── services/recommender.js     In-library scoring engine
           ├── services/discoverRecommender.js  TMDB-based out-of-library scoring
           ├── services/tmdb.js            TMDB API wrapper + SQLite cache
           └── db/database.js             SQLite schema + all query helpers
                    │
              data/diskovarr.db    SQLite (library, watched, dismissals, settings, tmdb_cache)
              data/sessions.db     SQLite session store
```

---

## Authentication — Plex OAuth PIN Flow

Diskovarr uses Plex's PIN-based OAuth, which avoids storing user passwords and works with any Plex account (not just the server owner).

1. **Login page** — the browser directly POSTs to `https://plex.tv/api/v2/pins` to create a PIN (client-side, so Plex records the user's IP rather than the server's). The browser then redirects to `https://app.plex.tv/auth#?clientID=DISKOVARR&code={pinCode}&forwardUrl=...`.
2. `GET /auth/callback?pinId=X&pinCode=Y` — Plex redirects here after the user authenticates. The PIN ID and code are saved to the session; a polling page with a spinner is rendered.
3. `GET /auth/check-pin` — polled every 2 seconds by the browser. Server GETs `https://plex.tv/api/v2/pins/{pinId}`. When `authToken` appears, the server fetches user info and resources, verifies server membership, and stores `{ id, username, thumb, token, serverToken }` in the session.
4. `GET /auth/logout` — destroys the session and redirects to `/login`.

Sessions are stored in a SQLite file (`data/sessions.db`) via `connect-sqlite3`, with a 30-day cookie lifetime.

---

## Configuration — DB Overrides `.env`

All service credentials and connection settings can be stored in the `settings` SQLite table via the admin panel, allowing live changes without restarts. The resolution order for any setting is:

1. `db.getSetting(key)` — value stored via admin panel
2. `process.env.VARIABLE` — value from `.env` / Docker environment
3. Hardcoded default (section IDs: `'1'`, `'2'`)

This means `.env` / `docker-compose.yml` works as an initial bootstrap, and the admin panel can override anything afterwards.

---

## Library Sync

Fetching a full Plex library section takes 15–30 seconds over the local network. A two-level cache makes the app fast after first load.

### Two-level cache

**Level 1 — In-memory Map** (`libraryCache` in `plex.js`)
- Keyed by section ID, 2-hour TTL
- Populated on startup, refreshed by background interval

**Level 2 — SQLite** (`library_items` table)
- Persists across restarts
- Checked first; used if last sync was within 2 hours
- Warm restart loads from SQLite in milliseconds

### Sync flow

```
fetchSection(sectionId)
  └── L1 cache hit? → return immediately
  └── DB sync time < 2h AND rows exist? → load from DB → populate L1 → return
  └── Otherwise → syncLibrarySection() → Plex API → write DB → populate L1 → return
```

Background refresh runs on startup (after a 2-second delay) and every 2 hours. Manual sync available from the admin panel.

---

## Watched Status Sync

### Strategy

Plex's `unwatched=0` filter on the library section endpoint (with the user's personal token) fetches only watched items, which is much faster than fetching the full library. TV show–level watched state is inferred from `onDeck` grandparent keys and Tautulli episode history.

### Sync flow (per user)

```
getWatchedKeys(userId, userToken)
  └── No DB data yet? → syncUserWatched() — await (blocks once, ~3s)
  └── DB data > 30 min old? → syncUserWatched() — background, return current DB immediately
  └── DB data fresh? → return from DB immediately
```

Sources merged: Plex movies (unwatched=0), Plex TV (unwatched=0), onDeck (in-progress), Tautulli movie keys, Tautulli show keys.

---

## Scoring Engine (`services/recommender.js`)

### Preference profile

Built from Tautulli watch history (up to 1,000 movies, 2,000 episodes):

Each watched item accumulates weights into `genreWeights`, `directorWeights`, `actorWeights`, `studioWeights`, `decadeWeights`. Base weight 1.0, modified by:
- **Recency multiplier**: top 50 most recent → ×1.5
- **Completion bonus**: ≥ 95% completion → ×1.3

All maps normalised to 0–1 range.

### Item scoring

| Signal | Max points | Method |
|---|---|---|
| Genre overlap | 20 | Sum of `genreWeights` for matching genres (each genre capped at 7 pts) |
| Director match | 30 | Best matching director weight × factor |
| Actor overlap | 25 | Sum of top 3 cast member weights |
| Studio match | 15 | Best matching studio weight |
| Decade preference | 8 | `decadeWeights[Math.floor(year/10)*10]` |
| Star rating multipliers | ×0.4–×2.5 | User star ratings from Plex |
| Recency tiers | ×1.3–×1.8 | Recently added items score higher |

Reason tags (top 3 signals) attached per item: "Because you like Sci-Fi", "Directed by X", "Starring Y".

**Fallback (no watch history):** Items sorted by `audienceRating` descending with reason "Highly Rated".

### Output

- **Top Picks**: high-score blend across movies, TV, and anime (150 item pool)
- **Movies**: movie results (200 item pool)
- **TV Shows**: non-anime TV results (150 item pool)
- **Anime**: TV items where `genres` contains `"anime"` (100 item pool)

Each pool is cached per user for 30 minutes. Dismissing an item invalidates the cache.

---

## Diskovarr Requests (`services/discoverRecommender.js`)

Optional feature. Only visible when `discover_enabled = '1'` and a TMDB API key is configured.

### Candidate sources

For each of the user's top watched movies/shows (by Tautulli score):
- TMDB `/movie/{id}/recommendations` and `/tv/{id}/recommendations`

Genre-based discovery for the user's top genres (2 pages each, `popularity.desc`, min rating 6.5 / 50 votes).

Trending movies and TV (weekly TMDB trending endpoint).

All results deduplicated by TMDB ID and filtered to exclude:
- Items already in the Plex library (TMDB ID match, with title+year fallback)
- Items with a future `release_date` (unreleased content)

### Scoring

Same signals and weights as in-library scoring. Reason tags generated per item.

### Pools (per user, 6-hour cache)

| Pool | Size |
|---|---|
| Top Picks | 150 |
| Movies | 200 |
| TV Shows | 150 |
| Anime | 100 |

### Request flow

User clicks Request → modal shows confirm dialog → `POST /api/request { tmdbId, mediaType, service }` → server routes to Overseerr / Radarr / Sonarr → toast notification → card badge updates to "Already Requested".

Routing preference: Overseerr (if enabled, handles both movies and TV); else Radarr for movies, Sonarr for TV.

---

## Admin Panel (`/admin`)

Password-protected (timing-safe comparison). Password set via `ADMIN_PASSWORD` in `.env`.

Displays version strip below hero: current version badge + update-available link (GitHub releases API, 6-hour cache).

### Settings tab

**Library Sync** — item counts, last sync time, Sync Now button, auto-sync toggle.

**User Watch Sync** — per-user table (avatar, username, hover-to-reveal ID, watched count, last sync); re-sync, clear watched, clear dismissals per user; bulk clear actions.

**Recommendation Cache** — clear in-memory rec cache for all users.

**Server Owner & Watchlist Mode** — set owner account; toggle between Watchlist mode (plex.tv native) and Playlist mode (private server playlist). Only owner is affected; Friends always use Watchlist mode.

**Theme Color** — 8 presets + color wheel; `POST /admin/theme/color`; updates live without page reload.

### Connections tab

All values stored in the `settings` SQLite table. Saved via `POST /admin/connections/save`.

**Plex** — URL + token (eye toggle). Saved via the Save button.

**Tautulli** — URL + API key (eye toggle). Test + Save buttons.

**TMDB** — API key only. Save Key + Test buttons. No toggle (prerequisite for Requests).

**Diskovarr Requests** — slide toggle; locked until TMDB key is saved.

**Overseerr / Radarr / Sonarr** — URL + masked API key (eye toggle) + slide toggle in block header; toggle locked until URL and key are filled; auto-saves on toggle change. Test button available.

API keys are never sent in page HTML. The eye button calls `GET /admin/connections/reveal` (admin-session-required) which returns actual stored values. Result cached in-page for the session.

---

## Theming

All accent colors are CSS custom properties. A dynamic `/theme.css` endpoint generates overrides for 7 accent variables from the color stored in `settings`. Every page loads `/theme.css` after `style.css`; the endpoint sets `Cache-Control: no-cache, no-store`.

---

## Security

- **Plex tokens never reach the browser** — all Plex API calls proxied through the server; poster proxy validates path starts with `/library/`
- **API keys never in page HTML** — masked as `••••••••`; revealed only via authenticated `/admin/connections/reveal`
- **Session cookies** are `httpOnly`, 30-day lifetime, stored server-side in SQLite
- **ratingKey inputs** validated against `/^\d+$/` before use in API calls
- **Admin password** compared with `crypto.timingSafeEqual`
- **No secrets committed** — `.env`, `data/`, `*.log` gitignored; `.dockerignore` excludes them from Docker builds

---

## Data Model (SQLite)

### `library_items`
| Column | Type | Notes |
|---|---|---|
| `rating_key` | TEXT PK | Plex ratingKey |
| `section_id` | TEXT | |
| `title` | TEXT | |
| `year` | INTEGER | |
| `thumb` | TEXT | Path for poster proxy |
| `type` | TEXT | `movie` or `show` |
| `genres` | TEXT | JSON array |
| `directors` | TEXT | JSON array |
| `cast` | TEXT | JSON array (top 10) |
| `audience_rating` | REAL | |
| `content_rating` | TEXT | |
| `added_at` | INTEGER | Unix timestamp |
| `summary` | TEXT | |
| `tmdb_id` | TEXT | Populated from Plex Guid during sync |
| `synced_at` | INTEGER | |

### `user_watched`
| Column | Type | Notes |
|---|---|---|
| `user_id` | TEXT | Plex user ID |
| `rating_key` | TEXT | |
| `synced_at` | INTEGER | |
| PK | (user_id, rating_key) | |

### `dismissals`
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `plex_user_id` | TEXT | |
| `rating_key` | TEXT | |
| `dismissed_at` | DATETIME | |
| UNIQUE | (plex_user_id, rating_key) | |

### `tmdb_cache`
| Column | Type | Notes |
|---|---|---|
| `tmdb_id` | INTEGER | |
| `media_type` | TEXT | `movie` or `tv` |
| `title` | TEXT | |
| `overview` | TEXT | |
| `poster_path` | TEXT | |
| `backdrop_path` | TEXT | |
| `genres` | TEXT | JSON array |
| `cast` | TEXT | JSON array |
| `directors` | TEXT | JSON array |
| `studios` | TEXT | JSON array |
| `vote_average` | REAL | |
| `vote_count` | INTEGER | |
| `release_year` | INTEGER | |
| `release_date` | TEXT | ISO date string |
| `fetched_at` | INTEGER | Unix timestamp |
| PK | (tmdb_id, media_type) | |

### `discover_requests`
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `user_id` | TEXT | |
| `tmdb_id` | INTEGER | |
| `media_type` | TEXT | |
| `requested_at` | INTEGER | |

### `settings`
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | |
| `value` | TEXT | |

**Settings keys used:**

| Key | Purpose |
|---|---|
| `theme_color` | Hex color for accent theming |
| `admin_watchlist_mode` | `watchlist` or `playlist` |
| `owner_plex_user_id` | Server owner user ID |
| `plex_url` | Overrides `PLEX_URL` env var |
| `plex_token` | Overrides `PLEX_TOKEN` env var |
| `tautulli_url` | Overrides `TAUTULLI_URL` env var |
| `tautulli_api_key` | Overrides `TAUTULLI_API_KEY` env var |
| `tmdb_api_key` | TMDB API key |
| `discover_enabled` | `'1'` / `'0'` |
| `overseerr_url` / `overseerr_api_key` / `overseerr_enabled` | Overseerr connection |
| `radarr_url` / `radarr_api_key` / `radarr_enabled` | Radarr connection |
| `sonarr_url` / `sonarr_api_key` / `sonarr_enabled` | Sonarr connection |

### `sync_log`
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `library_1`, `watched_12345` |
| `last_sync` | INTEGER | Unix timestamp |

---

## File Structure

```
diskovarr/
├── server.js                    Express app entry point; background sync interval
├── package.json
├── Dockerfile                   Multi-stage Docker build (node:20-alpine)
├── docker-compose.yml           Recommended deployment
├── .dockerignore
├── .env                         Secrets (gitignored)
├── .env.example                 Template with placeholder values
├── .gitignore
├── README.md
├── DESIGN.md                    This file
├── CHANGELOG.md
├── routes/
│   ├── auth.js                  Plex OAuth PIN flow
│   ├── api.js                   JSON API (recs, watchlist, dismiss, request, poster proxy)
│   ├── admin.js                 Admin panel routes + update check
│   ├── discover.js              Diskovarr Requests page + /api/discover/* endpoints
│   └── pages.js                 Page rendering; /theme.css dynamic endpoint
├── services/
│   ├── plex.js                  Plex API client; library + watched cache; getter-based config
│   ├── tautulli.js              Tautulli API client; getter-based config
│   ├── recommender.js           In-library preference profile builder + scoring engine
│   ├── discoverRecommender.js   TMDB-based out-of-library scoring + candidate fetching
│   └── tmdb.js                  TMDB API wrapper; SQLite metadata cache (7-day TTL)
├── db/
│   └── database.js              SQLite schema, migrations, all query helpers
├── middleware/
│   └── requireAuth.js           Session check; 401 for API, redirect for pages
├── views/
│   ├── login.ejs
│   ├── home.ejs                 Main recommendations page
│   ├── explore.ejs              Diskovarr Requests page
│   ├── discover.ejs             Diskovarr View (library browser/filter)
│   ├── poll.ejs                 OAuth polling spinner
│   ├── admin/
│   │   ├── index.ejs            Admin panel (Settings + Connections tabs)
│   │   └── login.ejs
│   └── partials/
│       └── nav.ejs              Sticky nav with tab links, FAB, and user info
├── public/
│   ├── css/
│   │   ├── style.css            Full dark theme with CSS variables
│   │   ├── admin.css            Admin panel styles (tabs, connection blocks, toggles)
│   │   └── discover.css         Filter bar and Diskovarr View styles
│   └── js/
│       ├── app.js               Home recommendations fetch + card renderer
│       ├── watchlist.js         Watchlist toggle + toast notification
│       ├── discover-app.js      Diskovarr Requests carousel + modal + request flow
│       ├── discover.js          Diskovarr View filter state + fetch + render
│       └── auth-poll.js         PIN polling; redirects on authorization
└── data/                        Runtime data (gitignored; mounted as Docker volume)
    ├── diskovarr.db
    └── sessions.db
```
