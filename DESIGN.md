# Diskovarr — Design Document

## Overview

Diskovarr is a self-hosted web application that sits alongside Plex and Tautulli to deliver personalized content recommendations. Users sign in with their Plex account and see their library scored by personal taste — not global popularity. A secondary browse view lets users filter the full library by type, genre, decade, rating, and sort order.

The app is intentionally server-side heavy: all Plex API calls, token handling, scoring, and SQLite I/O happen on the Node.js server. The browser receives pre-scored data and renders it; it never holds a Plex token.

---

## Architecture

```
Browser
  │  Sign in → Plex OAuth PIN flow
  │  GET /api/recommendations (JSON)
  │  GET /api/discover (JSON, with filters)
  │  POST /api/watchlist/add | /remove
  │  POST /api/dismiss
  └──────────────────────────────────────────────
         Express (Node.js 20, port 3232)
           ├── routes/auth.js       Plex OAuth
           ├── routes/api.js        JSON API
           ├── routes/admin.js      Admin panel
           ├── routes/pages.js      Page rendering + /theme.css
           ├── services/plex.js     Plex HTTP client + cache
           ├── services/tautulli.js Tautulli HTTP client
           ├── services/recommender.js  Scoring engine
           └── db/database.js       SQLite schema + helpers
                    │
              data/diskovarr.db     SQLite (library, watched, dismissals, settings)
              data/sessions.db      SQLite session store
```

---

## Authentication — Plex OAuth PIN Flow

Diskovarr uses Plex's PIN-based OAuth, which avoids storing user passwords and works with any Plex account (not just the server owner).

1. `GET /auth/plex` — server POSTs to `https://plex.tv/api/v2/pins` and receives a PIN code and ID. The PIN ID is stored in the session. The user is redirected to `https://app.plex.tv/auth#?clientID=DISKOVARR&code={pinCode}`.
2. `GET /auth/callback` — renders a polling page with a spinner.
3. `GET /auth/check-pin` — polled every 2 seconds by the browser. Server GETs `https://plex.tv/api/v2/pins/{pinId}`. When `authToken` appears, the server fetches user info and resources from plex.tv to verify the user has access to the configured server, then stores `{ id, username, thumb, token }` in the session.
4. `GET /auth/logout` — destroys the session and redirects to `/login`.

Sessions are stored in a SQLite file (`data/sessions.db`) via `connect-sqlite3`, with a 30-day cookie lifetime.

---

## Library Sync

Fetching a full Plex library section (2,700+ movies, 1,000 shows) takes 15–30 seconds over the local network. Doing this on every request is not viable.

### Two-level cache

**Level 1 — In-memory Map** (`libraryCache` in `plex.js`)
- Keyed by section ID
- 2-hour TTL
- Populated on startup, refreshed by the background interval

**Level 2 — SQLite** (`library_items` table)
- Persists across server restarts
- Checked first; used if the last sync was within 2 hours
- On a warm restart, the server loads from SQLite in milliseconds

### Sync flow

```
fetchSection(sectionId)
  └── L1 cache hit? → return immediately
  └── DB sync time < 2h AND rows exist? → load from DB → populate L1 → return
  └── Otherwise → syncLibrarySection() → Plex API → write DB → populate L1 → return
```

### Background refresh

On startup (after a 2-second delay), and every 2 hours thereafter, the server calls `warmCache()` which runs both sections in parallel. If auto-sync is disabled from the admin panel, this is a no-op. The interval is set in `server.js`.

Manual sync can be triggered from the admin panel (`POST /admin/sync/library`).

---

## Watched Status Sync

Filtering out watched content must always reflect Plex's current state, but fetching a user's full watch history on every request would be slow.

### Strategy

Diskovarr uses Plex's **`unwatched=0`** filter on the library section endpoint (with the user's personal token) to fetch only watched items. This is much faster than fetching the full library. TV show–level watched state is inferred from any watched episode (`onDeck` grandparent keys).

### Sync flow (per user)

```
getWatchedKeys(userId, userToken)
  └── No DB data yet (first request for this user)?
      → syncUserWatched() — await (blocks once, typically ~3s)
  └── DB data exists but > 30 min old?
      → syncUserWatched() — fire and forget (background)
      → return current DB data immediately
  └── DB data fresh?
      → return from DB immediately
```

`syncUserWatched` fetches movies (`unwatched=0`), TV shows (`unwatched=0`), and onDeck episodes in parallel, merges the ratingKey sets, and writes to `user_watched` via a transaction.

