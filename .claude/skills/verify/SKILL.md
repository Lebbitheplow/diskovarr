---
name: verify
description: Verify Diskovarr-react frontend/backend changes end-to-end against the live prod backend without mutating prod state.
---

# Verifying Diskovarr-react changes

Prod runs as `diskovarr.service` (systemd) on port **3232**, serving the built
frontend from `server/public/`. Source changes are NOT live there — verify via
the Vite dev server instead.

## Recipe (frontend changes, signed-in flows)

1. **Capture proxy** (no prod mutations): run a small Node http proxy on **3233**
   that forwards everything to 127.0.0.1:3232 but intercepts mutating endpoints
   (e.g. `POST /api/request`) — append the JSON body to a capture file and reply
   `200 {ok:true}`. This gives real search/services data with zero writes.
2. **Point Vite at it**: `echo "VITE_BACKEND_URL=http://localhost:3233" > .env.local`
   (gitignored), then `npx vite --port 5173`. Vite proxies `/auth`, `/api`,
   `/admin`, etc. (see `vite.config.js`). **Delete `.env.local` when done.**
3. **Mint a session** (Plex OAuth can't be done headless): insert a row into
   `server/data/sessions.db` (`sessions` table) with sess JSON
   `{cookie:{...}, plexUser:{id,username,title}, isAdmin:true}` and sign the sid:
   cookie value = `encodeURIComponent('s:' + sid + '.' + HMAC_SHA256_base64(sid, SESSION_SECRET))`,
   secret from `server/.env`. Cookie name: `diskovarr.react.sid`.
   **Delete the row afterwards.**
4. **Drive with puppeteer-core + Firefox** (`/usr/bin/firefox`, snap — profile
   must live under `~/snap/firefox/common/`; Chrome networking is broken on this
   host). GOTCHA: cookies set via `page.setCookie`/BiDi jar are never sent by
   Firefox — instead navigate to `http://localhost:5173/login` first, then
   `page.evaluate(v => document.cookie = 'diskovarr.react.sid=' + v + '; path=/', cookieVal)`
   (httpOnly not required).

## Driving notes

- Search is URL-driven: `/search?q=...`; results are `.card` elements with
  `.card-title`; the Request button is `.btn-request` inside the hover overlay
  (click via `el.click()` in evaluate — no hover needed). Modal buttons are
  `.chip-sm`; match by text.
- In-library titles have no Request button — probe `/api/search?q=` first (with
  the session cookie) and pick results with `inLibrary:false`.
- YouTube/TVDB-only test item: search "kitboga" (tvdbId 392078, `source:'tvdb'`,
  no tmdbId). Regular TMDB show: "shogun" → "Shōgun".
- Backend logs cookie presence for `/auth/*` in `journalctl -u diskovarr.service`
  — useful to tell "cookie not sent" from "cookie rejected".

## Cleanup checklist

kill vite + proxy, `rm .env.local`, delete minted session row, remove
`~/snap/firefox/common/verify-*` profiles.
