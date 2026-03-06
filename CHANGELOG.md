# Changelog

All notable changes are documented here. Versioning follows [Semantic Versioning](https://semver.org/).

---

## v1.0.0 — 2026-03-06

First stable release. Full-featured personalized Plex recommendation app with multi-user support, Plex OAuth, carousel UI, admin panel, and watchlist sync.

### Added
- **Detail modal** — clicking any card opens a full-screen overlay with poster art, Rotten Tomatoes tomatometer and audience scores (fresh/rotten/upright/spilled states), genres, plot summary, director and cast credits, Watch in Plex link, and watchlist/dismiss buttons
- **Carousel layout** — each home page section (Top Picks, Movies, TV Shows, Anime) is presented as a 2-row paginated carousel with left/right navigation arrows and a page counter
- **Shuffle button** — ↺ button in each section header draws a fresh random sample from the scored pool without rescoring; page refresh also gives different results automatically
- **Tiered random sampling** — recommendation pools (200 movies, 150 TV, 100 anime, 150 top picks) are cached per user; each request samples ~60% from top-scoring items, ~30% from mid tier, ~10% from lower tier so results vary while quality is maintained
- **Watchlist sync** — items sync to native Plex.tv Watchlist for all users; server owner can toggle to Playlist mode (private "Diskovarr" server playlist) via the admin panel — useful when the native Plex Watchlist triggers download automation (pd_zurg)
- **Server owner selector** — admin panel dropdown to explicitly set which Plex user is the server owner; used for watchlist mode routing instead of unreliable token comparison
- **Client-side Plex PIN creation** — OAuth PIN is created directly from the browser so Plex records the user's IP in the security warning, not the server's
- **Friend watchlist support** — Friend accounts sync watchlist items to their plex.tv Watchlist via the Discover API (`PUT discover.provider.plex.tv/actions/addToWatchlist`)
- **Mobile nav FAB** — floating action button in the bottom-right corner on mobile; taps open a slide-up menu with user info, Admin link, and Sign out
- **Toast notifications** — slide-up confirmation when items are added to or removed from the watchlist
- **Diskovarr View** — full library browser with filters for type (Movie / TV / Anime), decade, min rating, genres, sort order, and include-watched toggle; paginated with Load More
- **Admin: server owner & watchlist mode** — combined section to pick the owner Plex account and toggle between Watchlist and Playlist sync modes
- **Admin: per-user display names** — shows Plex username and avatar instead of numeric user ID
- **Admin: sync progress indicator** — animated spinner, progress message, and disabled Sync Now button while syncing; auto-starts polling if a sync is already in progress on page load
- **Admin: per-user watched re-sync spinner** — Re-sync button shows spinner and updates count in-place, no page reload needed
- **Admin: theme color picker** — 8 presets + color wheel; accent color updates across all pages immediately

### Changed
- **Recommendation scoring overhaul** — genre weight reduced and capped per-genre (prevents single-genre dominance); director 30 pts; actor 25 pts; studio signal 15 pts; star rating multipliers (5★ = 2.5×, ≤2★ = 0.4×); recency tiers (top-30: 1.8×, 31-100: 1.3×); rewatch count bonus
- **Top Picks diversity** — seeds top scorers then injects picks for top directors, actors, and studios to avoid genre-bubble results; pool expanded to 150 items
- **Reason tags** — shows "Because you loved [Title]" when a highly-rated watched item is the top contributor to a signal
- **Watched sync uses admin token + accountID** — correctly fetches watch data for Friends and managed users without 401 errors
- **Watched sync catches in-progress content** — global `/library/onDeck` used instead of section-specific, adds in-progress movies and shows to excluded set
- **Parallel library sync deduplication** — concurrent requests during a sync share one fetch instead of each starting their own
- **Library sync timeout raised to 240s** — accommodates large TV libraries
- **Stale library fallback** — if a sync fails, cached DB data is served rather than an error

### Fixed
- **Theme color not persisting** — was reading/writing `sync_log` instead of `settings` table
- **Diskovarr View showing "Failed to load results"** — `renderCard` was not accessible outside the app.js IIFE; fixed by exposing as `window.renderCard`
- **Playlist 401 for Friend accounts** — switched Friends to plex.tv Watchlist API; server playlist is owner-only
- **Server IP shown in Plex security warning** — moved PIN creation to browser-side so Plex records user IP, not server IP
- **Admin Re-sync Watched causing user to disappear** — `clearUserWatched` was deleting the `sync_log` entry the admin panel query depends on

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
