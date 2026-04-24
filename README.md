# Diskovarr — React Frontend

A React + Vite frontend for [Diskovarr](https://github.com/Lebbitheplow/diskovarr), a personalized Plex recommendation app. This repo contains only the React UI — it proxies all API calls to the existing Diskovarr backend server.

## Prerequisites

- Node.js 18+
- A running Diskovarr backend (the original Express/EJS app)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `VITE_BACKEND_URL` to point at your Diskovarr backend.

3. **Development server**
   ```bash
   npm run dev
   ```
   Vite will start on `http://localhost:5173` and proxy all `/api`, `/auth`, and `/admin` requests to your backend.

4. **Production build**
   ```bash
   npm run build
   ```
   The built files in `dist/` can be served by the Diskovarr backend's Express static middleware.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VITE_BACKEND_URL` | `http://localhost:3233` | URL of the Diskovarr backend server |
| `VITE_APP_VERSION` | `1.17.12` | Version shown in the About modal |
| `VITE_DISCOVER_ENABLED` | `true` | Show/hide the Diskovarr Requests tab |

## Project Structure

```
src/
  components/       # Shared UI components (NavigationBar, MediaCard, DetailModal, …)
  context/          # React context providers (Auth, Toast, Theme)
  pages/            # Route-level page components
  services/         # Axios API client
  style.css         # Global stylesheet
```

## Features

- Personalized movie & TV recommendations based on Plex watch history
- Diskovarr Requests — request content not yet in the library
- Filter — browse the library by type, genre, decade, and rating
- Watchlist — save and sync items to your Plex Watchlist
- Queue — track and manage media requests
- Issues — report and manage library problems
- Notification settings (Pushover, Discord)
- Detail modal with trailer playback and cast-to-Plex
