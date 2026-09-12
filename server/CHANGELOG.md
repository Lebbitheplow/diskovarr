# Changelog

All notable changes are documented here. Versioning follows [Semantic Versioning](https://semver.org/).

---

## v3.1.1 — 2026-09-12

### Added

- **Collection manager parity with Agregarr.** Monitored lists (Admin → Automation → Auto Request) now carry everything Agregarr's collection configs did, so an Agregarr setup can move over wholesale (`scripts/import-agregarr.cjs settings.json --apply` maps every collection config, global exclusion, hub layout and credential; migration `automation_collections_v2` rebuilds `list_sources` without the old visibility CHECK). Per list: `max_items` (top-N of the source, also caps requests), `season_mode` (`all`/`first`/`latest` seasons on TV auto-requests), per-list `exclusions_json` plus a global exclusion list (`autorequest_exclusions` setting, `GET/POST /admin/automation/exclusions`), multi-URL sources (one URL per line, concatenated in order — Agregarr's multi-source "list order"), `collection_unwatched_only` (a label-keyed Plex smart collection filtered on `unwatched`/`show.unwatchedLeaves` so every viewer sees only what they haven't finished — `server/services/plexLabels.js` keeps the `diskovarr-list-<id>` label in step with the list), `collection_sort` (list order, release date, title, date added, rating; regular collections get `collectionSort=2` and are physically arranged with `items/{key}/move?after=`), `home_order` and `library_order` (the latter via the Agregarr-compatible `!` sort-title prefix), `owner_home` visibility, and an optional collection summary. Pure decision logic lives in `server/services/collectionPolicy.js` (`tests/collections.test.js`).
- **Plex home layout** (`server/services/plexHubs.js`, Automation → Home Layout). Every hub Plex manages per library — built-ins like Recently Added plus promoted collections — with its owner-home / users'-home / Recommended flags and order, applied with `PUT /hubs/sections/{id}/manage/{hub}` and `…/move?after=`; built-in hubs persist in the `plex_hub_layout` setting, collections write back to their list. Re-applied after every promoted list sync and on demand (`POST /admin/automation/hubs/apply`).
- **New list sources.** FlixPatrol streaming top 10s (`server/services/listSources/flixpatrol.js`: Netflix, HBO Max, Disney+, Paramount+, Prime Video, Apple TV+ from the global page; Hulu and Peacock from the US page) fetched through FlareSolverr (`flaresolverr_url` setting, default `http://localhost:8191`) to pass FlixPatrol's Cloudflare check; TMDB trending (day/week) presets; AniList's popularity chart with AniList→TMDB/TVDB ids from the Fribb anime-lists index (title search fallback); Hulu/Paramount+ TMDB watch-provider presets. Untyped chart rows resolve through `/search/multi`.
- **Collections quick sync.** `list_source_items.position` records source order, and `autoRequest.runQuickSync()` (every 30 min, or Automation → Quick sync) rebuilds collections from the cached items so newly added library titles join their collections without re-fetching any source.

### Fixed

- Recommender review-rating and request→library maps were keyed by bare TMDB id; they are now keyed by media type too (movie 121 is The Two Towers, tv 121 is Doctor Who 1963). This closes the last type-blind lookups behind the August notification that showed Lord of the Rings art for a Doctor Who issue; the poster path itself was fixed in 2.5.5.
- The auto-request job required the Overseerr shim from `services/` instead of `routes/`, so every monitored-list sync failed with "Cannot find module './overseerrShim'" before it could request or mirror anything.
- nodemailer 9.0.5 → 9.1.0 (Snyk PR #15: SNYK-JS-NODEMAILER-19651818 / -19651822 / -19652370).
- "Request missing seasons" on search cards and in the detail window is now shown only once `/search/seasons` confirms the show has a season that is neither complete nor already requested (`src/hooks/useMissingSeasons.js`, memoised per show and invalidated after a request is submitted).

---

## v3.1.0 — 2026-09-06

### Added

- **Request missing seasons.** `GET /api/search/seasons` now takes an optional `ratingKey` and returns per-season `details` (TMDB episode count, library episode count from Plex `/library/metadata/:key/children` or Jellyfin `/Shows/:id/Seasons`, `complete`, `requested`, `selectable`) alongside the plain `seasons` list. Merge logic lives in `server/services/seasonAvailability.js` (pure, tested in `tests/seasonAvailability.test.js`); `normalizeTV` now caches `seasonDetails`. `RequestModal` grays out complete/requested seasons, treats "All" as "All missing" when anything is blocked, and always submits an explicit season list for library shows. `DetailModal` shows **Request missing seasons** for library shows on every page (rendering its own `RequestModal` through a portal where the page has no `onRequest`), and Search cards get a **Request missing** button.
- **Sonarr: series already present.** `submitRequestToService` no longer fails when `POST /api/v3/series` rejects a duplicate: it fetches the existing series by `tvdbId`, monitors the requested seasons (`PUT /series/:id`), and queues `SeasonSearch`/`SeriesSearch` commands. The YouTube-tag re-use path is folded into the same branch.

### Changed

- **Search responds before enrichment.** The text-search pool is built from cached TMDB details where present and lightweight `/search/multi` entries otherwise (`server/services/searchCandidates.js`, tested in `tests/searchCandidates.test.js`); placeholders are upgraded in place by a background pass (`kickEnrichment`) so later pages and filter passes see full data. Results carry `enriched` and `backdropUrl`; `DetailModal` back-fills credits/studio/genres from `/search/details` for un-enriched items. The Sonarr TVDB lookup gets a 1.5 s budget (`SONARR_LOOKUP_BUDGET_MS`) and late hits merge into the cached pool. `/search/similar` batches uncached detail fetches through `batchGetDetails` instead of a serial loop.
- **Express 5** (`server` and `tuberr`, closes Snyk SNYK-JS-QS-19432019 / SNYK-JS-QS-19432017 via `qs` 6.16). Route syntax updated for path-to-regexp 8: `app.get('/{*splat}')` SPA fallback, `router.all('/tuberr/*splat')`, and inline regex constraints (`:id(\\d+)`, `:slug([0-9a-f]{16})`, `:year(\\d+)`) replaced by handler-side validation in `routes/og.js` and `routes/wrapped.js`. `app.set('query parser', 'extended')` keeps the v4 `req.query` shape; handlers that read `req.body` on possibly body-less requests now default to `{}` (`routes/auth.js`, `routes/riven.js`, `tuberr/routes/qbit.js`).

### Fixed

- Missing-season requests for a show already in the library are stamped `notified_available_at` on creation, so the show-level fulfillment check no longer fires an immediate "now available" notification. (Queue status is still per show, so such requests display as Available.)

---

## v3.0.1 — 2026-09-02

### Added

- **Cast from the home spotlight.** `SpotlightHero` now drives the shared `useCastPlayer` hook: the former inline "Play" button (`spotlight-btn-play`) is a Cast control that opens a device picker (`spotlight-cast-picker`) and issues the same cast the detail modal already offered. It is gated behind `canCast(item)` and shows per-device "Casting…" state.
- **Jellyfin parity with Plex.** Cast/play on Jellyfin via a new `server/services/jellyfin/sessions.js` (`GET /Sessions?ControllableByUserId=`, `POST /Sessions/{id}/Playing?PlayCommand=PlayNow`); `/api/clients` and `/api/cast` branch on item/active source. Jellyfin deletion in the cleanup automation (`DELETE /Items/{id}` + `POST /Library/Refresh`), list→collection mirroring via `server/services/jellyfin/collections.js` (BoxSets), Wrapped playlists via `server/services/jellyfin/playlists.js`, real per-play watch history from the websocket `PlaybackStopped` stream (real duration/percent instead of one row per item), BoxSet/Tag/last-episode enrichment on items, realtime adds by id (`ItemsAdded` → `upsertItemsByIds`), a Jellyfin `/settings/jellyfin` shim stub, per-source library counts and `plexSse`/`jellyfinWs` flags on `/admin/status`, and `DELETE /api/user/link/plex` to unlink a Plex account from a Jellyfin identity (`ConnectedAccounts.jsx`). New tests: `tests/jellyfin*.test.js`, `tests/canonicalUser.test.js`.
- **YouTube (Tuberr) admin tab.** The old Manage-Series modal is promoted to a YouTube tab (`YoutubeMappings.jsx`): health strip, download queue with progress, failures with reasons, unmatched-episode counts, and per-series last-video/last-grab. The child process's stdout/stderr are piped through Diskovarr's logger with a `[tuberr]` prefix and kept in a ring buffer (`GET /admin/tuberr/logs`).
- **YouTube downloader health monitoring + alerts.** `server/services/tuberrHealth.js` polls `/manage/health` and `/manage/status` every ten minutes and raises admin notifications on state transitions: unreachable > 15 min, refresh failing > 12 h, download failures, YouTube quota exhaustion, and "Sign in to confirm you're not a bot" (expired cookies). Sonarr wiring is re-validated idempotently on enable and on the health job.
- **`tuberr_alert` reaches every notification agent.** `tuberr_alert` is now a first-class type in `server/services/notificationAgents/types.js` (`TYPE_MAP`/`TYPE_LABELS`/`TYPE_TARGET`/`TYPE_COLORS`), and `tuberrHealth.notifyAdmins()` fans out to every active agent (`manager.getActiveAgents()`) instead of a hardcoded Discord+Pushover pair. Each agent still self-filters on its "YouTube downloader alerts" toggle; the in-app bell fires unconditionally. WebPush has no per-type filter by design, so it relays whenever enabled.

### Changed

- **Any TV show can be requested "from YouTube."** `isYoutubeItem` no longer requires a TVDB-only show; "Download from YouTube" is offered as a downloader choice for any TV item when Tuberr is enabled (`RequestModal.jsx`, `server/routes/api.js`), keeping the channel picker.
- **Matcher quality.** `tuberr/lib/matcher.js` splits video titles on separators and scores segments (exact segment = 1.0), strips series acronyms and parenthetical platform tags, allows containment for unique long single-token titles, treats absolute episode numbers as neutral rather than zeroing the number signal, penalizes trailer/teaser/clip tokens, normalizes `#07`↔`#7`, and lets a strongly-dated sole candidate carry a generic-titled episode. Regression cases added to `tests/tuberr.test.js`.
- **Dead-mapping and per-episode states.** `series_mappings` gains `paused`/`unavailable` and per-episode `skipped` (with reason); a mapping is auto-flagged after three consecutive zero-progress refreshes and skipped in refresh/RSS (`tuberr/lib/state.js`, `scheduler.js`), reactivated from the YouTube tab. The uploads pool cap is raised (5000) with a weekly full rebuild plus an incremental first-page poll, and playlist ids are settable from the mapping editor.
- **YouTube episode metadata.** `tuberr/lib/downloader.js` embeds metadata and thumbnail and writes a Kodi-style `.nfo` per file (`tuberr/lib/nfo.js`), so Plex/Jellyfin stop rendering "Episode N".
- **Backups include Tuberr.** The nightly rotation (`server/server.js`) now also copies `tuberr/data/tuberr.db`, `cookies.txt`, and `api_key.txt`.

### Fixed

- **YouTube requests never turned "available."** Fulfillment matched `discover_requests.tmdb_id` against `library_items.tmdb_id`, but YouTube requests have `tmdb_id = 0` and a `tvdb_id`; matching now also uses `tvdb_id` (`server/db/database.js`), so a fully-imported YouTube show flips to Available.
- **Completed YouTube downloads were never cleaned up** (211 GB of staging leftovers observed). The qbit shim now reports seed limits reached (`ratio_limit: 0`, `seeding_time_limit: 0`) so Sonarr removes each imported item, and a Tuberr janitor (`tuberr/lib/janitor.js`) deletes imported `completed` rows/files by cross-checking Sonarr's `downloadFolderImported` history.
- **Cast/Play button showed for un-castable items and accounts.** The control is gated on `user.isPlexLinked` and a numeric rating key across `useCastPlayer.js`, `DetailModal.jsx`, and `SpotlightHero.jsx`; the Wrapped-playlist button is hidden for Jellyfin-only users until Jellyfin playlists apply. Overseerr-shim user/issue lookups no longer drop or mis-hash `jf_` ids.
- Failed YouTube downloads can no longer dead-lock on Sonarr's blocklist (per-retry infohash + blocklist cleanup), and transient download errors retry with backoff before being marked broken.

---

## v3.0.0 — 2026-09-02

### Added

- **Recommendation engine v2 — signed affinity.** Per-category affinities are now signed log-ratios of the user's share against the library baseline (`a_c = clamp(log2((u_c + α) / (b_c + α)), ±3)`), so a category the user demonstrably avoids pushes candidates *down* instead of merely not helping. Negative affinity feeds a multiplicative dampener with a floor (so one bad tag can't zero an otherwise strong match), dismissals nudge their categories negative with a bounded total effect, and actor scores scale with genre-context overlap so a liked actor in an unliked genre counts less. Cold users (under 20 watched items) get no negative affinities at all. Every knob lives in one place — `server/services/recommend/constants.js` — with a scratch-DB tuning workflow documented at the top of the file (`scripts/rec-debug.cjs`), and the scoring core is covered by new unit tests (`tests/affinity.test.js`, `tests/recommenderScoring.test.js`, `tests/tasteProfile.test.js`). Admins can inspect any user's score breakdowns with `?debug=1`.
- **Taste profile quiz** (`src/components/TasteQuiz/`) — a four-step quiz (genres, moods, people, titles) reachable from Settings → Taste Profile. "Love" answers floor a category's affinity, "avoid" answers cap it below the normal clamp and lower the dampener's hard floor, so explicit taste beats inferred taste in both directions.
- **Real-time Jellyfin library detection** (`server/services/jellyfin/socket.js`) — Diskovarr now listens on Jellyfin's native websocket (`/socket?api_key=…`, answering the ForceKeepAlive protocol, reconnecting with backoff), the analog of the Plex notification stream. `LibraryChanged` events trigger a debounced `pollNewItems()`, so fulfilled requests flip to available in seconds instead of up to ten minutes; the 10-minute poll and 6-hour resync remain as fallbacks. The admin connections save hook starts/stops/reconnects the socket to match the settings.
- **Search click signals** — opening a search suggestion or result records the query→title pair (`POST /api/search/click` → `user_search_history`) as an interest signal for the recommender.

### Changed

- **Search is much faster.** TMDB result pages are fetched in parallel (page 1 establishes the count, the rest arrive together), and detail hydration goes through a bounded 8-way worker pool instead of serial fetches with 150 ms delays — a cold-cache search no longer serializes dozens of round-trips. The Sonarr lookup used by YouTube search is failure-tolerant and only runs when the integration is enabled.
- **Jellyfin libraries are first-class in the admin panel.** `GET /admin/sync/libraries` now includes Jellyfin folders (`source` field, item counts, last-sync, per-folder enable/disable that `resyncAll()`/`pollNewItems()` honor); the save path merge-preserves sections the caller didn't post instead of silently dropping them, and disabling a never-toggled Jellyfin folder still deletes its data. "Sync Library Now" resyncs both servers, per-user "Re-sync Watched" works for `jf_` users (and refreshes a Plex user's linked Jellyfin account), dashboard sync timestamps are computed across all sections rather than hardcoded Plex section ids, and the users table exposes `auth_provider`/`linked_user_id` with a Jellyfin/linked badge in the UI.
- **Env-var Jellyfin configuration works as documented** — `JELLYFIN_URL` + `JELLYFIN_API_KEY` enable the integration when the admin toggle was never set in the DB, and the admin connections form falls back to the env values instead of rendering empty.
- **Monitors treat Jellyfin adds as library adds** — post-resync and new-item-poll evaluation fire for Jellyfin items, deduped against the Plex path so a title added on both servers notifies once; the notification wording says "added to the library".

