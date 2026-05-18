# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1 — build the React frontend with Vite
# ──────────────────────────────────────────────────────────────────────────────
FROM node:23-alpine AS frontend
WORKDIR /build

# Install frontend deps (incl. devDeps — vite is a devDep)
COPY package.json package-lock.json ./
RUN npm ci

# Copy only the files needed for the Vite build
COPY vite.config.js index.html ./
COPY src ./src
COPY public ./public

# Produce ./dist
RUN npm run build

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2 — Express server runtime
#
# The server reads:
#   __dirname (= /app)            -> server.js, services, routes, etc.
#   path.join(__dirname, 'data')  -> /app/data  (persistent volume)
#   path.join(__dirname, '../dist') -> /dist    (React build, served statically)
# These paths are preserved from the v1.x layout so existing
# `-v ./data:/app/data` Docker Compose volumes upgrade in place.
# ──────────────────────────────────────────────────────────────────────────────
FROM node:23-alpine
WORKDIR /app

# Install server runtime deps only
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# Server source
COPY server/. ./

# React build from stage 1 — placed at /dist so server.js's `../dist` resolves
COPY --from=frontend /build/dist /dist

# Persistent data dir (SQLite DBs live here)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3232

CMD ["node", "server.js"]
