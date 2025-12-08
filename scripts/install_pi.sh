#!/usr/bin/env bash
set -euo pipefail

# Digital Frame installer for Raspberry Pi 4 (64-bit)
# - Installs deps (SDL2, gstreamer, ffmpeg), rustup, optional PocketBase, optional local admin UI
# - Builds viewer and sets up systemd units
# - Clones repository to $HOME/spomienka for persistent installation
# TLS is optional; default is HTTP for LAN use.
#
# All user input is collected at the start, then installation proceeds non-interactively.
# Can also run fully non-interactive with environment variables:
#   NONINTERACTIVE=y INSTALL_POCKETBASE=y INSTALL_ADMIN=y curl -sSL ... | bash

PB_VERSION="${PB_VERSION:-0.25.0}"
ADMIN_PORT_DEFAULT=4173
PB_PORT_DEFAULT=8090
VIEWER_BIN_NAME="frame-viewer"
PB_BIN_PATH="/opt/pocketbase/pocketbase"
PB_DATA_DIR="/var/lib/pocketbase"
PB_MIGRATIONS_DIR="$PB_DATA_DIR/pb_migrations"
VIEWER_CONFIG="/etc/frame-viewer/config.toml"
VIEWER_CACHE="/var/cache/frame-viewer"
REPO_URL="${REPO_URL:-https://github.com/jasonarmbrecht/spomienka.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="$HOME/spomienka"
ADMIN_PORT_SELECTED="not installed"

ask_yes_no() {
  local prompt="$1" default="$2" answer
  # In non-interactive mode, use the default
  if [[ "${NONINTERACTIVE:-false}" == "true" ]]; then
    echo "$prompt [$default]: $default (auto)"
    case "$default" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
  fi
  while true; do
    read -r -p "$prompt [$default]: " answer
    answer="${answer:-$default}"
    case "$answer" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
    echo "Please answer y or n."
  done
}

ask_value() {
  local prompt="$1" default="${2:-}"
  # In non-interactive mode, use the default
  if [[ "${NONINTERACTIVE:-false}" == "true" ]]; then
    echo "$prompt${default:+ [$default]}: $default (auto)" >&2
    echo "$default"
    return
  fi
  read -r -p "$prompt${default:+ [$default]}: " val
  echo "${val:-$default}"
}

generate_password() {
  # Generate a secure random password (16 chars, alphanumeric + symbols)
  openssl rand -base64 16 | tr -d '/+=' | head -c 16
}

wait_for_pocketbase() {
  local url="$1"
  local max_attempts=30
  local attempt=0
  echo "Waiting for PocketBase to be ready..."
  while [ $attempt -lt $max_attempts ]; do
    if curl -s "${url}/api/health" >/dev/null 2>&1; then
      echo "PocketBase is ready."
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Warning: PocketBase did not respond in time. Admin user creation may fail."
  return 1
}

create_superuser() {
  local email="$1"
  local password="$2"
  
  echo "Creating PocketBase superuser..."
  # Use upsert to create or update (idempotent)
  local output
  if output=$("$PB_BIN_PATH" superuser upsert "$email" "$password" \
      --dir "$PB_DATA_DIR" 2>&1); then
    echo "PocketBase superuser created/updated."
    return 0
  else
    echo "Warning: Failed to create PocketBase superuser."
    echo "  Error: $output"
    return 1
  fi
}

get_superuser_token() {
  local api_url="$1"
  local email="$2"
  local password="$3"
  
  local response
  # PocketBase 0.23+ uses _superusers collection for auth
  response=$(curl -s -X POST "${api_url}/api/collections/_superusers/auth-with-password" \
    -H "Content-Type: application/json" \
    -d "{\"identity\":\"${email}\",\"password\":\"${password}\"}" 2>/dev/null)
  
  # Debug: show response if auth fails
  if ! echo "$response" | grep -q '"token"'; then
    echo "DEBUG: Superuser auth failed. Response: $response" >&2
    echo ""
    return 1
  fi
  
  # Extract token from response
  echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4
}