### Fixed

- **Jellyfin favorites no longer flap for linked accounts.** The plex.tv watchlist reconciler deleted every `source='jellyfin'` watchlist row on each sync (they're never in its keep-set) only for the 15-minute favorites sync to re-add them; it now reconciles only Plex-sourced rows.
- **Deletion automation can no longer touch Jellyfin items.** Candidates exclude `jf_` sections and non-Plex rows (their Tautulli-based play stats made them look permanently unwatched, i.e. maximally deletion-eligible), `deleteItem()` refuses non-Plex items outright, and trash-empty skips `jf_` sections.
- **Explore filters and no-TMDB search cover the Jellyfin library** — facet/genre/decade dropdowns follow the active source (matching the browse pool), and the library-only search fallback spans both servers.
- **Shared review cards and Wrapped render Jellyfin artwork** — `cardKit.fetchAsDataUri` resolves `/Items/…` posters and `/api/jellyfin/avatar/…` paths against the Jellyfin origin, and the Wrapped `posterSrc` helper proxies Jellyfin thumbs like Plex ones.
- **Admin panel header restored.** The five `.nav` rules the admin top bar depends on were removed from `style.css` in 2.7.0 along with `NavigationBar`, leaving the wordmark, "← App" and "Sign out" stacked in a corner; they now live in `admin.css`, whose only consumer is `AdminNav`.
- `ConnectionSettings.jsx` contained three literal NUL bytes (an escaped `\0` written as the raw byte), which made grep-based tooling treat the file as binary and skip it; account merges now also re-key `notification_queue`; two Jellyfin UI strings gained translations in all four locales.

---

## v2.7.1 — 2026-09-01

### Fixed

- **Tapping a card on touch devices could dismiss it.** The `.card:hover`/`:focus-within` rule that reveals the action row was not gated behind `@media (hover: hover) and (pointer: fine)`, so a tap applied sticky `:hover`, expanded the row (and re-enabled its `pointer-events`), and — because the card's stack is bottom-anchored and grows upward — put the Not Interested button under the finger that was aiming at the poster. The reveal is now pointer-only; touch users reach the same actions through the detail modal.
- **"Not interested" is recoverable.** Dismissals now surface an Undo action on the toast rather than a blocking confirm, since `DELETE /api/dismiss` and the explore blacklist removal already existed. `utils/listRestore.js` records the item's index in each affected list before removal and splices it back on undo — restoring a whole pre-dismiss snapshot would have resurrected anything else dismissed in the meantime. `ToastContext` gained optional action support (9s timeout, click-through suppressed so the toast body's dismiss handler can't swallow it).
- **Back closes the detail modal.** `DetailModal` pushes a history entry on open and closes on `popstate`; closing by any other route calls `history.back()`, so both paths converge on one close. Previously Android's back gesture navigated away from the page with the modal still mounted.

### Changed

- **The mobile FAB is now a menu button in the top bar.** A floating avatar in the bottom-right that opened a left-hand drawer was a mismatched affordance. It is replaced by a `☰` at the top-left — the same glyph and the same action as the desktop rail's toggle, so one control means "show/hide navigation" at every width. The avatar remains in the drawer's user block. The `.nav-fab*` rules it used are removed; `.nav-fab-menu-*` (the user menu) is unaffected.

---

## v2.7.0 — 2026-09-01

### Added

- **Collapsible navigation rail** — the sticky top navigation bar is replaced by a persistent left rail (`SideRail.jsx`), which collapses between 224px and 64px with the state persisted to `localStorage`. It carries every destination, including the five that previously lived only in the avatar popup (Queue, Watch History, Issues, Settings, Admin). At ≤960px it becomes an off-canvas drawer behind a scrim with body-scroll lock, opened by the existing FAB. Search, the Plex/Jellyfin source toggle and the notification bell move to a new sticky `TopBar.jsx` that frosts once the page scrolls. `NavigationBar.jsx` is gone; its notification and typeahead logic was extracted verbatim into `hooks/useNotifications.js` and `hooks/useNavSearch.js`, and `AppShell.jsx` now owns the chrome.
- **Home spotlight hero** (`HomeHero.jsx`) — the top recommendation leads the page as full-bleed key art with a slow ken-burns drift, rating, year, genres, runtime, certification, synopsis, the recommendation reason, and Play / Watchlist / Details actions. It costs no extra request: `/api/recommendations` items already carry `art`, `summary`, `genres`, `duration` and `deepLink`. Titles with no landscape art fall back to their poster, blurred and scaled.
- **Shared-element poster transition** — clicking a poster morphs it into the detail modal's poster via the View Transitions API (`utils/viewTransition.js`). React Router's `viewTransition` prop needs Data/Framework mode, so `document.startViewTransition` is driven directly. Degrades to a plain state update where the API is absent or `prefers-reduced-motion` is set.
- **Scroll-reveal shelves** (`hooks/useShellMotion.js`) — shelves animate in as they enter the viewport instead of every shelf burning its entrance animation on mount. The opacity gate is scoped to a `data-motion` flag that only JS sets, so content is never left invisible if the observer does not run.

### Changed

- **Cards are now 2:3 tiles with an overlaid info panel** — title, year and rating sit over the artwork, with recommendation reasons revealed on hover. The poster button, action row and info panel are siblings in a bottom-anchored flex stack, so revealing the actions grows the stack upward rather than covering the title. Carousels keep their two-row column flow at 172px.
- **Site-wide surface pass** — Bricolage Grotesque for display headings, frosted sticky shelf headers, panelled Settings/Reviews/Queue surfaces over the ambient background, unified pill press states, and `focus-visible` accent rings. New tokens (`--rail-w`, `--topbar-h`, `--font-display`, `--dur-slow`, `--ease-emphasized`, a z-index scale, and `color-mix`-derived accent tints) mean a server owner's custom accent still drives everything with no change to `ThemeContext` or `/theme.css`.
- **Navigation is client-side** — the rail, top bar and user menu use `<Link>`, so moving between pages no longer reloads the application. Scroll reset on path change and a short route enter animation are reintroduced explicitly; the route wrapper toggles a class rather than being keyed on pathname, which would remount each page and refetch its data.
- **Only one blur layer is composited at a time** — sticky shelf headers frost only while actually pinned, detected with an `IntersectionObserver` that requires `isIntersecting` as well as a sub-1 ratio (without it every shelf below the fold counts as pinned). Card info panels use a gradient scrim rather than `backdrop-filter`, keeping dozens of cards off the blur budget.

- **Spotlight hero on Explore, and rotation on both** — `HomeHero` became `SpotlightHero`, shared by Home and Explore. It cycles up to five top picks on a 7s interval, pausing on hover, on focus-within, and on `visibilitychange`, and not starting at all under `prefers-reduced-motion`. Every slide's artwork stays mounted so advancing never re-fetches an image; the slide transform and the ken-burns zoom live on separate nested elements so they don't fight. Which actions render is derived from the item rather than a variant flag — a library row has `deepLink`/`ratingKey` so it offers Play and Watchlist, an Explore row has neither and offers Request/Notify.
- **Privacy notice** (`/privacy`) — a public route, readable signed-out and linked from the footer, documenting what is stored, the third parties involved, what other members can see, cookie use, retention, and how to exercise data rights through the server administrator.

### Fixed

- **Per-user email notifications could never fire.** `emailAgent` read `user.email` off the `known_users` record, which has no `email` column, so the send condition was always false. Users now enter a delivery address in **Settings → Notifications → Email**, stored in a new `user_notification_prefs.email_address` column (additive migration). The address is validated for shape and length server-side — the pattern rejects whitespace and `<>,;:"`, which also keeps header-injection shapes out of the mailer — and is deliberately not harvested from the Plex or Jellyfin account.
- **Saving one notification channel reset the others.** `setUserNotificationPrefs` writes `telegram_*`, `pushbullet_*`, `pushover_application_token`, `pushover_sound`, `email_enabled` and `pgp_key`, but `POST /api/user/settings` never destructured or forwarded them, so every save rewrote them to null/0. The route now reads and preserves each one.
- **Trailers embed via `youtube-nocookie.com`** rather than `youtube.com`, so YouTube's tracking cookies are not set unless the video is played.
- **The home page "Show mature content" switch had no effect on most of the page** — Top Picks, Movies, TV Shows and Anime filtered R / TV-MA content unconditionally, so only the two Most Popular rows responded to the toggle. All four are now gated on the setting.
- **Esc closes the detail modal**, routed through the existing close handler so the trailer iframe is torn down rather than left playing.
- **An expired session now returns you to the sign-in page.** A 401 from the main API instance clears the user in `AuthContext`, letting `ProtectedRoute` redirect; the admin and auth axios instances are untouched, so an admin-only 401 cannot sign a user out, and public review links still render signed-out.
- **Invalid nested buttons removed from every card** — the action buttons were descendants of the poster `<button>`, which React reported as a DOM nesting error on each card. `Search.jsx` had four byte-identical copies of the card markup; they are now one `SearchCard` component.
- **Carousel card widths were inconsistent** — `.carousel-wrap .card-grid` inherited the base grid's explicit `grid-template-columns`, so the first screenful of cards took its width from that and only overflow columns used `grid-auto-columns`. Inline styles on the carousel also silently overrode the ≤600px rule that narrows cards for phones.
- **Hidden card action buttons could swallow clicks** — the hover overlay was click-through at `opacity: 0`; `pointer-events` is now gated with the reveal.

---

## v2.6.0 — 2026-08-31

### Added

- **Jellyfin Media Server support** — Diskovarr is no longer Plex-only. Configure a Jellyfin server under **Admin → Connections → Jellyfin** (URL, API key, enable toggle) and its libraries sync into the same `library_items` table Plex uses, tagged with a new `source` column (`plex` | `jellyfin`). Jellyfin items key on the Item GUID, so they can never collide with Plex's numeric rating keys. A full library re-sync runs every 6 hours with a light new-item poll every 10 minutes for request fulfillment (`server/services/jellyfin/`).
- **Sign in with Jellyfin** — the login page now offers a Jellyfin username/password form alongside the Plex OAuth button, showing only the providers the server actually has configured (`GET /auth/providers`). Jellyfin authenticates against the configured server via `AuthenticateByName`; credential logins are rate-limited to 20 attempts per 15 minutes per IP. Standalone Jellyfin identities are stored as `jf_<guid>`.
- **Plex ↔ Jellyfin account linking** — a new **Media Server Accounts** card in Settings links the two accounts in either direction: a Plex user links Jellyfin with username/password, and a Jellyfin user links Plex through the normal PIN flow. Once linked, signing in with either account signs you into the same Diskovarr profile — the Plex identity is canonical, and the Jellyfin account's watch history, watchlist, ratings and reviews are merged into it.
- **Library source toggle** — when both servers are configured, a **Plex / Jellyfin** switch appears in the navigation bar. Recommendations, popular rows, search, and in-library availability all follow the selected source; the choice persists per user (`preferred_source`) and across sessions. The toggle only renders when there is more than one source.
- **Jellyfin watch data without Tautulli** — Jellyfin tracks played state, play counts, and last-played dates natively, so the admin API key mirrors every user's data into `watch_history`, `user_watched`, and `user_ratings` every 15 minutes — the Jellyfin equivalent of the Tautulli sync. Jellyfin **Favorites** double as the watchlist (Jellyfin has no native watchlist), and review ratings sync back as likes/favorites.

### Changed

- **Recommendations now blend both servers** — preference profiles are built from the union of Tautulli (Plex) and mirrored Jellyfin plays, so a linked account's Plex history informs its Jellyfin recommendations and vice versa. Pools are built and cached over both libraries, with source filtering applied at sample time so flipping the nav toggle never forces a rebuild. Plex fetches now degrade to empty instead of throwing, so Jellyfin-only deployments work with no Plex server at all.
- **Tuberr is now supervised by Diskovarr** — the bundled YouTube downloader runs as a child process of the Diskovarr server (`server/services/tuberrProcess.js`) instead of needing its own systemd unit. It starts when the YouTube integration is enabled, stops when it's disabled, restarts with exponential backoff (5s → 60s, reset after a clean minute of uptime) if it crashes, and shuts down cleanly with the server. Process management is skipped when `TUBERR_URL` is set (the Docker image's entrypoint runs its own Tuberr) or `TUBERR_MANAGED=0`. Bare-metal users running the sample `tuberr.service` unit should disable it to avoid two instances competing for port 9832.
- **Posters and avatars proxy through the server for Jellyfin too** — the existing poster proxy now accepts Jellyfin `/Items/<id>/Images/…` paths (with the same traversal and SSRF guards as the Plex `/library/` paths), and a new `/api/jellyfin/avatar/:jfUserId` endpoint proxies user avatars, so a LAN-only Jellyfin origin is never exposed to the browser.
- **App descriptions cover both servers** — the login page, About modal, footer, page metadata, and README no longer describe Diskovarr as Plex-only. Plex-specific features (casting, the Plex.tv Watchlist, Plex collections, ratings sync) are still described as Plex-specific.