### Why not Tautulli for watched filtering?

Tautulli stores historical ratingKeys that can become stale if Plex rescans a library or content moves between libraries. Plex's own endpoints always return current keys. Tautulli is used exclusively for preference profile building (completion %, recency) where staleness doesn't break filtering.

---

## Scoring Engine (`services/recommender.js`)

### Preference profile

Built from the user's Tautulli watch history (up to 1,000 movies, 2,000 episodes):

1. Each watched item is looked up in the library map to get its metadata.
2. Weights are accumulated into four maps: `genreWeights`, `directorWeights`, `actorWeights`, `decadeWeights`.
3. Each watch contributes a base weight of 1.0, modified by:
   - **Recency multiplier**: top 50 most recent watches → ×1.5
   - **Completion bonus**: watch percentage ≥ 95% → ×1.3
4. All maps are normalised to a 0–1 range.

### Item scoring

For each unwatched, non-dismissed item in the library:

| Signal | Max points | Method |
|---|---|---|
| Genre overlap | 40 | Sum of `genreWeights` for matching genres |
| Director match | 25 | Best matching director × 1.5 |
| Actor overlap | 20 | Sum of top 3 cast member weights |
| Decade preference | 10 | `decadeWeights[Math.floor(year/10)*10]` |
| Audience rating ≥ 8.0 | +5 | Flat bonus |
| Added within 7 days | +3 | Flat bonus |

Top 3 contributing signals are attached as human-readable `reasons[]` strings ("Because you like Sci-Fi", "Directed by X", "Starring Y") and rendered as chips on each card.

**Fallback (no watch history):** Items sorted by `audienceRating` descending with reason "Highly Rated".

### Output sections

- **Top Picks**: top 5 movies + top 4 TV + top 3 anime, re-sorted by score, limit 12
- **Movies**: top 30 movie results
- **TV Shows**: top 30 non-anime TV results
- **Anime**: top 30 anime results (TV items where `genres` contains `"anime"`)

Results are cached per user for 30 minutes in an in-memory Map. Dismissing an item invalidates the cache for that user.

---

## Diskovarr View (`/discover`)

A filterable, paginated browse of the entire library.

### Filters (all combinable)

| Filter | Values |
|---|---|
| Type | All, Movies, TV Shows, Anime |
| Decade | Any, 1970s–2020s |
| Min Rating | 0 (Any) through 10, stepped at common breakpoints |
| Genres | Multi-select chips, loaded from library |
| Sort | Highest Rated, Recently Added, Newest First, Oldest First, A–Z |
| Include watched | Checkbox (default: off) |

Filtering and sorting are applied server-side on the cached library data. Results are paginated at 40 items per page. Genre chips are loaded from `GET /api/discover/genres` on page load.

---

## Watchlist (Plex Playlist)

The watchlist is stored as a Plex playlist named **"Diskovarr"** on the user's account.

- **Add**: `POST /api/watchlist/add { ratingKey }` — creates the playlist if it doesn't exist, otherwise appends to it via `PUT /playlists/{id}/items`
- **Remove**: `POST /api/watchlist/remove { playlistId, playlistItemId }` — `DELETE /playlists/{id}/items/{itemId}`
- **Read**: `GET /api/watchlist` — fetches all playlists, finds "Diskovarr", returns item list

The playlist uses the user's personal Plex token, so it appears only on their account. It is completely separate from the Plex "Watchlist" feature (which can trigger download automation in setups using `pd_zurg` or similar).

A toast notification slides up from the bottom of the screen when an item is added.

---

## Dismiss System

Each user can dismiss items they don't want to see. Dismissals are stored in the `dismissals` table with a `UNIQUE(plex_user_id, rating_key)` constraint.

- Dismissed items are excluded from both recommendations and the Diskovarr View (unless the user explicitly searches for them — there is no un-dismiss UI currently, but the API supports `DELETE /api/dismiss`).
- Dismissing a card triggers a CSS `card-dismissing` transition (scale + opacity) before the element is removed from the DOM.
- The recommendation cache for the user is invalidated on dismiss.

---

## Admin Panel (`/admin`)

Password-protected (compared with `crypto.timingSafeEqual` to prevent timing attacks). Password set via `ADMIN_PASSWORD` in `.env`.

### Sections

**Library Sync**
- Item counts per section with last sync timestamp
- "Sync Now" button — triggers `syncLibrarySection` for both sections, invalidates L1 cache
- Auto-sync toggle — persisted in SQLite (`sync_log` table, key `autosync_enabled`); checked before each background interval run

