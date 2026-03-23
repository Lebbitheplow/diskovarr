# Changelog

All notable changes are documented here. Versioning follows [Semantic Versioning](https://semver.org/).

---

## v1.17.8 — 2026-03-23

### Added

- **Watched status on tiles and modals** — items you have already watched now show a green checkmark badge on the poster thumbnail and a Watched pill in the detail modal.
- **Queue — Available filter** — a new Available filter button on the queue page shows all approved requests that are now in your Plex library.
- **Queue — sortable column headers** — clicking any column header (Title, User, Type, Age, Status) sorts the full queue server-side, ascending or descending, with an arrow indicator. Sorting works across all pages.
- **Queue — larger posters** — request row poster thumbnails increased from 40×60 to 52×78 px.
- **README — Docker Hub install instructions** — added a quick `docker pull` / `docker run` block to the Installation section.

### Fixed

- **Watched count showing ~715 for all users** — Tautulli's `get_history` was being called with Plex user IDs that don't exist in Tautulli (bots, service accounts), causing it to return full shared history for every user. The sync now validates user IDs against Tautulli's user list before fetching and skips users not found there.
- **Content-available notifications now open the item modal** — clicking a "now available" notification navigates to the home page and opens the detail modal for that specific title instead of navigating to the queue.
- **Read notifications are now clickable** — previously read notifications in the bell dropdown were non-interactive. They now respond to clicks the same as unread ones.
- **Notification modal poster not loading** — the poster proxy was wrapping full TMDB HTTPS image URLs in `/api/poster?path=...`, causing the image to fail. Full HTTP/HTTPS URLs are now passed through directly.

---

## v1.17.7 — 2026-03-22

### Fixed

- **Torrent browser — internal server error**: The Browse Torrents page returned a 500 error on load due to a missing `bgGradientCss` variable not being passed to the view from the riven route.
- **Admin panel — DUMB/Riven wording**: Section headers, toggle labels, default service button, and mode descriptions updated to lead with DUMB rather than Riven throughout the admin panel.

---

## v1.17.6 — 2026-03-22

### Added

- **Documentation site** — full documentation and setup guide is now live at [diskovarr.com](https://diskovarr.com). Covers installation, all admin panel settings, every page, integrations, and the full API reference.
- **Documentation link in admin panel** — a Documentation pill link in the admin panel version strip links directly to the docs site. Visible on all tabs.

### Fixed

- **Cast to TV — device isolation**: Removed GDM (UDP broadcast) and PMS `/clients` as device discovery sources. Both methods run on the server's local network, causing all users to see the admin's Plex player devices instead of their own. Device lookup now uses `plex.tv/api/v2/resources` and `devices.xml` with each user's own Plex token exclusively, so every user only sees devices registered to their account.
- **Cast to TV — remote casting**: The cast command was being sent with the server admin token (`castToken = serverToken || userToken`), which cannot control another user's Plex client. playMedia is now sent using the requesting user's own token. Connection lookup also now prefers relay connections (which work across any network) over local LAN connections, fixing cast failures for users not on the same network as the server.

---

## v1.17.5 — 2026-03-22

### Added

- **Per-user default landing page** — users can now choose whether to land on Diskovarr or Diskovarr Requests after signing in, via My Settings. Admins can also set this per-user in the admin panel. Only shown when Diskovarr Requests is enabled. Removed the server-wide landing page setting from the admin panel.
- **Request count in admin user table** — the Users tab in the admin panel now shows a Requests column with each user's total request count.
- **Larger nav logo** — the Diskovarr icon in the top-left navbar is slightly larger for better visibility.
- **Admin users pagination** — the Users tab now paginates at 10 users per page (configurable to 25 or 50 via a dropdown). The per-page selector is always visible. Pagination loads in place without reloading the page or losing your scroll position.

### Fixed

- **Show/hide eye icons invisible in connections tab** — the reveal buttons on API key fields (Plex, Tautulli, TMDB, Overseerr, Radarr, Sonarr, Riven) had no visible icon. They now show the same eye icon used on the DUMB and Agregarr fields. Hovering no longer causes the icon to disappear.
- **Connections tab layout cleanup** — the Riven/DUMB and Agregarr blocks no longer show large inline instruction boxes. Setup instructions and API key hints are now accessible via an ⓘ info icon next to each block header. The DUMB request mode selector is repositioned to the right side of the key row. DUMB and Agregarr API key fields are wider for easier reading.

- **Season limit bypass** — service users with a per-season limit (e.g. 20 seasons per 4 days) could bypass it because the cost was calculated from the explicit seasons list in the request body. Automated tools like Agregarr always send `seasons:[1]`, so every show counted as 1 season regardless of actual size. The limit now charges the full TMDB season count for each show, and that value is stored in the DB so the rolling window stays accurate.
- **Season bubbles overflowing on queue page** — shows with more than 9 seasons selected would produce a very wide row. The season bubble list now truncates to a `...` ellipsis bubble followed by the last 8 seasons, keeping the row compact while still showing the most recent seasons.
- **Experimental cast: bedroom TV not discoverable or castable** — several issues prevented casting to local smart TVs. GDM discovery was only broadcasting to `255.255.255.255`; it now also sends to the Plex multicast address `239.0.0.250`. The cast endpoint was not creating a PlayQueue before sending `playMedia`, which is required by the Plex protocol. Direct player connection lookup was added as the primary cast path before falling back to the PMS relay.
- **Empty recommendation tag bubbles** — items with low-confidence "recently released" signals were given a `null` reason label, which rendered as a blank bubble on recommendation cards. Null and empty reasons are now filtered out before being returned.
- **API endpoint reference incomplete** — the collapsible endpoint reference in Admin → General was missing issues, watchlist add/remove, explore, notifications, dismiss, and genres endpoints. It now documents all 28 public API endpoints organized by category.

### Improved

- **TMDB discover pipeline** — region and language preferences (set in My Settings) are now applied directly to TMDB discover queries (`region=`, `with_original_language=`). The mature content toggle is now stored server-side and controls `include_adult` at TMDB query time — mature content is excluded from the candidate pool itself rather than just hidden client-side. Discover candidates are pre-fetched once per unique region+language+mature combination and shared across all users with matching preferences; only the per-user scoring step runs per user. A 28-minute background job keeps each user's Explore cache warm so the page loads instantly. The 6-hour background job refreshes the shared candidate pools for each pref combo found in the DB.
- **Shared TMDB detail cache** — when the shared candidate pool is built, full item details (genres, keywords, cast, directors, studios, ratings, trailers) are fetched and cached in the database once per item. All users score against the same enriched data regardless of their preferences — no duplicate API calls. Per-user candidates (TMDB recommendations and similar titles from your watch history, person-based matches, keyword discovery, Plex related items) are still fetched per user on first load and refreshed in the background, ensuring the recommendation quality reflects your personal watch history.
- **Requested items in recommendations** — items that have been requested but are not yet in the library now appear in recommendations with a "Requested" badge. If the item was requested by someone else, clicking the request button creates a follow entry — you will be notified when the title becomes available, the same as the original requester.
- **Hide Requested toggle** — a new toggle on the Explore page hides requested items from all recommendation and trending sections (server-side). Toggle state persists across sessions.

---

## v1.17.4 — 2026-03-21

### Added

- **Accent-colored background gradient** — all pages now have a subtle radial glow that uses the current accent color. The spotlight fades in from the top center and a softer glow anchors the bottom, giving the app a cohesive ambient feel. The gradient updates in real-time when the accent color is changed in the admin panel — no page refresh needed.

### Fixed

- **Requests routing to wrong service** — the default request service setting was not being passed to the frontend on the explore and search pages, causing requests to always fall back to Overseerr regardless of what was configured in admin settings.

---

## v1.17.3 — 2026-03-21

### Fixed

- **Season rate limit bypass via Agregarr** — the season limit check ran before the TMDB fetch, so when Agregarr doesn't send a seasons array the request was counted as 1 season instead of the real count. The check now runs after the seasons array is derived from `numberOfSeasons`, so a 74-season show correctly consumes 74 against the limit.
- **Info modal credits username** — contributor display name corrected from "Gage" to "gage117".
- **Queue actions scroll to top** — approving, denying, editing, or deleting a request now updates the row in place; the page no longer re-renders and jumps to the top. Approve/deny update the status badge and strip the action buttons in place; edit updates the season bubbles without a reload.
- **Issues actions scroll to top** — resolving, closing, or deleting an issue removes the row in place. Delete no longer uses the native `confirm()` dialog; it reuses the existing action modal.
- **Queue per-page preference resets on restart** — the selected items-per-page is now saved to localStorage and restored on page load.
- **Mobile horizontal page scroll on queue and issues** — the table now scrolls horizontally within its container on narrow screens instead of the whole page panning sideways.

### Added

- **Issues section in info modal** — the ℹ︎ modal now includes a brief description of the Issues page alongside the existing Diskovarr, Queue, Filter, and Watchlist sections.

---

## v1.17.2 — 2026-03-21

### Added

- **Bulk user settings** — select multiple users in Admin → Users and apply the same settings override to all at once. Each field (request limit override, auto-approve movies/TV, admin privileges) has a three-state selector so only the fields you care about are changed; everything else is left as-is.
- **Season bubbles on TV requests** — the request queue now shows individual season number chips (S1 S2 S3…) for each TV request so you can see at a glance how many seasons were requested. New requests derive this from the show's total season count via TMDB.
- **Request age** — the queue Date column is now a relative age (e.g. "3 hours ago", "2 days ago") instead of an absolute date.
- **Info modal credits** — a "Created by" line at the bottom of the info modal links to the GitHub profiles of the project contributors.

### Fixed

- **DUMB queue polling** — DUMB was silently fetching 0 items from the approved queue. Three root causes fixed: approved requests were returned with `media.status=5` (AVAILABLE) instead of `3` (PROCESSING) so DUMB filtered them out; the `/movie/:id` and `/tv/:id` detail endpoints needed by DUMB to look up IMDb IDs were missing; and the request object was missing the `type` and `media.media_type` fields that DUMB accesses internally, causing AttributeErrors that crashed the polling loop.
- **Agregarr service user attribution** — requests via the shim were all attributed to the generic app user (`__app_1__`) instead of the named Agregarr service users. Fixed by reading the `X-Api-User` header that Agregarr sends for impersonation and looking up the matching service user record.
- **Agregarr requests always pending** — shim was hardcoding `status='pending'` regardless of auto-approve settings. Fixed to call `getEffectiveAutoApprove()` so requests auto-approve when the global or per-user setting allows it.
- **Agregarr requests with non-TMDB IDs** — requests whose TMDB ID returns 404 (e.g. AniList IDs sent by Agregarr) were stored with a numeric title. These are now silently skipped and a clean 201 is returned so Agregarr's sync continues.
- **Agregarr rate limit response** — hitting a per-user season or movie limit returned 403, which caused Agregarr's sync to freeze. Rate-limited requests now receive a silent 201 success response so the sync continues uninterrupted.
- **Approve request with `service='none'`** — requests queued via the shim are stored with `service='none'`. Approving them returned "Invalid service". The approve endpoint now picks the best available service dynamically when `service='none'`.
- **Delete confirmation modal** — browsers that had suppressed the native `confirm()` dialog always returned false, making it impossible to delete requests. Replaced with a custom in-page modal that also supports a "don't ask again" checkbox backed by localStorage.

---

## v1.17.1 — 2026-03-21

### Added

- **DUMB request polling** — DUMB can now connect to Diskovarr as its Overseerr source instead of Diskovarr pushing directly to Riven. Enable in Admin → Connections → Riven → DUMB Integration; generate an API key and enter it in DUMB's Overseerr settings. Choose Pull mode (DUMB polls `/api/v1/request`) or Push mode (Diskovarr pushes to Riven on approval). DUMB marks content available via `PUT /api/v1/media/:id/available`, which triggers the fulfilled notification pipeline.
- **Search page autocomplete** — the search bar on the results page now shows TMDB suggestions as you type, matching the behaviour of the nav bar.

### Fixed

- **DUMB API key length** — Riven validates Overseerr API keys against an exact 68-character length check; Diskovarr now generates 68-character keys (34 random bytes) for DUMB instead of the default 64-character keys used for other integrations.
- **Session cookie `sameSite`** — hardened from `lax` to `strict`; the admin session cookie is no longer sent on cross-site navigations.

---

## v1.17.0 — 2026-03-21

### Added

- **Riven/DUMB as a request service** — Riven can now be selected as a request routing target alongside Overseerr, Radarr, and Sonarr. Configure the Riven URL and API key in Admin → Connections → Riven; requests submitted through Diskovarr will be sent to Riven automatically.
- **Riven/DUMB torrent browser** — DMM-style torrent browser at Admin → Connections → Riven → "Browse Torrents". Search any title by name, see Torrentio results with Real-Debrid cache status and quality info, and inject a chosen torrent directly into Riven with one click. Riven handles download, symlink creation, and Plex notification automatically. Includes a season selector for TV shows and a manual magnet/hash paste fallback for content not indexed by Torrentio.
- **Agregarr integration** — Diskovarr now presents an Overseerr-compatible API at `/api/v1/` so Agregarr (and other Overseerr-compatible apps) can connect to it directly. Enable it in Admin → Connections → Agregarr, copy the generated API key, and enter it in Agregarr settings as an Overseerr URL. Agregarr creates its own service user accounts automatically; requests from those accounts appear in the queue attributed to the correct Agregarr user with a "bot" badge.
- **Plex WebSocket** — real-time library change listener (no Plex Pass required). When Plex adds new content, the library cache is invalidated and fulfilled request checks run instantly. Reconnects automatically with exponential back-off.

### Fixed

- **Admin icon buttons** — eye and copy icon buttons in the Connections tab API key fields now render as solid filled icons, visible at all sizes.

---

## v1.16.1 — 2026-03-20

### Added

- **Plex webhook listener** — Diskovarr now listens at `POST /api/webhooks/plex` for Plex `library.new` events. When new content is added to Plex, the library cache is automatically invalidated and fulfilled request checks run immediately. Register the URL in Plex Settings → Webhooks (requires Plex Pass).

---

## v1.16.0 — 2026-03-19

### Added

- **Issue comments** — users and admins can now exchange comments on any issue directly in the issue detail modal. Admin comments notify the reporter; user comments notify all admins. Each comment shows the author name, an admin badge when applicable, a formatted timestamp, and a delete button for the comment author or any admin.
- **Discord independent webhook/bot toggles** — webhook and bot can now be enabled simultaneously and independently, each with its own notification type checklist, embed poster toggle, and Save/Test button. Previously only one mode could be active at a time.
- **Discord per-panel embed poster** — the "Embed poster image" toggle is now separate for webhook and bot so each can be configured independently.
- **Pushover notification sound** — choose from the full Pushover sound library (or device default / silent) in the Pushover agent settings.
- **Pushover embed poster** — toggle to attach the title's poster image to Pushover notifications via the Pushover attachment API.
- **Pushover setup hints** — clickable help links under the App API Token ("Register an application") and User/Group Key ("User or Group ID") fields link to the relevant Pushover documentation.

### Changed

- **Discord bot username and avatar** — these settings now live inside the Bot Token panel rather than in a shared section below both panels.
- **Issue Comments notification type** — the two separate "Issue comment from user" and "Admin replied to your issue" checkboxes are merged into a single "Issue Comments" toggle across all notification type lists (Discord webhook, Discord bot, Pushover). Enabling it activates notifications for both directions.

---

## v1.15.0 — 2026-03-18

### Added

- **Admin broadcast notifications** — new "Broadcast Message" panel at the top of Admin → Notifications; type a message and click "Notify All Users" to send it to every user simultaneously via all configured channels (in-app bell, Discord, and Pushover). Discord bot mode DMs each user who has linked their account; webhook mode posts to the shared channel. Pushover sends to the global key and any per-user keys.
- **Broadcast bell modal** — clicking a broadcast notification in the bell dropdown opens a full-screen modal showing the complete message instead of navigating away.
- **Last Visit in admin Users tab** — the "Last Sync" column is replaced with "Last Visit", which updates whenever a logged-in user browses the app (throttled to once per 5 minutes per user, persists across sessions).

---

## v1.14.4 — 2026-03-17

### Added

- **Global requests disable toggle** — admin panel Request Limits section now has an Enabled/Disabled toggle; when disabled, the Request button is hidden site-wide in the Requests tab and search results and the API rejects direct submissions. Per-user admin settings can grant a specific user the ability to make requests even when globally disabled.

### Fixed

- **Requests without a configured service** — users can now submit requests even when no request service (Overseerr, Radarr, Sonarr) is configured; the request appears in the queue and triggers notifications as normal, but is not automatically forwarded to any service.
- **Landing page toggle locked when Requests tab is disabled** — the "Diskovarr Requests" side of the Set Landing Page toggle is now disabled in the admin panel when the Requests tab is turned off.

---

## v1.14.2 — 2026-03-17

### Added

- **Request fulfilled notifications** — when a requested title appears in the Plex library, the requester receives a bell notification, Discord DM, and/or Pushover push (respects per-user `notify_available` preference). Detection runs after every library sync and instantly via a new Plex webhook endpoint (`POST /api/webhooks/plex`; register in Plex → Settings → Webhooks, requires Plex Pass).
- **Discord/Pushover notification grouping** — multiple events of the same type in the same hour are batched into one message matching what the bell shows (e.g. `"Dune" approved and 2 other titles`), with the first title's poster embedded full-width.
- **Discord/Pushover skip-if-read** — if the user reads the bell notification in Diskovarr before the delivery window elapses, the external send is skipped.

### Fixed

- **Discord `issue_new` / `issue_updated` enabled by default** — existing configs saved before these types were added now default them to checked, preventing silent opt-out.
- **Discord `embedPoster` defaults to on** — existing configs that never explicitly set this field now default to enabled.
- **Discord `issue_updated` added to shared-channel webhook** — bot mode now also posts issue resolutions/closures to the configured shared channel.
- **Pushover `request_available` type** — added to the admin notification type list.

---

## v1.1.1 — 2026-03-06

### Fixed

- **Watchlist add after Diskovarr Request** — items were not being added to the user's plex.tv Watchlist after a successful request; the GUID from the Discover search API is now used directly instead of attempting a local Plex library lookup that would fail for non-library content
- **Info modal version hardcoded** — the ℹ︎ button overlay was showing `v1.0.0` instead of the running version; now reads from `package.json` at startup like the admin panel does

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
