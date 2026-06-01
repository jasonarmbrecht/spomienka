#!/usr/bin/env bash
# First-time dev environment setup.
# Creates a PocketBase superuser, imports the schema, adds the role field to
# users if missing, and creates a frame admin user.
#
# Safe to run on both fresh and existing databases.
#
# Usage:
#   ./scripts/setup_dev.sh
#   ./scripts/setup_dev.sh <admin-email> <admin-password>

set -e

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
PB="$PROJECT/backend/pocketbase"
PB_DATA="$PROJECT/backend/pb_data"
SCHEMA="$PROJECT/backend/pb_schema.json"
PB_URL="http://localhost:8090"

SUPERUSER_EMAIL="superuser@frame.local"
SUPERUSER_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 2>/dev/null || openssl rand -base64 15 | tr -dc 'A-Za-z0-9' | head -c 20)"

ADMIN_EMAIL="${1:-admin@frame.local}"
ADMIN_PASSWORD="${2:-changeme123}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

echo ""
echo "Spomienka dev setup"
echo "-------------------"

# ── Step 1: Create superuser via PocketBase CLI ──────────────────────────────

if [ ! -f "$PB" ]; then
    fail "PocketBase binary not found at backend/pocketbase. Run: cd backend && curl -L ... to download it."
fi

echo ""
echo "Creating PocketBase superuser..."
"$PB" superuser upsert "$SUPERUSER_EMAIL" "$SUPERUSER_PASSWORD" --dir "$PB_DATA" \
    && ok "Superuser created ($SUPERUSER_EMAIL)" \
    || fail "Failed to create superuser — is PocketBase stopped? (dev.sh must not be running yet)"

# ── Step 2: Start PocketBase temporarily if not already running ──────────────

if ! curl -sf "$PB_URL/api/health" >/dev/null 2>&1; then
    echo ""
    echo "Starting PocketBase temporarily for API calls..."
    "$PB" serve --dir "$PB_DATA" --hooksDir "$PROJECT/backend/pb_hooks" >/dev/null 2>&1 &
    PB_PID=$!
    trap 'kill $PB_PID 2>/dev/null' EXIT
fi

echo ""
echo "Waiting for PocketBase to be ready..."
for i in $(seq 1 30); do
    if curl -sf "$PB_URL/api/health" >/dev/null 2>&1; then
        ok "PocketBase is ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        fail "PocketBase did not respond after 30 seconds"
    fi
    sleep 1
done

# ── Step 3: Get superuser token ───────────────────────────────────────────────

echo ""
echo "Authenticating as superuser..."
TOKEN=$(python3 -c "
import json, urllib.request
payload = json.dumps({'identity': '$SUPERUSER_EMAIL', 'password': '$SUPERUSER_PASSWORD'}).encode()
req = urllib.request.Request(
    '$PB_URL/api/collections/_superusers/auth-with-password',
    data=payload,
    headers={'Content-Type': 'application/json'},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(json.loads(r.read()).get('token', ''))
except Exception:
    print('')
")

if [ -z "$TOKEN" ]; then
    fail "Could not get superuser token"
fi
ok "Authenticated"

# ── Step 4: Import app collections (always exclude users) ────────────────────
# The users collection is managed by PocketBase — we handle the role field
# separately below to avoid conflicts on both fresh and existing databases.

echo ""
echo "Importing app collections..."
RESULT=$(python3 -c "
import json, urllib.request, urllib.error

schema = [c for c in json.loads(open('$SCHEMA').read()) if c.get('name') != 'users']
payload = json.dumps({'collections': schema, 'deleteMissing': False}).encode()
req = urllib.request.Request(
    '$PB_URL/api/collections/import',
    data=payload,
    headers={'Content-Type': 'application/json', 'Authorization': '$TOKEN'},
    method='PUT',
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print('ok')
except urllib.error.HTTPError as e:
    print('error: ' + e.read().decode())
except Exception as e:
    print('error: ' + str(e))
")

if [[ "$RESULT" == error* ]]; then
    fail "Schema import failed: $RESULT"
fi
ok "App collections imported"

# ── Step 5: Add role field to users if missing ───────────────────────────────

echo ""
echo "Checking users.role field..."
ROLE_RESULT=$(python3 -c "
import json, urllib.request, urllib.error

token = '$TOKEN'
base = '$PB_URL'

def req(method, path, payload=None):
    r = urllib.request.Request(base + path, data=payload, method=method)
    r.add_header('Authorization', token)
    if payload:
        r.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(r, timeout=10) as res:
            return json.loads(res.read()), None
    except urllib.error.HTTPError as e:
        return None, e.read().decode()

col, err = req('GET', '/api/collections/users')
if err:
    print('error: ' + err)
    exit()

fields = col.get('fields', [])
if any(f.get('name') == 'role' for f in fields):
    print('exists')
    exit()

fields.append({'name': 'role', 'type': 'text', 'required': False})
col['fields'] = fields
data = json.dumps(col).encode()
_, err = req('PATCH', '/api/collections/' + col['id'], data)
if err:
    print('error: ' + err)
else:
    print('added')
")

if [[ "$ROLE_RESULT" == exists ]]; then
    warn "users.role already exists — skipping"
elif [[ "$ROLE_RESULT" == added ]]; then
    ok "users.role field added"
else
    fail "Failed to add users.role: $ROLE_RESULT"
fi

# ── Step 6: Create frame admin user ──────────────────────────────────────────

echo ""
echo "Creating frame admin user ($ADMIN_EMAIL)..."
CREATE_RESULT=$(python3 -c "
import json, urllib.request, urllib.error

payload = json.dumps({
    'email': '$ADMIN_EMAIL',
    'password': '$ADMIN_PASSWORD',
    'passwordConfirm': '$ADMIN_PASSWORD',
    'role': 'admin',
    'emailVisibility': True,
    'verified': True,
}).encode()
req = urllib.request.Request(
    '$PB_URL/api/collections/users/records',
    data=payload,
    headers={'Content-Type': 'application/json', 'Authorization': '$TOKEN'},
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print('ok:' + json.loads(r.read()).get('id', ''))
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print('exists' if 'already exists' in body else 'error: ' + body)
except Exception as e:
    print('error: ' + str(e))
")

if [[ "$CREATE_RESULT" == ok:* ]]; then
    ok "Admin user created"
elif [[ "$CREATE_RESULT" == exists ]]; then
    warn "Admin user already exists — skipping"
else
    fail "Failed to create admin user: $CREATE_RESULT"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "  Admin SPA login:"
echo "    Email:    $ADMIN_EMAIL"
echo "    Password: $ADMIN_PASSWORD"
echo ""
echo "  PocketBase superuser (for /_/ admin panel):"
echo "    Email:    $SUPERUSER_EMAIL"
echo "    Password: $SUPERUSER_PASSWORD"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Now run: ./dev.sh"
echo ""
