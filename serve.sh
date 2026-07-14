#!/bin/sh
# Serve the Strombild playground over HTTP (the examples menu and the player
# fetch .strombild files, which needs http://, not file://). Usage: ./serve.sh [port]

cd "$(dirname "$0")" || exit 1

PORT="${1:-8000}"

echo "Serving Strombild at http://localhost:$PORT"
exec python3 -m http.server "$PORT"
