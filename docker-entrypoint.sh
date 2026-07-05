#!/bin/sh
# Starts the bundled Tuberr companion service alongside the Diskovarr server.
# Disable with TUBERR_ENABLED=false (e.g. when running Tuberr elsewhere).
set -e

if [ "${TUBERR_ENABLED:-true}" != "false" ]; then
  export TUBERR_DATA_DIR="${TUBERR_DATA_DIR:-/app/data/tuberr}"
  export TUBERR_DOWNLOADS_DIR="${TUBERR_DOWNLOADS_DIR:-${TUBERR_DATA_DIR}/downloads}"
  node /tuberr/server.js &

  # Let the server auto-pair the bundled Tuberr in Admin → Connections.
  # TUBERR_URL can be overridden with a LAN address reachable by Sonarr.
  export TUBERR_URL="${TUBERR_URL:-http://127.0.0.1:9832}"
  export TUBERR_API_KEY_FILE="${TUBERR_API_KEY_FILE:-${TUBERR_DATA_DIR}/api_key.txt}"
fi

exec node /app/server.js