---

## v2.5.8 — 2026-08-22

### Security

- **Snyk security patches** across the frontend and server dependencies.
- **nodemailer upgraded 8.x → 9.x** — resolves a security advisory in the SMTP mailer. The transporter is created with the same host/port/secure/auth/TLS options as before (`server/services/emailAgent.js`), so existing email notification setups keep working unchanged.
- **Transitive dependency fixes** — `path-to-regexp` (Express routing ReDoS, GHSA-37ch-88jc-xwx2), PostCSS source-map path traversal, `nanoid`, and the Vite/Babel build toolchain were patched via lockfile updates within their existing semver ranges (build-time devDependencies; not shipped in the served bundle).

---

## v2.5.7 — 2026-08-21

### Added

- **Request-app filter on the queue** — a new **App** filter lets admins narrow the request queue to requests routed to a specific app (Sonarr, Radarr, Overseerr, DUMB, or YouTube). A **Default** option captures requests that carry no explicit app because it's resolved to a concrete service at approval time. Backed by a `service` query param on `GET /api/queue` and a shared `appendServiceClause` WHERE fragment in the request queries (YouTube-downloader rows are matched by `downloader` so they stay in their own bucket).
- **Auto-search for missing seasons/episodes** — the issue report form for shows gained a **"This content is missing"** checkbox (shown for season/episode scope). When ticked, submitting the issue queues a search for that season/episode in the admin's **default request app**. For a series already in Sonarr the search runs in place (`SeasonSearch` / `EpisodeSearch`, monitoring the affected season/episode first); a series not yet in Sonarr, or a non-Sonarr default app, falls back to a normal season-level request submission.

