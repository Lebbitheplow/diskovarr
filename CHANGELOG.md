# Changelog

## Unreleased

### Added
- **Detail modal** — clicking any card opens a full-screen overlay with poster art, Rotten Tomatoes tomatometer and audience scores (fresh/rotten/upright/spilled states), genres, plot summary, director and cast credits, Watch in Plex link, and watchlist/dismiss buttons
- **Mobile nav FAB** — floating action button in the bottom-right corner on mobile; taps open a slide-up menu with user info, Admin link, and Sign out (keeps the header clean on small screens)
- **Toast notifications** — slide-up confirmation when items are added to the Diskovarr playlist
- **Diskovarr View** — full library browser with filters for type (Movie / TV / Anime), decade, min rating, genres, sort order, and include-watched toggle; paginated with Load More
- **Admin: per-user display names** — admin panel shows Plex username and avatar instead of numeric user ID; populated from session data on login
- **Admin: sync progress indicator** — animated spinner on the status badge, progress message, and disabled Sync Now button while a library sync is running; auto-starts polling on page load if a sync is already in progress
- **Admin: per-user watched re-sync spinner** — Re-sync Watched button shows a spinner and updates the watched count in-place when done, no page reload needed

### Changed
- **Recommendation scoring overhaul** — genre weight reduced and capped per-genre (prevents single-genre dominance); director weight raised to 30 pts; actor weight to 25 pts; studio signal added (15 pts); star rating multipliers (5★ = 2.5×, ≤2★ = 0.4×); recency tiers (top-30: 1.8×, 31-100: 1.3×); rewatch count bonus
- **Top Picks diversity** — seeds top scorers then injects picks for top directors, actors, and studio to avoid genre-bubble results
- **Reason tags** — now shows "Because you loved [Title]" using the trigger item that most contributed each signal
- **Watched sync now uses admin token + accountID** — user tokens frequently return 401 on direct library endpoints for Plex Friends; switching to admin token with `accountID` parameter correctly fetches watch data for all user types
- **Watched sync catches in-progress movies** — global `/library/onDeck` now used instead of section-specific onDeck, adding in-progress movies to the excluded set
- **Parallel library sync deduplication** — multiple simultaneous requests while a library section is syncing now share one fetch instead of each starting their own, preventing Plex server overload
- **Library sync timeout raised to 240s** — accommodates large TV libraries that take 1-2 minutes to respond
- **Stale library fallback** — if a library sync fails, cached DB data is served rather than returning an error
- **Admin panel shows all users** — users with 0 watched items (e.g. new users whose sync returned empty) now appear in the panel via sync_log join; previously only users with DB rows were visible
- **JS cache-busting** — script tags updated to `?v=4` to force browsers to load updated app.js and watchlist.js

### Fixed
- **Theme color not persisting** — `getThemeColor`/`setThemeColor` were reading/writing `sync_log` instead of the `settings` table; rewritten to use `INSERT OR REPLACE INTO settings`
- **Diskovarr View always showing "Failed to load results"** — `renderCard` was scoped inside the app.js IIFE and not accessible to discover.js; fixed by exposing as `window.renderCard`
- **Clicking a card refreshed the page** — browser had cached an old app.js where the poster was an `<a>` tag; fixed with JS cache-busting version param
- **Admin Re-sync Watched causing user to disappear** — `clearUserWatched` deleted the `sync_log` entry which the admin panel query depends on; removed the redundant pre-clear (syncUserWatched already does a full replace internally)
- **Playlist name mismatch** — `addToWatchlist` was creating the playlist as "Diskovarr Watchlist" but `getDiskovarrPlaylist` searched for "Diskovarr"; unified to "Diskovarr"

## v0.1.0 — Initial release

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
