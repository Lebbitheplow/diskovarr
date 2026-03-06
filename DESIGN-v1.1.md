# Diskovarr v1.1.0 — Discover Feature Design

## Overview

Add an optional **Discover** tab to Diskovarr that recommends content **not in the Plex
library**, sourced from TMDB and scored by the same preference engine used for in-library
recommendations. Users can request content directly via Overseerr, Radarr, or Sonarr.

The feature is entirely opt-in — a server admin must enable it in the admin panel and
configure at least a TMDB API key before the tab appears for any user.

---

## Version

**v1.1.0** — new feature, backwards compatible with v1.0.0

---

## External Data Source — TMDB

TMDB (The Movie Database) is the external catalog source.

**API key**: free at developers.themoviedb.org, stored in DB (admin connections panel),
never committed to .env.

**Endpoints used:**

| Endpoint | Purpose |
|---|---|
| `/movie/{id}/recommendations` | Similar movies to each top-watched movie |
| `/tv/{id}/recommendations` | Similar shows to each top-watched show |
| `/discover/movie?with_genres=X&sort_by=vote_average.desc` | Genre-based movie discovery |
| `/discover/tv?with_genres=X` | Genre-based TV discovery |
| `/discover/movie?with_keywords=210024&with_origin_country=JP` | Anime (animation + Japan origin) |

**Plex → TMDB ID bridge**: Plex stores `guid` on each library item. Format is typically
`plex://movie/5d776...` but Plex also exposes TMDB IDs via `/library/metadata/{id}/matches`
or the `Guid` child elements on item detail. Parse `tmdb://XXXXX` from those to build the
bridge between the user's watch history and TMDB recommendations.

Fallback if TMDB ID unavailable for a given title: use title + year match via
`/search/movie` or `/search/tv`.

**Results filtering**: Any TMDB result whose ID matches an item already in the Plex library
is excluded. Library TMDB IDs are stored alongside library items in SQLite.

---

## Admin Panel — Connections Tab

New "Connections" tab added to the admin panel alongside existing tabs.

### Services configured here:

**TMDB**
- API key (text input)
- Test Connection button
- Enable Discover tab toggle (master switch — hides/shows the tab for all users)

**Overseerr**
- URL (text input, e.g. `http://192.168.1.27:5055`)
- API key (text input)
- Enable toggle
- Test Connection button

**Radarr**
- URL (text input)
- API key (text input)
- Enable toggle
- Test Connection button

**Sonarr**
- URL (text input)
- API key (text input)
- Enable toggle
- Test Connection button

All values stored in the `settings` SQLite table. Radarr/Sonarr/Overseerr are all optional —
requesting simply won't be available for a type if no service for it is configured.

The Discover tab only appears in the nav if:
1. `discover_enabled` is true in settings
2. A TMDB API key is configured

---

## New SQLite Settings Keys

```
tmdb_api_key
discover_enabled          -- '1' or '0', default '0'
overseerr_url
overseerr_api_key
overseerr_enabled         -- '1' or '0', default '0'
radarr_url
radarr_api_key
radarr_enabled            -- '1' or '0', default '0'
sonarr_url
sonarr_api_key
sonarr_enabled            -- '1' or '0', default '0'
```

---

## Discover Tab — UI

Route: `/discover`

Only accessible if discover is enabled. If a non-admin visits `/discover` while it's
disabled, redirect to `/` with no error.

### Layout

Same structure as home page:

**Header**: "Discover" title + subtitle "Content not in your library, picked for you"

**Sections** (same 2-row carousel format, pagination arrows, ↺ shuffle button per section):

1. **Top Picks** — highest-scored blend across movies, TV, and anime
2. **Movies** — movies only
3. **TV Shows** — TV only
4. **Anime** — animation with JP origin (TMDB keyword/country filter)

Cards look identical to home page cards **except**:
- No "Watchlist" button
- **"Request" button** in place of watchlist (on hover overlay and in detail modal)
- Small badge on card: "Not in Library"
- If item is already requested (checked against Overseerr if configured): badge changes
  to "Already Requested" and Request button is disabled/greyed

---

## Recommendation Algorithm — Discover

### Step 1 — Preference Profile

Reuse the existing preference profile built from Tautulli history + Plex library metadata.
No changes needed here.

### Step 2 — Fetch External Candidates

For each of the user's top 20 watched movies (by Tautulli score):
- Call `GET /movie/{tmdb_id}/recommendations` → up to 20 results each

For each of the user's top 20 watched TV shows:
- Call `GET /tv/{tmdb_id}/recommendations` → up to 20 results each

Also call genre-based discover endpoints for the user's top 3 genres (movie + TV separately).

Deduplicate all results by TMDB ID. Remove any already in Plex library.

### Step 3 — Enrich with Metadata

For each candidate not already cached:
- GET `/movie/{id}` or `/tv/{id}` — genres, cast, director, description, poster, rating
- Cache in SQLite with 7-day TTL

### Step 4 — Score

Same scoring system as in-library recommendations:
- Genre overlap with preference profile: up to 20 pts
- Director match: up to 30 pts
- Actor overlap (top 3): up to 25 pts
- Studio/network match: up to 15 pts
- Decade preference: up to 8 pts
- TMDB vote average multiplier (≥ 7.5: 1.2×, ≤ 5.0: 0.7×)
- Reason tags generated per item

