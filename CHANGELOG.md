# Changelog

All notable changes are documented here. Versioning follows [Semantic Versioning](https://semver.org/).

---

## v1.1.0 — 2026-03-06

### Added

- **Diskovarr Requests tab** — optional tab showing content not in the Plex library, scored by the same preference engine used for in-library recommendations. Sections: Top Picks, Movies, TV Shows, Anime. Requires a TMDB API key configured in the admin panel.
  - Cards display reason tags ("Because you like X", "Directed by Y", "Starring Z") on the tile and in the detail modal
  - Detail modal with backdrop hero, poster, meta (year / type / rating), reason tags, genre tags, overview, director/cast/studio credits, and a Request button
  - Request button routes to Overseerr (preferred), Radarr (movies), or Sonarr (TV) based on which services are enabled
  - Unreleased content automatically excluded
  - Sources: TMDB recommendations from top-watched items, genre-based discovery (2 pages, popularity-sorted, min rating 6.5), trending movies and TV for the week
  - 6-hour per-user cache with shuffle support; pool sizes: 150 top picks, 200 movies, 150 TV, 100 anime

- **Admin panel: Connections tab** — new tab alongside Settings for configuring all external services without editing files or restarting the server:
  - **Plex** — URL and admin token (with eye show/hide toggle)
  - **Tautulli** — URL and API key (with eye show/hide toggle)
  - **TMDB** — API key; Save Key + Test buttons
  - **Diskovarr Requests** — slide toggle to enable/disable the Requests tab; locked until TMDB key is saved
  - **Overseerr / Radarr / Sonarr** — URL, masked API key (eye toggle), Test button, and slide toggle; toggle locked until URL and key are both filled
  - All settings auto-save when a toggle changes; no restart needed

- **Admin panel: Settings/Connections tab navigation** — two-tab layout at the top of the admin page; all original settings remain in the Settings tab

- **Admin panel: version strip** — shows running version (`v1.1.0`) below the hero; shows an accent-coloured "↑ vX.Y.Z available" badge linking to GitHub releases when a newer tag exists (checked against GitHub API, 6-hour cache)

- **Admin panel: user ID hover reveal** — user ID is hidden by default in the Users & Watch Sync table and fades in on hover to reduce visual clutter

- **Plex and Tautulli configurable via admin panel** — URL and token/key values entered in the Connections tab override `.env` at runtime; `.env` still works as a fallback for initial setup

- **Docker support** — `Dockerfile`, `docker-compose.yml`, and `.dockerignore` added; Docker is now the recommended deployment method

- **TMDB service** (`services/tmdb.js`) — wrapper for TMDB API with in-SQLite cache (7-day TTL); methods: `getRecommendations`, `discoverByGenreIds`, `discoverAnime`, `getTrending`, `normalizeMovie`, `normalizeTV`, `testApiKey`

- **Discover recommender** (`services/discoverRecommender.js`) — separate scoring engine for non-library content; reuses the preference profile from `recommender.js`; library exclusion uses TMDB ID match with title+year fallback

### Changed

- **`services/plex.js`** — Plex URL, token, and server ID are now read at call time via getter functions (DB → env fallback) instead of module-load-time constants; enables live config changes from the admin panel without restart
- **`services/tautulli.js`** — Tautulli URL and API key read via getter functions with DB → env fallback
- **`services/recommender.js`** — section IDs read via getter functions with DB → env fallback
- **Admin API keys** — all connection API keys masked as `••••••••` in the rendered HTML; eye button fetches the real value from `/admin/connections/reveal` on demand (admin session only; never sent in page source)
- **TMDB genre discovery** — sort changed from `vote_average.desc` (returned all-time classics) to `popularity.desc` with `vote_average.gte=6.5&vote_count.gte=50` for fresher, more discoverable results

### Fixed

- **Library items appearing in Diskovarr Requests** — `isAlreadyHave` was called without title/year when TMDB IDs not yet populated; now uses both ID and title+year fallback
- **Pill input layout in Connections tab** — masked password fields wrapped in `.conn-input-wrap` with `aspect-ratio`-correct sizing so the eye button sits cleanly inside the right end of the pill

---

## v1.0.0 — 2026-03-06

First stable release. Full-featured personalized Plex recommendation app with multi-user support, Plex OAuth, carousel UI, admin panel, and watchlist sync.

### Added
- **Detail modal** — clicking any card opens a full-screen overlay with poster art, Rotten Tomatoes tomatometer and audience scores, genres, plot summary, director and cast credits, Watch in Plex link, and watchlist/dismiss buttons
- **Carousel layout** — each home page section (Top Picks, Movies, TV Shows, Anime) is presented as a 2-row paginated carousel with left/right navigation arrows and a page counter
- **Shuffle button** — ↺ button in each section header draws a fresh random sample from the scored pool without rescoring
- **Tiered random sampling** — recommendation pools (200 movies, 150 TV, 100 anime, 150 top picks) are cached per user; each request samples ~60% from top-scoring items, ~30% from mid tier, ~10% from lower tier
- **Watchlist sync** — items sync to native Plex.tv Watchlist for all users; server owner can toggle to Playlist mode via the admin panel
- **Server owner selector** — admin panel dropdown to set which Plex user is the server owner
- **Client-side Plex PIN creation** — OAuth PIN created directly from the browser so Plex records the user's IP
- **Friend watchlist support** — Friend accounts sync watchlist items to plex.tv Watchlist via the Discover API
- **Mobile nav FAB** — floating action button on mobile with user info, Watchlist, Admin, Info, and Sign out
- **Toast notifications** — slide-up confirmation for watchlist changes
- **Diskovarr View** — full library browser with filters for type, decade, genre, min rating, sort order, and watched status
- **Admin: server owner & watchlist mode** — pick the owner Plex account and toggle sync modes
- **Admin: per-user watch sync** — watched counts, re-sync, and clear per user
- **Admin: sync progress indicator** — animated spinner and disabled button while syncing
- **Admin: theme color picker** — 8 presets + color wheel

### Changed
- **Recommendation scoring overhaul** — genre weight capped per-genre; director 30 pts; actor 25 pts; studio 15 pts; star rating multipliers; recency tiers; rewatch count bonus
- **Top Picks diversity** — seeds top scorers then injects picks for top directors, actors, and studios

### Fixed
- **Theme color not persisting** — was reading/writing wrong settings key
- **Diskovarr View "Failed to load results"** — `renderCard` not accessible outside IIFE; fixed by exposing as `window.renderCard`
- **Playlist 401 for Friend accounts** — switched Friends to plex.tv Watchlist API
- **Server IP shown in Plex security warning** — moved PIN creation to browser-side
- **Admin Re-sync causing user to disappear** — `clearUserWatched` was deleting the sync log entry

---

## v0.1.0 — Initial prototype

- Plex OAuth PIN flow sign-in
- Personalized recommendations from Tautulli watch history
- Top Picks, Movies, TV Shows, Anime sections with skeleton loading
- Private Diskovarr playlist (watchlist) via Plex playlist API
- Dismiss items permanently per user
- SQLite-backed library cache with 2-hour TTL
- Background per-user watched sync (30-minute TTL)
- Admin panel: library sync, cache management, theme color picker
- Poster image proxy (Plex token never sent to browser)
- Dark Netflix-style UI with CSS variable theming
- systemd service support
