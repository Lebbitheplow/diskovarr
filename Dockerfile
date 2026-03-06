FROM node:20-alpine

WORKDIR /app

# Install build dependencies for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

# Install dependencies (production only, cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Data directory is mounted as a volume at runtime
RUN mkdir -p /app/data

VOLUME ["/app/data"]

EXPOSE 3232

CMD ["node", "server.js"]