### Step 5 — Tiered Pools + Sampling

Same tiered pool approach as home page:

| Pool | Cache Size | Sample per request |
|---|---|---|
| Top Picks | 150 | ~72 |
| Movies | 200 | ~60 |
| TV Shows | 150 | ~60 |
| Anime | 100 | ~60 |

Pools cached per user (6-hour TTL). Fresh sample drawn on every page load and shuffle.
Results vary — same goal as home page.

---

## Request Flow

### Trigger

User clicks "Request" button on a card (hover overlay or detail modal).

### Confirm Dialog

A modal dialog appears before any request is sent. Content varies by configuration:

**Overseerr enabled only** (any media type):
```
Request "[Title]"?
[ Cancel ]  [ Request ]
```
Routes to Overseerr regardless of movie/TV.

**Overseerr + Radarr enabled, item is a movie**:
```
Request "[Title]" via:
[ Cancel ]  [ Overseerr ]  [ Radarr ]
```

**Overseerr + Sonarr enabled, item is a TV show**:
```
Request "[Title]" via:
[ Cancel ]  [ Overseerr ]  [ Sonarr ]
```

**Radarr only, item is a movie** (no Overseerr):
```
Request "[Title]" via Radarr?
[ Cancel ]  [ Request ]
```

**Sonarr only, item is a TV show** (no Overseerr):
```
Request "[Title]" via Sonarr?
[ Cancel ]  [ Request ]
```

**Radarr + Sonarr, no Overseerr** (media type determines routing automatically):
```
Request "[Title]"?
[ Cancel ]  [ Request ]
```
(Auto-routes to Radarr for movies, Sonarr for TV — user doesn't need to choose)

**No service configured**: Request button not shown at all.

### After Confirm

- POST to `/api/request` with `{ tmdbId, mediaType, service }`
- Server routes to appropriate service API
- Success: toast notification "Requested: [Title]"
- Failure: toast "Request failed — check admin connections"
- Card badge updates to "Already Requested" in-place (no page reload)

---

## Request API Calls

**Overseerr** — `POST /api/v1/request`
```json
{
  "mediaType": "movie",
  "mediaId": 12345
}
```

**Radarr** — `POST /api/v3/movie`
```json
{
  "tmdbId": 12345,
  "title": "...",
  "qualityProfileId": 1,
  "rootFolderPath": "/movies"
}
```
Radarr requires a quality profile ID and root folder — these need to be fetched from
Radarr's API on first connection test and stored as additional settings
(`radarr_quality_profile_id`, `radarr_root_folder`), or exposed as dropdowns in the
Connections admin UI.

**Sonarr** — `POST /api/v3/series`
Similar pattern to Radarr — needs quality profile + root folder + language profile.

Overseerr is significantly simpler to integrate (it handles all the Radarr/Sonarr
configuration internally) and is the recommended path for most setups.

---

## Navigation Changes

Nav bar gains a "Discover" link between home icon and "Diskovarr View":

```
[logo]   Home   Discover   Diskovarr View       [avatar] [username] ▾
```

"Discover" link is only rendered if `discover_enabled && tmdb_api_key` in settings.
On mobile FAB menu: same conditional.

---

## New Files

```
routes/discover.js          -- GET /discover, GET /api/discover/recommendations
services/tmdb.js            -- TMDB API wrapper, caching, bridge from Plex IDs
views/discover.ejs          -- Discover tab page (mirrors home.ejs structure)
views/admin/connections.ejs -- Connections tab in admin panel
public/js/discover-app.js   -- Carousel + shuffle for discover page
```

## Modified Files

```
routes/admin.js             -- Mount connections tab, read/write new settings keys
routes/api.js               -- POST /api/request endpoint
db/database.js              -- Getters/setters for new settings keys
views/partials/nav.ejs      -- Conditional Discover link
server.js                   -- Mount /discover route
services/plex.js            -- Extract TMDB IDs from Plex item guids
services/recommender.js     -- Expose preference profile for reuse in discover scoring
```

---

## TMDB Metadata Cache (SQLite)

New table `tmdb_cache`:

```sql
CREATE TABLE tmdb_cache (
  tmdb_id INTEGER NOT NULL,
  media_type TEXT NOT NULL,   -- 'movie' or 'tv'
  title TEXT,
  overview TEXT,
  poster_path TEXT,
  genres TEXT,                -- JSON array
  cast TEXT,                  -- JSON array
  directors TEXT,             -- JSON array (movies) / creators (tv)
  studios TEXT,               -- JSON array
  vote_average REAL,
  vote_count INTEGER,
  release_year INTEGER,
  fetched_at INTEGER,
  PRIMARY KEY (tmdb_id, media_type)
);
```

Existing Plex library items get TMDB IDs stored in the `library` table via a new
`tmdb_id` column, populated during library sync from Plex guid parsing.

---

## What Does Not Change

- Home page and its recommendations are untouched
- Tautulli sync, watched filtering, dismissals all unchanged
- Existing admin panel tabs (Library Sync, User Watch Sync, Recommendation Cache,
  Server Owner & Watchlist Mode, Theme Color) all unchanged
- .env file — no new required env vars; all service credentials managed in admin DB