verify_collections_exist() {
  local api_url="$1"
  local token="$2"
  
  echo "Verifying all required collections exist..."
  local required_collections=("users" "media" "approvals" "devices" "plugins")
  local missing=()
  
  for collection in "${required_collections[@]}"; do
    local check
    if [ -n "$token" ]; then
      check=$(curl -s "${api_url}/api/collections/${collection}" -H "Authorization: $token" 2>/dev/null)
    else
      check=$(curl -s "${api_url}/api/collections/${collection}" 2>/dev/null)
    fi
    
    if echo "$check" | grep -q '"id"'; then
      echo "  ✓ ${collection}"
    else
      echo "  ✗ ${collection} - NOT FOUND"
      missing+=("$collection")
    fi
  done
  
  if [ ${#missing[@]} -eq 0 ]; then
    echo "All required collections exist!"
    return 0
  else
    echo "Missing collections: ${missing[*]}"
    return 1
  fi
}

import_schema_via_api() {
  local api_url="$1"
  local superuser_email="$2"
  local superuser_password="$3"
  
  # Check if schema file exists
  if [[ ! -f "$REPO_ROOT/backend/pb_schema.json" ]]; then
    echo "ERROR: Schema file not found at $REPO_ROOT/backend/pb_schema.json"
    return 1
  fi
  
  # Get superuser token first (needed for both checking and importing)
  echo "Authenticating as superuser..."
  local token
  token=$(get_superuser_token "$api_url" "$superuser_email" "$superuser_password")
  
  if [ -z "$token" ]; then
    echo "ERROR: Could not authenticate as superuser for schema import."
    echo "  Check that PocketBase is running and superuser credentials are correct."
    return 1
  fi
  echo "Superuser authentication successful."
  
  # Check if collections already exist
  echo ""
  echo "Checking existing collections..."
  if verify_collections_exist "$api_url" "$token"; then
    echo "Schema already imported. Skipping."
    return 0
  fi
  
  # Import the schema
  echo ""
  echo "Importing collections from pb_schema.json..."
  local schema_content
  schema_content=$(cat "$REPO_ROOT/backend/pb_schema.json")
  
  local import_response
  import_response=$(curl -s -X PUT "${api_url}/api/collections/import" \
    -H "Content-Type: application/json" \
    -H "Authorization: $token" \
    -d "{\"collections\":${schema_content},\"deleteMissing\":false}" 2>/dev/null)
  
  # Check for error response
  if echo "$import_response" | grep -q '"code":'; then
    echo ""
    echo "ERROR: Schema import failed!"
    echo "Response: $import_response"
    echo ""
    
    # Try to give helpful error info
    if echo "$import_response" | grep -q "validation"; then
      echo "This appears to be a schema validation error."
      echo "The pb_schema.json format may not be compatible with this PocketBase version."
    fi
    
    echo ""
    echo "Manual import instructions:"
    echo "  1. Open: ${api_url}/_/"
    echo "  2. Log in with superuser credentials"
    echo "  3. Go to Settings (gear icon) -> Import collections"
    echo "  4. Paste the contents of: $REPO_ROOT/backend/pb_schema.json"
    echo "  5. Click Import"
    return 1
  fi
  
  echo "Import API call completed."
  
  # Give PocketBase time to process
  echo "Waiting for collections to be created..."
  sleep 3
  
  # Verify all collections were created
  echo ""
  if verify_collections_exist "$api_url" "$token"; then
    echo ""
    echo "*** Schema imported and verified successfully! ***"
    return 0
  else
    echo ""
    echo "ERROR: Import completed but some collections are missing!"
    echo "The schema may have partially imported or there was an error."
    return 1
  fi
}

create_admin_user() {
  local api_url="$1"
  local email="$2"
  local password="$3"
  local superuser_email="$4"
  local superuser_password="$5"
  
  # Verify the users collection exists
  echo "Checking if users collection exists..."
  local collections_check
  collections_check=$(curl -s "${api_url}/api/collections/users" 2>/dev/null)
  if ! echo "$collections_check" | grep -q '"id"'; then
    echo "ERROR: Users collection not found. Schema import may have failed."
    echo "Please import the schema manually first, then create the admin user."
    return 1
  fi
  echo "Users collection exists."
  
  # Get superuser token to bypass collection rules
  echo "Authenticating as superuser..."
  local token
  token=$(get_superuser_token "$api_url" "$superuser_email" "$superuser_password")
  
  if [ -z "$token" ]; then
    echo "ERROR: Could not authenticate as superuser."
    echo "The admin user cannot be created without superuser authentication."
    return 1
  fi
  
  echo "Superuser authentication successful."
  
  # Check if any admin user already exists
  echo "Checking for existing admin users..."
  local existing
  existing=$(curl -s "${api_url}/api/collections/users/records?filter=role='admin'&perPage=1" \
    -H "Authorization: $token" 2>/dev/null)
  
  # Handle case where we can't parse the response
  if echo "$existing" | grep -q '"code":'; then
    echo "Warning: Error checking for existing users: $existing"
  fi
  
  if echo "$existing" | grep -q '"totalItems":0' || echo "$existing" | grep -q '"totalItems": 0'; then
    echo "No admin user found. Creating admin user in users collection..."
    local response
    response=$(curl -s -X POST "${api_url}/api/collections/users/records" \
      -H "Content-Type: application/json" \
      -H "Authorization: $token" \
      -d "{\"email\":\"${email}\",\"password\":\"${password}\",\"passwordConfirm\":\"${password}\",\"role\":\"admin\"}" 2>/dev/null)
    
    if echo "$response" | grep -q '"id"'; then
      echo "Admin user created successfully!"
      echo "  Email: $email"
      return 0
    else
      echo "ERROR: Failed to create admin user."
      echo "  Response: $response"
      echo ""
      echo "You may need to create the admin user manually:"
      echo "  1. Go to ${api_url}/_/ (PocketBase admin)"
      echo "  2. Log in with superuser credentials"
      echo "  3. Navigate to the 'users' collection"
      echo "  4. Create a new user with role='admin'"
      return 1
    fi
  elif echo "$existing" | grep -q '"totalItems"'; then
    echo "Admin user already exists. Skipping creation."
    return 2
  else
    echo "Warning: Unexpected response when checking for admin users."
    echo "Attempting to create admin user anyway..."
    local response
    response=$(curl -s -X POST "${api_url}/api/collections/users/records" \
      -H "Content-Type: application/json" \
      -H "Authorization: $token" \
      -d "{\"email\":\"${email}\",\"password\":\"${password}\",\"passwordConfirm\":\"${password}\",\"role\":\"admin\"}" 2>/dev/null)
    
    if echo "$response" | grep -q '"id"'; then
      echo "Admin user created successfully!"
      return 0
    else
      echo "Warning: Failed to create admin user. Response: $response"
      return 1
    fi
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. Aborting."; exit 1; }
}

echo "=== Digital Frame Installer (Pi 4, 64-bit) ==="
require_cmd sudo

# Check for non-interactive mode via environment variable
if [[ "${NONINTERACTIVE:-}" =~ ^[Yy] ]]; then
  echo "Non-interactive mode enabled. Using defaults or environment overrides."
  echo "Options: INSTALL_POCKETBASE=y|n  INSTALL_ADMIN=y|n  ENABLE_TLS=y|n"
  echo ""
  NONINTERACTIVE=true
else
  NONINTERACTIVE=false
fi

# ============================================================================
# PHASE 1: COLLECT ALL USER INPUT UPFRONT
# ============================================================================
echo ""
echo "=== Configuration Questions ==="
echo "Please answer the following questions. Installation will proceed automatically after."
echo ""

# Check architecture first
ARCH=$(uname -m)
ARCH_CONTINUE=true
if [[ "$ARCH" != "aarch64" ]]; then
  echo "Warning: Expected aarch64 on Pi 4; got $ARCH."
  if ! ask_yes_no "Continue anyway?" "n"; then
    ARCH_CONTINUE=false
  fi
fi

if [[ "$ARCH_CONTINUE" == "false" ]]; then
  echo "Installation cancelled."
  exit 1
fi

# Configuration options - can be overridden via environment variables
PB_ON_PI=false
ADMIN_LOCAL=false
ENABLE_TLS=false
FRAME_ADMIN_EMAIL=""
FRAME_ADMIN_PASSWORD=""
PB_SUPERUSER_EMAIL=""
PB_SUPERUSER_PASSWORD=""
ADMIN_CREATED=false

# Question 1: PocketBase on this Pi?
if [[ "${INSTALL_POCKETBASE:-}" =~ ^[Yy] ]]; then
  PB_ON_PI=true
  echo "Run PocketBase on this Pi? [y]: y (env override)"
elif [[ "${INSTALL_POCKETBASE:-}" =~ ^[Nn] ]]; then
  PB_ON_PI=false
  echo "Run PocketBase on this Pi? [y]: n (env override)"
else
  ask_yes_no "Run PocketBase on this Pi?" "y" && PB_ON_PI=true
fi

# Question 2: Admin UI on this Pi?
if [[ "${INSTALL_ADMIN:-}" =~ ^[Yy] ]]; then
  ADMIN_LOCAL=true
  echo "Serve Admin UI on this Pi? [y]: y (env override)"
elif [[ "${INSTALL_ADMIN:-}" =~ ^[Nn] ]]; then
  ADMIN_LOCAL=false
  echo "Serve Admin UI on this Pi? [y]: n (env override)"
else
  ask_yes_no "Serve Admin UI on this Pi?" "y" && ADMIN_LOCAL=true
fi

# Question 3: Enable TLS?
if [[ "${ENABLE_TLS:-}" =~ ^[Yy] ]]; then
  ENABLE_TLS=true
  echo "Enable TLS/HTTPS termination here? [n]: y (env override)"
elif [[ "${ENABLE_TLS:-}" =~ ^[Nn] ]]; then
  ENABLE_TLS=false
  echo "Enable TLS/HTTPS termination here? [n]: n (env override)"
else
  ask_yes_no "Enable TLS/HTTPS termination here?" "n" && ENABLE_TLS=true
fi

# Question 4: Add cross target?
ADD_CROSS_TARGET=false
if ask_yes_no "Add cross target aarch64-unknown-linux-gnu (for cross-build reuse)?" "y"; then
  ADD_CROSS_TARGET=true
fi

# Question 5: PocketBase URL (only if not installing locally)
PB_HOST="http://localhost:${PB_PORT_DEFAULT}"
if ! $PB_ON_PI; then
  PB_HOST=$(ask_value "Enter PocketBase URL (http://host:8090)" "$PB_HOST")
fi

# Question 6: Admin UI port (only if installing admin locally)
ADMIN_PORT="$ADMIN_PORT_DEFAULT"
if $ADMIN_LOCAL; then
  ADMIN_PORT=$(ask_value "Admin UI port" "$ADMIN_PORT_DEFAULT")
fi

# Question 7-10: Viewer configuration
DEVICE_ID=$(ask_value "Device ID (optional, leave blank to skip)" "")
DEVICE_KEY=$(ask_value "Device API key (optional)" "")
INTERVAL_MS=$(ask_value "Slide interval ms" "8000")
TRANSITION=$(ask_value "Transition (fade/crossfade/cut)" "fade")

echo ""
echo "=== Configuration Complete ==="
echo "Proceeding with installation (no further input required)..."
echo ""

# ============================================================================
# PHASE 2: INSTALLATION (NO USER INPUT FROM HERE)
# ============================================================================

# Locate or fetch repo so we have viewer/admin/backend assets
# Handle case where BASH_SOURCE is not set (when piped from curl)
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  ORIG_SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  REPO_ROOT="$(cd "$ORIG_SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
else
  # Running via pipe - no script location available
  ORIG_SCRIPT_DIR=""
  REPO_ROOT=""
fi

# Check if we're already running from the install directory or need to clone
if [[ -z "$REPO_ROOT" || ! -f "$REPO_ROOT/admin/package.json" || ! -d "$REPO_ROOT/viewer" ]]; then
  echo "Project files not found next to script. Cloning repo to ${INSTALL_DIR}..."
  
  # Remove existing install directory if it exists (clean install)
  if [[ -d "$INSTALL_DIR" ]]; then
    echo "Existing installation found at $INSTALL_DIR. Backing up..."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"
  fi
  
  if command -v git >/dev/null 2>&1; then
    git clone --depth=1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
  else
    echo "git not found; using tarball download..."
    mkdir -p "$INSTALL_DIR"
    curl -L "${REPO_URL%.git}/archive/refs/heads/${REPO_BRANCH}.tar.gz" -o "/tmp/spomienka-repo.tar.gz"
    tar -xzf "/tmp/spomienka-repo.tar.gz" -C "/tmp"
    mv /tmp/spomienka-*/* "$INSTALL_DIR/"
    rm -rf /tmp/spomienka-* /tmp/spomienka-repo.tar.gz
  fi
  REPO_ROOT="$INSTALL_DIR"
  echo "Repository cloned to $INSTALL_DIR"
elif [[ "$REPO_ROOT" != "$INSTALL_DIR" ]]; then
  # Running from source checkout but not in install dir - copy to install dir
  echo "Copying project to ${INSTALL_DIR}..."
  if [[ -d "$INSTALL_DIR" ]]; then
    echo "Existing installation found at $INSTALL_DIR. Backing up..."
    mv "$INSTALL_DIR" "${INSTALL_DIR}.backup.$(date +%Y%m%d%H%M%S)"
  fi
  cp -r "$REPO_ROOT" "$INSTALL_DIR"
  REPO_ROOT="$INSTALL_DIR"
  echo "Project copied to $INSTALL_DIR"
else
  echo "Running from install directory: $INSTALL_DIR"
fi

echo "Updating apt and installing base dependencies..."
sudo apt update
sudo apt upgrade -y
sudo apt install -y git build-essential pkg-config cmake libssl-dev libudev-dev \
  libasound2-dev libxcb-shape0-dev libxcb-xfixes0-dev libsdl2-dev libsdl2-image-dev libsdl2-ttf-dev \
  ffmpeg libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-alsa gstreamer1.0-tools \
  exiftool curl unzip at expect

echo "Enabling GL Full KMS (may require reboot)..."
if sudo raspi-config nonint do_gldriver G2; then
  echo "GL driver set to Full KMS."
else
  echo "Could not set GL driver automatically. You may need to set it via raspi-config later."
fi

echo "Installing rustup (stable)..."
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  export PATH="$HOME/.cargo/bin:$PATH"
else
  rustup update stable
fi

if $ADD_CROSS_TARGET; then
  rustup target add aarch64-unknown-linux-gnu || true
fi

if $PB_ON_PI; then
  PB_HOST="http://localhost:${PB_PORT_DEFAULT}"
  echo "Setting up PocketBase..."
  sudo mkdir -p /opt/pocketbase "$PB_DATA_DIR"
  sudo chown "$USER":"$USER" /opt/pocketbase "$PB_DATA_DIR"
  sudo mkdir -p "$PB_MIGRATIONS_DIR"
  sudo chown "$USER":"$USER" "$PB_MIGRATIONS_DIR"
  PB_URL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_arm64.zip"
  curl -L "$PB_URL" -o /tmp/pb.zip
  unzip -o /tmp/pb.zip -d /opt/pocketbase
  sudo chmod +x "$PB_BIN_PATH"

  # Schema will be imported via API after PocketBase starts (more reliable than CLI migration)
  if [[ ! -f "$REPO_ROOT/backend/pb_schema.json" ]]; then
    echo "ERROR: backend/pb_schema.json not found!"
    echo "Cannot proceed without schema file."
    exit 1
  fi
  echo "Schema file found. Will import via API after PocketBase starts."

  # Install PocketBase hooks for media processing
  if [[ -d "$REPO_ROOT/backend/pb_hooks" ]]; then
    echo "Installing PocketBase hooks..."
    sudo mkdir -p "$PB_DATA_DIR/pb_hooks"
    sudo cp -r "$REPO_ROOT/backend/pb_hooks/"* "$PB_DATA_DIR/pb_hooks/"
    sudo chown -R "$USER":"$USER" "$PB_DATA_DIR/pb_hooks"
    echo "Hooks installed to $PB_DATA_DIR/pb_hooks"
  else
    echo "Warning: backend/pb_hooks not found; skipping hooks installation."
  fi

  # Create PocketBase superuser BEFORE starting the service (CLI works on DB directly)
  PB_SUPERUSER_EMAIL="superuser@frame.local"
  PB_SUPERUSER_PASSWORD=$(generate_password)
  create_superuser "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD"

  sudo tee /etc/systemd/system/pocketbase.service >/dev/null <<EOF
[Unit]
Description=PocketBase
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$PB_BIN_PATH serve --http=0.0.0.0:${PB_PORT_DEFAULT} --dir $PB_DATA_DIR --migrationsDir $PB_MIGRATIONS_DIR --hooksDir $PB_DATA_DIR/pb_hooks
WorkingDirectory=/opt/pocketbase
Restart=always
User=$USER

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now pocketbase
  PB_HOST="http://$(hostname -I | awk '{print $1}'):${PB_PORT_DEFAULT}"
  echo "PocketBase running on $PB_HOST (HTTP). TLS skipped per selection."
  
  # Wait for PocketBase to be ready, import schema, and create admin user
  if wait_for_pocketbase "http://localhost:${PB_PORT_DEFAULT}"; then
    
    echo ""
    echo "=== Importing Schema via API ==="
    
    # Always import via API - this is the reliable method
    SCHEMA_IMPORT_SUCCESS=false
    if import_schema_via_api "http://localhost:${PB_PORT_DEFAULT}" "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD"; then
      SCHEMA_IMPORT_SUCCESS=true
    else
      echo ""
      echo "*** CRITICAL: Schema import failed! ***"
      echo "The database schema could not be imported."
      echo ""
      echo "Please import the schema manually:"
      echo "  1. Open: ${PB_HOST}/_/"
      echo "  2. Log in with superuser: $PB_SUPERUSER_EMAIL / (see password in summary)"
      echo "  3. Settings (gear icon) -> Import collections"
      echo "  4. Paste contents of: $REPO_ROOT/backend/pb_schema.json"
      echo "  5. Click Import"
      echo ""
      echo "After importing, create an admin user in the 'users' collection with role='admin'."
    fi
    
    # Only attempt to create admin user if schema was imported successfully
    if [ "$SCHEMA_IMPORT_SUCCESS" = true ]; then
      FRAME_ADMIN_EMAIL="admin@frame.local"
      FRAME_ADMIN_PASSWORD=$(generate_password)
      
      echo ""
      echo "=== Creating Frame Admin User ==="
      create_result=0
      create_admin_user "http://localhost:${PB_PORT_DEFAULT}" "$FRAME_ADMIN_EMAIL" "$FRAME_ADMIN_PASSWORD" "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" || create_result=$?
      
      if [ $create_result -eq 0 ]; then
        ADMIN_CREATED=true
        echo ""
        echo "*** Frame Admin user created successfully! ***"
        echo "    Email: $FRAME_ADMIN_EMAIL"
        echo "    Password: $FRAME_ADMIN_PASSWORD"
        echo ""
      elif [ $create_result -eq 2 ]; then
        # Admin already exists - credentials unknown
        FRAME_ADMIN_EMAIL="(existing admin - check PocketBase)"
        FRAME_ADMIN_PASSWORD="(not changed)"
        echo ""
        echo "An admin user already exists in the database."
      else
        echo ""
        echo "*** WARNING: Failed to create Frame Admin user ***"
        echo "You will need to create it manually via PocketBase admin at:"
        echo "  ${PB_HOST}/_/"
        echo ""
        # Reset to indicate manual creation needed
        FRAME_ADMIN_EMAIL="(MANUAL CREATION REQUIRED)"
        FRAME_ADMIN_PASSWORD="(create via PocketBase admin UI)"
      fi
    else
      # Schema import failed - admin user cannot be created
      FRAME_ADMIN_EMAIL="(MANUAL CREATION REQUIRED - import schema first)"
      FRAME_ADMIN_PASSWORD="(create via PocketBase admin UI after schema import)"
      echo ""
      echo "Skipping admin user creation since schema import failed."
    fi
  else
    echo ""
    echo "*** WARNING: PocketBase did not start in time ***"
    echo "Admin user was not created. After installation:"
    echo "  1. Check PocketBase status: sudo systemctl status pocketbase"
    echo "  2. View logs: journalctl -u pocketbase -f"
    echo "  3. Create admin user manually in PocketBase UI at ${PB_HOST}/_/"
    FRAME_ADMIN_EMAIL="(MANUAL CREATION REQUIRED)"
    FRAME_ADMIN_PASSWORD="(create via PocketBase admin UI)"
  fi
fi

if $ADMIN_LOCAL; then
  echo "Installing Node (NodeSource) for admin build..."
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
  fi
  
  # Install serve globally so systemd can use it reliably
  echo "Installing 'serve' package globally..."
  sudo npm install -g serve
  
  echo "Building admin SPA against PocketBase at ${PB_HOST}..."
  (
    cd "$REPO_ROOT/admin"
    npm install
    VITE_PB_URL="${PB_HOST}" npm run build
  )
  ADMIN_PORT_SELECTED="$ADMIN_PORT"
  
  # Get the path to globally installed serve
  SERVE_PATH=$(command -v serve)
  
  sudo tee /etc/systemd/system/frame-admin.service >/dev/null <<EOF
[Unit]
Description=Frame Admin UI
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${INSTALL_DIR}/admin
ExecStart=${SERVE_PATH} -s dist -l ${ADMIN_PORT}
Restart=always
User=$USER
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now frame-admin
  echo "Admin UI served locally on http://$(hostname -I | awk '{print $1}'):${ADMIN_PORT}"
else
  echo "Skipping local Admin UI. To deploy elsewhere:"
  echo "  cd admin && npm install && npm run build"
  echo "  Host ./dist via Netlify/Vercel/S3+CloudFront/etc with env VITE_PB_URL=${PB_HOST}"
fi

echo "Building viewer..."
(cd "$REPO_ROOT/viewer" && cargo build --release)
sudo install -m 0755 "$REPO_ROOT/viewer/target/release/${VIEWER_BIN_NAME}" "/usr/local/bin/${VIEWER_BIN_NAME}"

sudo mkdir -p "$(dirname "$VIEWER_CONFIG")" "$VIEWER_CACHE"
sudo chown "$USER":"$USER" "$(dirname "$VIEWER_CONFIG")" "$VIEWER_CACHE"

cat > /tmp/frame-viewer-config.toml <<EOF
pb_url = "${PB_HOST}"
interval_ms = ${INTERVAL_MS}
transition = "${TRANSITION}"
cache_dir = "${VIEWER_CACHE}"
device_id = "${DEVICE_ID}"
device_api_key = "${DEVICE_KEY}"
# Authentication credentials (auto-generated during install)
auth_email = "${FRAME_ADMIN_EMAIL}"
auth_password = "${FRAME_ADMIN_PASSWORD}"
EOF
sudo mv /tmp/frame-viewer-config.toml "$VIEWER_CONFIG"

sudo tee /etc/systemd/system/frame-viewer.service >/dev/null <<EOF
[Unit]
Description=Frame Viewer
After=network-online.target
Wants=network-online.target

[Service]
Environment=RUST_LOG=info
ExecStart=/usr/local/bin/${VIEWER_BIN_NAME}
WorkingDirectory=$HOME
Restart=always
User=$USER

[Install]
WantedBy=graphical.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now frame-viewer

SUMMARY_FILE="$HOME/spomienka-install-summary.txt"

# Pre-compute display values to avoid heredoc parsing issues
DISPLAY_DEVICE_ID="${DEVICE_ID:-(none)}"
DISPLAY_DEVICE_KEY="${DEVICE_KEY:-(none)}"
DISPLAY_PB_SUPERUSER_EMAIL="${PB_SUPERUSER_EMAIL:-(not created)}"
DISPLAY_PB_SUPERUSER_PASSWORD="${PB_SUPERUSER_PASSWORD:-(not created)}"
DISPLAY_FRAME_ADMIN_EMAIL="${FRAME_ADMIN_EMAIL:-(not created)}"
DISPLAY_FRAME_ADMIN_PASSWORD="${FRAME_ADMIN_PASSWORD:-(not created)}"
DISPLAY_PB_LOCATION=$( [ "$PB_ON_PI" = true ] && echo "local on this Pi" || echo "remote" )
DISPLAY_PB_SERVICE=$( [ "$PB_ON_PI" = true ] && echo "ENABLED" || echo "not installed" )
DISPLAY_ADMIN_MODE=$( [ "$ADMIN_LOCAL" = true ] && echo "local on this Pi" || echo "not installed (deploy elsewhere)" )
DISPLAY_ADMIN_URL=$( [ "$ADMIN_LOCAL" = true ] && echo "http://$(hostname -I | awk '{print $1}'):${ADMIN_PORT_SELECTED}" || echo "N/A" )
DISPLAY_ADMIN_STATUS=$( 
  if [ "$ADMIN_CREATED" = true ]; then 
    echo "CREATED - save these credentials!"
  elif echo "$DISPLAY_FRAME_ADMIN_EMAIL" | grep -q "MANUAL"; then
    echo "*** MANUAL CREATION REQUIRED - see instructions below ***"
  else
    echo "existing or not created"
  fi
)

cat > "$SUMMARY_FILE" <<EOF
=== Spomienka Install Summary ===
Status: completed (script uses 'set -e' so earlier errors would have aborted)

Installation Directory: ${INSTALL_DIR}

PocketBase:
  Location: ${DISPLAY_PB_LOCATION}
  URL: ${PB_HOST}
  Data dir: $PB_DATA_DIR
  Service: pocketbase (systemd) ${DISPLAY_PB_SERVICE}

Admin UI:
  Mode: ${DISPLAY_ADMIN_MODE}
  URL: ${DISPLAY_ADMIN_URL}
  Build target PocketBase: ${PB_HOST}
  Source: ${INSTALL_DIR}/admin

Viewer:
  Service: frame-viewer (systemd) ENABLED
  Binary: /usr/local/bin/${VIEWER_BIN_NAME}
  Config: $VIEWER_CONFIG
  Cache: $VIEWER_CACHE
  Source: ${INSTALL_DIR}/viewer

Device credentials (as provided):
  Device ID: ${DISPLAY_DEVICE_ID}
  Device API key: ${DISPLAY_DEVICE_KEY}

PocketBase Superuser (for PocketBase admin panel at /_/):
  Email: ${DISPLAY_PB_SUPERUSER_EMAIL}
  Password: ${DISPLAY_PB_SUPERUSER_PASSWORD}

Admin User (for Admin UI login):
  Email: ${DISPLAY_FRAME_ADMIN_EMAIL}
  Password: ${DISPLAY_FRAME_ADMIN_PASSWORD}
  Status: ${DISPLAY_ADMIN_STATUS}

Notes:
- IMPORTANT: Save the credentials above! Admin user creds are also stored in $VIEWER_CONFIG
- Logs: journalctl -u pocketbase -f (if installed), journalctl -u frame-admin -f (if installed), journalctl -u frame-viewer -f
- If the GL driver was changed, a reboot is recommended.
- To update, run: cd ${INSTALL_DIR} && git pull && ./scripts/install_pi.sh

If admin user was NOT created automatically:
  1. Open PocketBase Admin: ${PB_HOST}/_/
  2. Log in with the PocketBase Superuser credentials above
  3. Go to Collections -> users -> New record
  4. Fill in: email, password, passwordConfirm, and set role to "admin"
  5. Update $VIEWER_CONFIG with the admin email/password you created

*** SECURITY NOTICE ***
This summary file contains sensitive credentials and will be AUTOMATICALLY DELETED
in 24 hours for security. Save the credentials above to a secure location NOW!
Deletion scheduled for: $(date -d '+24 hours' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v+24H '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "24 hours from now")
EOF

echo "=== Install complete ==="
cat "$SUMMARY_FILE"
echo ""
echo "Summary saved to $SUMMARY_FILE"

# Schedule automatic deletion of summary file after 24 hours (contains sensitive credentials)
if command -v at >/dev/null 2>&1; then
  # Ensure atd service is running
  sudo systemctl enable --now atd 2>/dev/null || true
  
  echo "rm -f '$SUMMARY_FILE'" | at now + 24 hours 2>/dev/null && \
    echo "WARNING: $SUMMARY_FILE will be automatically deleted in 24 hours for security." || \
    echo "Note: Could not schedule auto-deletion. Please manually delete $SUMMARY_FILE after saving credentials."
else
  echo "Note: 'at' command not available. Please manually delete $SUMMARY_FILE after saving credentials."
fi

echo ""
echo "*** SAVE YOUR CREDENTIALS NOW - This file will be deleted in 24 hours! ***"