**User Watch Sync**
- Table of all users with watched item count and last sync time
- Per-user: "Re-sync" (clears DB watched data, triggers fresh sync), "Clear" (removes watched data entirely)
- "Clear All" — removes all user watched data

**Recommendation Cache**
- "Clear All Caches" — wipes in-memory recommendation cache for all users
- Per-user cache clear

**Theme Color**
- 8 preset swatches (gold, red, blue, green, purple, pink, teal, orange)
- Color wheel `<input type="color">` for any custom color
- `POST /admin/theme/color { color: '#rrggbb' }` — writes to `settings` table; response includes the new CSS so the page updates without a refresh

---

## Theming

All accent colors are CSS custom properties defined in `:root` in `style.css`. A dynamic `/theme.css` endpoint generates overrides for all 7 accent variables based on the color stored in the `settings` table:

```css
--accent            /* Primary color */
--accent-dim        /* rgba at 15% opacity — chip backgrounds, active states */
--accent-dim2       /* rgba at 20% opacity — watchlist button background */
--accent-glow       /* rgba at 8% opacity — subtle glows, tab hover */
--accent-border     /* rgba at 40% opacity — borders on accented elements */
--accent-shadow     /* rgba at 40% opacity — box shadows */
--accent-hover      /* ~15% lighter than accent — hover states on buttons */
```

Every page loads `/theme.css` after `style.css`, so the override is always current. The endpoint sets `Cache-Control: no-cache, no-store`.

---

## Security Considerations

- **Plex tokens never reach the browser** — all Plex API calls are proxied through the server. The poster proxy validates that the path starts with `/library/` to prevent SSRF.
- **Session cookies** are `httpOnly` (Express default), 30-day lifetime, stored server-side in SQLite.
- **ratingKey inputs** are validated against `/^\d+$/` before use in API calls.
- **Admin password** is compared with `crypto.timingSafeEqual` to prevent timing-based enumeration.
- **No personal data committed** — `.env`, `data/`, and `*.log` are all gitignored.

---

## Data Model (SQLite)

### `library_items`
| Column | Type | Notes |
|---|---|---|
| `rating_key` | TEXT PK | Plex ratingKey |
| `section_id` | TEXT | Movies or TV section ID |
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
| `synced_at` | INTEGER | When this row was last written |

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
| `id` | INTEGER PK AUTOINCREMENT | |
| `plex_user_id` | TEXT | |
| `rating_key` | TEXT | |
| `dismissed_at` | DATETIME | |
| UNIQUE | (plex_user_id, rating_key) | |

### `sync_log`
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `library_1`, `watched_12345`, `autosync_enabled` |
| `last_sync` | INTEGER | Unix timestamp or boolean-as-integer |

### `settings`
| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | e.g. `theme_color` |
| `value` | TEXT | |

---

## File Structure

```
diskovarr/
├── server.js                  Express app entry point; background sync interval
├── package.json
├── .env                       Secrets (gitignored)
├── .env.example               Template with placeholder values
├── .gitignore
├── README.md
├── DESIGN.md
├── routes/
│   ├── auth.js                Plex OAuth PIN flow
│   ├── api.js                 JSON API endpoints
│   ├── admin.js               Admin panel routes + shouldAutoSync()
│   └── pages.js               Page rendering; /theme.css dynamic endpoint
├── services/
│   ├── plex.js                Plex API client; library + watched cache
│   ├── tautulli.js            Tautulli API client (watch history for scoring)
│   └── recommender.js         Preference profile builder + scoring engine
├── db/
│   └── database.js            SQLite schema, migrations, all query helpers
├── middleware/
│   └── requireAuth.js         Session check; 401 for API, redirect for pages
├── views/
│   ├── login.ejs
│   ├── home.ejs               Main recommendations page
│   ├── discover.ejs           Diskovarr View browse/filter page
│   ├── poll.ejs               OAuth polling spinner
│   └── partials/
│       └── nav.ejs            Sticky nav with tab links and user info
├── public/
│   ├── css/
│   │   ├── style.css          Full dark theme with CSS variables
│   │   └── discover.css       Filter bar and discover page styles
│   └── js/
│       ├── app.js             Recommendations fetch + card renderer (shared)
│       ├── watchlist.js       Watchlist toggle + toast notification
│       ├── discover.js        Discover page filter state + fetch + render
│       └── auth-poll.js       PIN polling; redirects on authorization
└── data/                      Runtime data (gitignored)
    ├── diskovarr.db
    └── sessions.db
```