### Changed

- **Missing-content searches follow the approval workflow** — the auto-search only fires when the reporter's requests auto-approve. Otherwise the issue is held with `search_status = needs_admin` and a **Search now** button appears for admins (also used to retry after a failed search) via the new `POST /api/issues/:id/search` endpoint. New `is_missing` and `search_status` columns were added to the `issues` table.

---

## v2.5.6 — 2026-08-19

### Security

- **Snyk security patches** across the frontend, server, and Docker base image.

---

## v2.5.5 — 2026-08-11

### Fixed

- **Library items now use separate `movie_id` and `tv_id` columns** — previously a single shared `id` field was used for both movies and TV shows, which caused a show to be misregistered in the library if it happened to share the same id value as a movie in a different context. The new schema distinguishes the two, so each is always correctly identified by type.
- **Last sync date on libraries in the admin panel** — the timestamp was broken and no longer reflected the actual sync time; it now correctly shows when each library was last synced.
- **Periodic reconciliation now includes all libraries** — previously some libraries were skipped during the reconciliation process; all configured libraries are now reconciled on each cycle.

---

## v2.5.4 — 2026-07-12

### Added

- **Cast heads-up for non-Chrome browsers** — opening the cast device menu in a browser without Local Network Access support (anything not Chromium-based: Firefox, Safari, iPhone/iPad browsers) shows a once-per-session toast explaining that casting needs local network access and works best in Chrome or Edge (`isChromiumBrowser()` in `src/utils/castPlayer.js`, preferring `navigator.userAgentData` brands with a UA-string fallback).

