#!/usr/bin/env bash
# Wipes the local dev database so setup_dev.sh can be run on a clean slate.
# Simulates a fresh machine — useful for testing the setup flow end-to-end.

set -e

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
PB_DATA="$PROJECT/backend/pb_data"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo ""
echo -e "${YELLOW}This will delete $PB_DATA and all its data.${NC}"
echo "Make sure dev.sh is stopped first (Ctrl+C)."
echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

rm -rf "$PB_DATA"
echo -e "  ${GREEN}✓${NC} $PB_DATA deleted"
echo ""
echo "Run ./scripts/setup_dev.sh to set up fresh."
echo ""
