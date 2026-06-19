#!/usr/bin/env bash
set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$PROJECT/backend"
ADMIN="$PROJECT/admin"

trap 'kill $(jobs -p) 2>/dev/null' EXIT

echo "Starting PocketBase..."
"$BACKEND/pocketbase" serve \
  --dir "$BACKEND/pb_data" \
  --hooksDir "$BACKEND/pb_hooks" &

sleep 2

echo "Starting admin SPA..."
(cd "$ADMIN" && npm run dev) &

echo ""
echo "  PocketBase:       http://localhost:8090"
echo "  PocketBase admin: http://localhost:8090/_/"
echo "  Admin SPA:        http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop all services."
echo "Run the viewer separately: cd viewer && AUTH_EMAIL=... AUTH_PASSWORD=... cargo run"

wait