### Fixed

- **YouTube requests no longer show a downloader picker** — the request dialog dropped the manual Torrent/YouTube toggle, which previously appeared on any TV request whenever Tuberr was enabled. YouTube-sourced shows (TVDB-only items — how YouTube series enter search results) now default straight to the YouTube downloader and open directly into channel selection, with "Sonarr (Torrent)" as an alternate option; regular TMDB shows never see the YouTube option at all.

---

## v2.5.3 — 2026-07-06

### Added

- **Cast to Plex from anywhere** — casting now works for users outside the server's household. The playback command is delivered from the user's browser (which shares a Wi-Fi network with their TV) instead of from the server, which can never reach a player inside another home's network. A new `POST /api/cast/prepare` endpoint creates the PlayQueue and returns the player's connection candidates plus ready-made playMedia params; the browser sends the companion command directly (`src/utils/castPlayer.js`, all X-Plex headers as query params so the request needs no CORS preflight). Chromium 142+ asks once for local-network access (`targetAddressSpace: 'local'` exempts the players' http-only endpoints from mixed-content blocking); Firefox and iPhone/iPad browsers still block browser→LAN requests and get a clear message instead of a timeout. Server-side delivery remains as an automatic fallback for players on the server's own LAN.

### Fixed

- **Remote players can actually stream what you cast** — playMedia previously handed players the server's LAN address parsed from `PLEX_URL`, which TVs outside that network can't reach. Players now get the PMS's public `*.plex.direct` hostname with `protocol=https`, resolved from plex.tv resources (skipping unroutable IPv6 ULA entries that plex.tv lists as remote connections).
- **No more raw "The operation was aborted due to timeout"** — cast failures now explain what happened (device not on the same Wi-Fi, device refused the command, device doesn't accept remote playback commands) instead of leaking transport errors into the toast, and cast logic moved out of the routes file into `server/services/plexCast.js` with unit coverage.
- **Casting shows progress** — the device button displays a "Casting…" in-flight state, commandID increments per command as the Companion protocol expects, and the whole cast path uses one consistent client identifier so players correlate commands correctly.

---

## v2.5.2 — 2026-07-05

### Fixed

- **Sonarr-tagged series pick up fast** — discovery of `yt`-tagged series and channel auto-detection moved to their own 15-minute loop (two cheap Sonarr calls when idle) instead of riding the 6-hour refresh, so tagging a series in Sonarr gets it into Tuberr within minutes.
- **Missing monitored episodes download automatically** — after every match run, Tuberr asks Sonarr to search all episodes that are matched, monitored, and missing. Sonarr's RSS sync only covers newly published releases and it never searches back-catalog on its own, so matched series previously sat idle until a manual search. Manual match corrections in Manage Series also trigger an immediate search.
- **RSS feed no longer starves newer series** — the feed now returns the 50 most recently uploaded matched episodes across all series (ordered by upload date) instead of iterating series-by-series into a 100-item cap that early series exhausted.
- **Containment title matching** — an episode title whose every word appears in the video title now scores as a strong match even when the video adds guests, console names, or channel branding (e.g. AVGN's "ToeJam & Earl (Sega Genesis)" vs "ToeJam & Earl with Scott the Woz (Sega Genesis) - Angry Video Game Nerd (AVGN)"); upload-date sanity keeps old lookalike uploads out.
- **Search bursts are batched** — back-catalog searches go to Sonarr 25 episodes per cycle instead of all at once; a big burst also fans out to your regular untagged indexers (Sonarr tags can't exclude them), which rate-limited Prowlarr and bogged down Sonarr's Activity page. Later cycles pick up the remainder automatically.
- **Age-restricted videos** — place a Netscape-format `cookies.txt` (exported from a signed-in YouTube session, per the yt-dlp wiki) in Tuberr's data dir and every download uses it.
- **systemd unit quoting** — the sample unit's `Environment=` line is now quoted so downloads dirs containing spaces (e.g. `/NAS/Temp Download/tuberr`) aren't truncated at the first space.
- **Download progress actually shows in Sonarr** — `--no-progress` was silently suppressing yt-dlp's progress template, so queue items sat at 0% until done. Live percentage, speed, and ETA now flow through the qBittorrent-compatible API.
- **Failed downloads drain from Sonarr's queue** — errored items previously reported qBittorrent's `error` state, which Sonarr treats as a transient warning and leaves in the queue at 0% forever; they now report `missingFiles`, which Sonarr treats as failed (removed + blocklisted).
- **Age-restricted videos via pasted cookies** — the YouTube (Tuberr) section gains an "Add YouTube cookies" box; paste a Netscape `cookies.txt` from a signed-in session and downloads authenticate with it (saved 0600 in Tuberr's data dir). Saving cookies automatically un-breaks previously failed matches so they retry; clear any Sonarr blocklist entries from the earlier failures.
- **Six parallel downloads** — up from 2, so big back-catalogs drain much faster (tunable via `max_concurrent` setting or `TUBERR_MAX_CONCURRENT`; kept below the point where YouTube starts throttling parallel connections).
- **Symmetric branding strip in title matching** — series/channel branding is now removed from the TVDB episode title as well as the video title before scoring; shows whose episode titles repeat the hosts ("… with Trixie and Katya") previously lost points for their own branding.
- **Cookie jar safety** — every download uses a private temp copy of `cookies.txt` (yt-dlp writes rotated cookies back to the file it is given; parallel downloads sharing one jar corrupted the session), and the UI now instructs exporting from a private/incognito window so the browser never rotates the exported session.
- **Detection no longer skips brand-new series** — channel auto-detection ran before a freshly discovered series had its episode list synced from Sonarr, so it silently did nothing until the next cycle. Episodes now sync first and detection (plus the full auto-match) runs in the same pass.

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
