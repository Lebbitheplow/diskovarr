# Changelog

All notable changes are documented here. Versioning follows [Semantic Versioning](https://semver.org/).

---

## v2.5.1 — 2026-07-05

A polish release making Tuberr effectively zero-setup, plus admin panel refinements.

### Added

- **Tuberr bundled in Docker** — the Diskovarr image now ships and auto-starts Tuberr, and the server pairs with it automatically (URL + API key fill themselves in), so Docker admins never touch a terminal for Tuberr. Expose port 9832 for Sonarr, share a downloads volume both containers mount at the same path (`TUBERR_DOWNLOADS_DIR`), and opt out with `TUBERR_ENABLED=false`. Works on the Alpine image via the universal yt-dlp build; ffmpeg is included for 1080p merges.
- **One-click Sonarr wiring** — the **Set up Sonarr** button creates the `yt`-tagged Torznab indexer and qBittorrent-compatible download client in Sonarr, linked together (idempotent — re-run it after changing the Tuberr address). Full setup becomes: enable the toggle, add a YouTube API key, click Set up Sonarr.
- **Manage Series moved to Connections** — YouTube series management is no longer an admin tab; it opens as a modal from the YouTube (Tuberr) section, next to the settings it belongs with.
- **Optional YouTube root folder** — admins with a dedicated YouTube library (e.g. `/NAS/YT Videos`) can route new YouTube series there via a dropdown of Sonarr's root folders; the default keeps them wherever other shows go.
- **Sonarr-side tagging just works** — series tagged `yt` directly in Sonarr are discovered automatically; Tuberr auto-detects their source channel by probing candidates against the episode list and only commits verified matches. Undetectable series are flagged in Manage Series with a channel picker and an Auto-detect button.
- **Generic-title matching** — series whose TVDB episodes are titled "Episode 11" (often with absolute numbering) now match via episode numbers and air dates instead of meaningless title similarity.

### Fixed

- **YouTube requests are locked to Sonarr** — the request dialog, queue edits, and approval flows can no longer reroute a YouTube request to Overseerr or DUMB, and the Overseerr-compatible API hides YouTube requests from DUMB's pull-mode polling (it would try to fetch them via debrid and fail).

---

## v2.5.0 — 2026-07-05

A feature release adding YouTube series support — search, request, and automatically download YouTube web series through Sonarr.

### Added

- **Tuberr companion service** (`tuberr/` in the repo) — lets Sonarr download YouTube series with yt-dlp. Tuberr presents itself to Sonarr as a **Torznab indexer** plus a **qBittorrent-compatible download client**; Sonarr grabs releases, watches live download progress in its queue, and imports/renames episodes exactly like any other source. Series added this way carry a `yt` tag in Sonarr, so the YouTube indexer and downloader never touch your normal shows. On boot Tuberr writes its API key to `data/api_key.txt` — no log spelunking during setup.
- **Download via YouTube** — TV requests going to Sonarr get a Torrent / YouTube choice in the request dialog. Picking YouTube suggests source channels for the show (via YouTube search) and accepts a pasted channel or video URL. The chosen channel is registered with Tuberr and episode matching starts immediately.
- **TVDB-only search** — text search merges Sonarr's TVDB lookup with TMDB results, so web series missing from TMDB (most YouTube shows) appear in results and can be requested. Plex library items are now also matched by their `tvdb://` guid, so YouTube shows already in your library are recognized as In Library.
- **Automatic episode matching** — Tuberr pulls the channel's uploads through the YouTube Data API and scores each video against TVDB episode titles, air dates, explicit episode numbers, and durations (Shorts are filtered out). Confident matches are used automatically; uncertain ones keep their ranked candidates for review. Unmatched episodes simply return no releases, so Sonarr keeps them wanted and retries later.
- **Manage Series** (opened from the YouTube section on Admin → Connections) — per-series match review: confidence badges, candidate lists, paste-a-URL overrides, unmatch, re-run auto-match, and a "Search in Sonarr" button that re-grabs an episode after you correct its match. Failed downloads (deleted/private videos) mark the match as broken so Sonarr blocklists the release and the UI flags it.
- **Admin → Connections → YouTube (Tuberr)** — an enable/disable toggle gating the entire feature (search merge, request option, and series management), the YouTube Data API key, Tuberr address/key with a connection test, and step-by-step setup instructions behind an ⓘ icon, including one-click copy of the Tuberr API key for Sonarr's indexer. Saving pushes Sonarr credentials and the YouTube key to Tuberr automatically.
- **Self-managed yt-dlp** — Tuberr downloads the official standalone yt-dlp binary into its data dir on first start and self-updates it daily, so admins never install or update it (distro packages go stale and get rejected by YouTube). `YTDLP_PATH` overrides for anyone who prefers their own binary.
- **Hands-off new episodes** — every 6 hours Tuberr re-syncs each series' episode list from Sonarr and re-matches fresh channel uploads (manual corrections are never overwritten); newly matched episodes surface in the Torznab RSS feed, which Sonarr's RSS sync polls, so monitored series download new episodes automatically.

---

## v2.4.0 — 2026-07-04

A feature release introducing Diskovarr Wrapped — a Spotify-Wrapped-style yearly recap.

### Added

- **Diskovarr Wrapped** — a personal year-in-review for every user, presented as a story-style walkthrough: one stat per slide, paged through like Spotify Wrapped, each with its own share button. Each year's Wrapped unlocks December 1 and remains viewable afterward as an archive (a year picker lets you revisit past years). It's reached from the Wrapped button on your own profile, and during December a wide banner tile on the home page takes you straight there. Admins can preview the in-progress year at any time.
  - **Core stats** — total hours watched, plays, distinct titles, movie/show split, completion rate, and the oldest title you watched.
  - **Top movies & shows** — ranked by watch time with posters and play counts.
  - **Top genres** — a seconds-weighted genre mix from library metadata.
  - **Viewing patterns** — month-by-month watch-time chart, most active weekday and hour, biggest binge day, and longest consecutive-day streak.
  - **Percentile rankings** — "top X% of viewers on this server" and "top X% of fans" of your #1 show.
  - **Fun extras** — a "taste age" estimated from the era of what you actually watch, a "show buddy" (the user whose watch time on your #1 show is closest to yours), a **Diskovarr personality** (a genre-derived archetype like The Adventurer or The Thrill Seeker, with behavioral trait chips such as Night Owl, Marathoner and Completionist), and a **critic slide** for anyone who wrote reviews (count, average rating, favorite, harshest take, most-loved review).
  - **Your year on Diskovarr** — requests made, reviews written, average rating given, and reactions received.
  - **Server leaderboard** — everyone's hours and plays, with real usernames (no anonymization).
- **Wrapped stat sharing** — every stat section has a share button matching the review share flow: server-rendered share cards (standard and square variants) per category, native share/download/social targets. Cards are served from unguessable per-user links, so personal stats stay private until you choose to share them.
- **Wrapped playlist** — one click creates a "Diskovarr Wrapped {year}" playlist of your top movies and shows in your own Plex account; re-running it rebuilds the playlist instead of duplicating it.
- **Full watch-history backfill** — a new admin action pages through the entire Tautulli history (beyond the rolling sync window) so Wrapped has complete data on fresh installs.

### Accuracy

- Wrapped counts a play only if Tautulli marked it watched **or** the session ran at least 5 minutes **and** reached 20% completion — so accidental clicks and preview scrubs never inflate your stats (a common complaint with wrapperr-style recaps).
- Titles that were deleted and re-added to Plex (rating-key drift) are matched back to the current library item by title, so their watch time merges into one entry and posters render instead of showing a placeholder.

### Fixed

- **Editing a monitor no longer duplicates its criteria** — every save of an existing monitor was silently re-adding its whole criteria list, so criteria multiplied with each edit. Saving now replaces the criteria set in one step, removing a criterion in the editor actually persists, and any duplicates created by the old bug are cleaned up automatically on update.
- **Monitor criteria for keyword, language, and production company now match new Plex content** — these criterion types previously only ever fired for "available to request" matches because Plex metadata doesn't carry those fields. They're now filled in from cached TMDB details, so monitors like "Language: Japanese" notify on library additions too.
- **Deletion safety: re-added titles are no longer treated as never watched** — watch history stays keyed to the Plex id a title had when it was watched, so a deleted-and-re-added item looked brand new to deletion profiles and could be swept up by "never played" or "not played in X days" rules. Watch stats now fall back to matching by title (and year for movies), and an ambiguous match can only make an item look *more* watched — it can prevent a deletion, never cause one.
- **Deletion safety: watch-based profiles get a 14-day minimum age** — profiles using "never played", "not played in X days", or play-count criteria previously had no built-in protection for freshly added items, so new content could be deleted before anyone had a chance to watch it. If no "added less than X days ago" exclusion is set, a 14-day floor now applies (an explicit value you set always wins), and new profiles default the field to 14.
- **Show deletions no longer bypass Sonarr on a transient lookup failure** — if the TMDB lookup used to find a show in Sonarr failed momentarily, the deletion fell through to a raw Plex file delete that left Sonarr still monitoring (and re-downloading) the show. The deletion is now marked failed and retried on the next run instead.
- **Auto-request lists retry failed syncs sooner** — a list whose sync failed (source down, network blip) used to wait out its full sync interval (up to 24 hours) before trying again. Failed syncs now retry within about an hour, and the error still shows on the list until a sync succeeds.
- **Search suggestions dropdown gets its frosted glass back** — the nav search dropdown rendered inside the nav bar, whose own glass effect silently disables nested blur in Chromium-based browsers, leaving the dropdown looking almost transparent over artwork. It now renders alongside the notification dropdown outside the nav bar with the same smokey glass as the user menu.

---

## v2.3.3 — 2026-07-01

A patch release fixing real-time library detection and availability notifications, and relaxing review eligibility.

### Fixed

- **Real-time Plex detection** — newly added items are now detected the moment Plex finishes processing them. The live Plex event stream was silently discarding every library event (Plex delivers them one at a time, not as a list), so new content only appeared after the periodic library rescan. Requested titles are now marked available and join the library within seconds.
- **"Now available" notifications** — users are now notified when a title they requested is added to the library. A mismatch in how requests were matched against the library meant these notifications never fired from any library scan; approval/denial notifications were unaffected.
- **Admin Users page watched counts** — the "Watched" item count never updated. The per-user Plex watched lookup was silently failing (the Plex server rejects the stored user tokens with a 401), leaving only Tautulli data, which rarely moved the numbers. Watched syncs now also pull each user's watch history directly from the Plex server using the admin token (with the owner correctly mapped to Plex's internal account), and failed Plex lookups are logged instead of swallowed. Counts may jump once after updating as historical plays are counted for the first time.

### Changed

- **Review partially-watched movies** — a movie can now be reviewed from your watch history once you've watched more than 10% of it, instead of needing to be nearly finished. Shows are unchanged — any watched episode qualifies. History rows under 10% show a disabled Write Review button with a hint.

---

## v2.3.2 — 2026-06-15

A patch release fixing request-app routing.

### Fixed

- **Default request app honored** — the default app chosen in Admin → Connections (Overseerr, DUMB, or Sonarr/Radarr) was being overridden to DUMB whenever DUMB was enabled in pull mode. Pull-vs-push is only a delivery mode; it no longer forces the default. Your configured default is now always respected.
- **Alternate request app actually submits** — picking an alternate app from the Advanced option (Radarr, Sonarr, or Overseerr) was silently coerced to DUMB under pull mode, so the request never reached the chosen app. Explicit selections are now submitted to the app you picked.
- **Media-type-correct app list** — the request app options no longer offer services that can't handle the title: Radarr is hidden for shows and Sonarr is hidden for movies, both in the request dialog and the admin Edit Request dialog.
- **DUMB naming** — DUMB is now labeled "DUMB" instead of "Riven" wherever it appears as a request option.

---

## v2.3.1 — 2026-06-12

A patch release with UI fixes.

### Fixed

- **Theme color persistence** — the accent color no longer reverts to the default when you return to the app from the admin panel. The saved color is now applied before first paint (no flash), and the theme request is cache-busted so a stale cached response can't override a fresh change.
- **Notification dropdown** — was rendering nearly transparent; it now uses the same frosted-glass treatment as the user menu (it's rendered outside the nav so its blur samples the page correctly).
- **Settings page on mobile** — the section tabs now scroll horizontally instead of overflowing the viewport, and tab/section spacing is tuned for small screens. Desktop layout is unchanged.

---

## v2.3.0 — 2026-06-12

### Added

- **UI localization** — full interface translation for Spanish, French, German, and Portuguese. Users can select their language in settings; English remains the default.
- **Automation tab** — new admin panel tab for automating library management. Create rules to auto-request content by genre, rating, or keyword; maintain Plex collections on a schedule; and set up deletion profiles that clean up stale or unwatched requests automatically.

### Improved

- **Health endpoint** — new `/health` route for external monitoring, load balancers, and orchestrators to verify instance liveness.
- **Graceful shutdown** — the server now drains active connections and flushes pending writes before exiting, preventing data corruption on restarts and deployments.
- **Automated DB backups** — configurable scheduled backups of the SQLite database with retention policies to protect against data loss.

---

## v2.2.2 — 2026-06-11

A patch release with security hardening and internal code improvements.

### Security

- **Session cookies** — now marked `Secure` automatically when served over HTTPS (behind a reverse proxy), and API-key requests no longer create persistent admin sessions.
- **Poster proxy** — rejects path-traversal segments so only Plex `/library/` art paths can be fetched.
- **Rate limiting** — compute-heavy endpoints (recommendations, search, trailers, posters) are now rate limited, and a startup warning flags weak admin passwords.

### Fixed

- **Search and Requests races** — out-of-order responses can no longer overwrite newer results when changing filters mid-search or while recommendations are still building; also removed a duplicated similar-items fetch.
- **Legacy service worker** — v1-era clients still running the old service worker now automatically unregister it and clear stale caches.

### Improved

- **Performance** — Requests page rendering is significantly lighter (memoized carousel sections), new compound database indexes, and Plex device lookups are cached.
- **Code health** — duplicated helpers consolidated into shared utilities, dead files removed, and a Vitest test suite added (`npm test`).

---

## v2.2.1 — 2026-06-09

A patch release fixing three issues discovered after v2.2.0.

### Fixed

- **Queue page filters** — removed broken URL-based filter state that was causing the filter dropdown to reset unexpectedly.
- **Bulk delete requests** — fixed the transaction handling in `deleteRequestsByIds` and `deleteIssuesByIds` so bulk deletion of multiple requests/issues works correctly.
- **Plex SSE integration** — fixed Server-Sent Event message parsing to handle both the SSE eventsource endpoint and the WebSocket endpoint message shapes, restoring reliable real-time new-content detection.

---

## v2.2.0 — 2026-06-09

A major, feature-focused release centered on social discovery — user profiles, community reviews, shareable review images, ratings that sync with Plex, and personal content monitors.

### Added

- **User profiles** — each user now has a profile with a customizable bio, their reviews, and a personal watch history page.
- **Reviews & community** — a dedicated Reviews page with social interaction, plus reviews displayed on user profiles.
- **Shareable review images** — generate beautifully formatted review images and share them to popular social media and messaging platforms.
- **Most Popular on Server** — new sections on the Diskovarr page surface trending content within your own Plex ecosystem.
- **Cast & Crew tab** — the item details modal now has a Cast & Crew tab for exploring actors, directors, and production staff.
- **Ratings integration** — TMDB and Plex rating integration; ratings submitted in Diskovarr now sync back to Plex. New Connected Apps settings let users link their TMDB account.
- **User monitors** — create personalized monitors based on content criteria and get notified when newly available content matches your rules, using the existing notification infrastructure.
- **Synced library selection** — admins can choose which Plex libraries are synchronized into Diskovarr.
- **Expanded Filter page** — enhanced filtering capabilities and search refinement options.

### Changed

- **Watchlist & Blacklist** — moved from the user menu into user profiles for better organization.
- **Stale-content pruning** — improved cleanup so deleted or changed media is automatically removed and kept in sync.
- **About modal** — updated to highlight and explain recently added platform features.
- Various UI, usability, and quality-of-life improvements throughout the app.

---

## v2.0.0 — 2026-05-18

The React rewrite. The server-rendered EJS UI from v1.x is replaced with a modern React SPA served by the same Express backend. **Existing Docker users can upgrade with `docker compose pull && docker compose up -d` — all SQLite data, sessions, watch history, and admin settings are preserved.**

### Added

- **Broadcast notification editor** — rich-text editor with font-style options (bold, italic, strikethrough, inline code) and per-channel markdown stripping for Discord and Pushover delivery.
- **Queue and Issues — server-side search and filtering** — new API endpoints back searchable user filters and date-range filters across the entire result set, not just the visible page.
- **Plex SSE integration** — recently-added media is now detected via Plex Server-Sent Events, giving faster and more reliable new-content notifications. Complements the WebSocket sync introduced in v1.17.11.
- **Bulk-select on Queue and Issues** — themed checkboxes with bulk-delete actions.
- **DUMB/Riven torrent browser** — search any title, browse Torrentio results with Real-Debrid cache status, and inject a torrent directly into Riven from the admin panel.
- **Overseerr-compatible API expansion** — broader compatibility surface for Agregarr, DUMB, and Homarr (40+ new endpoints).
- **Personalized home hero** — greeting now renders your username in your accent color.

### Changed

- **UI architecture** — the entire user-facing UI is now a React SPA built with Vite (output: `dist/`) and served statically by Express. The legacy EJS templates and vanilla-JS frontend are removed.
- **Docker image layout** — the image is now built from the repository root with a multi-stage `Dockerfile` that builds the React frontend and bundles it into the server runtime. Image name, port, and data volume are unchanged (`lebbi/diskovarr`, `3232`, `/app/data`).

### Migration notes

- Existing Docker deployments: `docker compose pull && docker compose up -d`. No `.env` changes are required.
- `PLEX_SERVER_NAME` is now optional — the server name is auto-fetched from the Plex API. Leaving it in your existing `.env` is harmless.
- New **optional** env vars: `TMDB_API_KEY` (enables the Requests tab), `RIVEN_SETTINGS_PATH` (enables DUMB/Riven integration), `APP_URL` (Plex OAuth callback URL when running behind a reverse proxy). The app starts without them.
- First load after upgrade may take 30–120 seconds while the new `discover_pool_cache` table is populated. Subsequent loads are instant.
- The session cookie name changed to `diskovarr.react.sid`; some users may need to sign in once after the first upgrade.

---

## v1.17.12 — 2026-04-07

### Fixed

- **Nav menu alignment** — fixed desktop FAB menu positioning to properly align with the user button.

---

## v1.17.11 — 2026-04-01

### Added

- **Sign in to Plex button** — the Connections → Plex page now has a **Sign in to Plex** button. Clicking it opens a Plex OAuth flow and automatically retrieves and fills in your admin token, eliminating the need to manually locate it via Plex Web XML.

### Fixed

- **User settings persistence** — per-user settings (landing page, request limits, overrides) were not being carried over correctly in certain scenarios and are now reliably saved and applied.
- **Plex real-time sync — WebSocket** — the WebSocket connection for detecting new Plex library content is now fully fixed and operational. The Plex webhook integration has been removed; new-content detection runs entirely over the persistent WebSocket.

---

## v1.17.10 — 2026-03-29

### Changed

- **Recommendation engine — episode count weighting**: TV shows you've watched more of now score higher in recommendations. A show's weight gets a multiplier of up to ×2.0 based on episode count watched: `min(2.0, 1 + log₁₀(episodes watched))`. Short series watched in full (≥90% of total episodes) always receive the full ×2.0 signal regardless of episode count, so a 5-episode limited series watched completely is treated the same as a 10-episode season.

---

## v1.17.9 — 2026-03-24

### Added

- **Overseerr Compat API — new shim endpoints**: Added `GET /request/:id`, `GET /user/:id/requests`, `GET /user/:id/quota`, `GET /user/:id/watchlist`, `GET /status`, `GET /status/appdata`, `GET /media`, `GET /media/:id`, `GET/POST /settings/discover`, `GET /settings/plex`, `GET /settings/radarr`, `GET /settings/sonarr`, `GET /settings/about`, `GET /settings/jobs`, `POST /settings/jobs/:jobId/run`, and all standard notification settings stubs. Fills out the Overseerr API surface to prevent future compatibility gaps with DUMB, Agregarr, and Homarr.

### Changed

- **Unified Overseerr Compat API key** — replaced separate per-app DUMB and Agregarr API keys with a single shared key managed in Admin → General → Overseerr Compat API. The enable toggle and service accounts list moved from the Connections tab to General Settings. DUMB and Agregarr sections in Connections now show a Copy Key button that references the shared key. Legacy DUMB/Agregarr keys remain valid until Regenerate is used.
- **Agregarr removed from Connections tab** — Agregarr no longer has a dedicated section in Connections. Configuration (enable toggle, key, service accounts) is now entirely in Admin → General → Overseerr Compat API.
- **Regenerate compat key invalidates legacy keys** — clicking Regenerate in the Overseerr Compat API section now also disables any old DUMB- or Agregarr-type app entries, so there is only ever one valid key after regeneration.
- **Generate/Regenerate button state** — both the Diskovarr API Key and Overseerr Compat Key buttons now read "Generate Key" when no key exists and "Regenerate Key" (styled red) once one is set.
- **Overseerr shim — availability status** — `GET /api/v1/request` now returns `media.status=5` (Available) for requests whose content is already in the Plex library, instead of always returning 3 (Processing). Homarr's media-requests-list widget now correctly shows availability.
- **Overseerr shim — request count breakdown** — `GET /api/v1/request/count` now includes `movie` and `tv` counts in addition to `pending`, `approved`, `declined`, and `total`.
- **Copy icon fix** — the copy button on API key fields now shows a clipboard icon instead of the eye/reveal icon.
- **Documentation site updated** — diskovarr.com guide updated to reflect unified compat key, new Agregarr setup flow (Admin → General), DUMB bridge instructions updated, reverse proxy setup sections removed from installation guides, and all "Riven/DUMB" references changed to "DUMB/Riven".

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
