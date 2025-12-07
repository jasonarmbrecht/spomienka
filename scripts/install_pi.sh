#!/usr/bin/env bash
set -euo pipefail

# Digital Frame installer for Raspberry Pi 4 (64-bit)
# - Installs deps (SDL2, gstreamer, ffmpeg), rustup, optional PocketBase, optional local admin UI
# - Builds viewer and sets up systemd units
# - Clones repository to $HOME/spomienka for persistent installation
# TLS is optional; default is HTTP for LAN use.

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
  
  # Extract token from response
  echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4
}

create_admin_user() {
  local api_url="$1"
  local email="$2"
  local password="$3"
  local superuser_email="$4"
  local superuser_password="$5"
  
  # Get superuser token to bypass collection rules
  echo "Authenticating as superuser..."
  local token
  token=$(get_superuser_token "$api_url" "$superuser_email" "$superuser_password")
  
  if [ -z "$token" ]; then
    echo "Warning: Could not authenticate as superuser. Trying without auth..."
    token=""
  fi
  
  # Check if any admin user already exists
  local existing
  if [ -n "$token" ]; then
    existing=$(curl -s "${api_url}/api/collections/users/records?filter=role='admin'&perPage=1" \
      -H "Authorization: $token" 2>/dev/null)
  else
    existing=$(curl -s "${api_url}/api/collections/users/records?filter=role='admin'&perPage=1" 2>/dev/null)
  fi
  
  if echo "$existing" | grep -q '"totalItems":0'; then
    echo "Creating admin user in users collection..."
    local response
    if [ -n "$token" ]; then
      response=$(curl -s -X POST "${api_url}/api/collections/users/records" \
        -H "Content-Type: application/json" \
        -H "Authorization: $token" \
        -d "{\"email\":\"${email}\",\"password\":\"${password}\",\"passwordConfirm\":\"${password}\",\"role\":\"admin\"}" 2>/dev/null)
    else
      response=$(curl -s -X POST "${api_url}/api/collections/users/records" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"${email}\",\"password\":\"${password}\",\"passwordConfirm\":\"${password}\",\"role\":\"admin\"}" 2>/dev/null)
    fi
    
    if echo "$response" | grep -q '"id"'; then
      echo "Admin user created successfully."
      return 0
    else
      echo "Warning: Failed to create admin user. Response: $response"
      return 1
    fi
  else
    echo "Admin user already exists. Skipping creation."
    return 2
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. Aborting."; exit 1; }
}

echo "=== Digital Frame Installer (Pi 4, 64-bit) ==="
require_cmd sudo

# Non-interactive mode must be explicitly enabled via NONINTERACTIVE=y
# This prevents accidental auto-acceptance of defaults
if [[ "${NONINTERACTIVE:-}" =~ ^[Yy] ]]; then
  echo "Non-interactive mode enabled. Using defaults or environment overrides."
  echo "Options: INSTALL_POCKETBASE=y|n  INSTALL_ADMIN=y|n  ENABLE_TLS=y|n"
  echo ""
  NONINTERACTIVE=true
elif [[ ! -t 0 ]]; then
  echo "ERROR: Running via pipe without NONINTERACTIVE=y"
  echo ""
  echo "This script requires user input. Either:"
  echo "  1. Download and run interactively:"
  echo "     curl -O https://raw.githubusercontent.com/.../install_pi.sh && bash install_pi.sh"
  echo ""
  echo "  2. Use non-interactive mode with environment variables:"
  echo "     NONINTERACTIVE=y INSTALL_POCKETBASE=y INSTALL_ADMIN=y curl -sSL ... | bash"
  echo ""
  exit 1
else
  NONINTERACTIVE=false
fi

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

ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" ]]; then
  echo "Warning: Expected aarch64 on Pi 4; got $ARCH. Continue anyway? (y/n)"
  ask_yes_no "Continue" "n" || exit 1
fi

# Configuration options - can be overridden via environment variables
# Examples:
#   INSTALL_POCKETBASE=n curl -sSL .../install_pi.sh | bash
#   INSTALL_ADMIN=n ENABLE_TLS=y ./install_pi.sh
PB_ON_PI=false
ADMIN_LOCAL=false
ENABLE_TLS=false
FRAME_ADMIN_EMAIL=""
FRAME_ADMIN_PASSWORD=""
PB_SUPERUSER_EMAIL=""
PB_SUPERUSER_PASSWORD=""
ADMIN_CREATED=false

# Check for environment variable overrides first
if [[ "${INSTALL_POCKETBASE:-}" =~ ^[Yy] ]]; then
  PB_ON_PI=true
  echo "Run PocketBase on this Pi? [y]: y (env override)"
elif [[ "${INSTALL_POCKETBASE:-}" =~ ^[Nn] ]]; then
  PB_ON_PI=false
  echo "Run PocketBase on this Pi? [y]: n (env override)"
else
  ask_yes_no "Run PocketBase on this Pi?" "y" && PB_ON_PI=true
fi

if [[ "${INSTALL_ADMIN:-}" =~ ^[Yy] ]]; then
  ADMIN_LOCAL=true
  echo "Serve Admin UI on this Pi? [y]: y (env override)"
elif [[ "${INSTALL_ADMIN:-}" =~ ^[Nn] ]]; then
  ADMIN_LOCAL=false
  echo "Serve Admin UI on this Pi? [y]: n (env override)"
else
  ask_yes_no "Serve Admin UI on this Pi?" "y" && ADMIN_LOCAL=true
fi

if [[ "${ENABLE_TLS:-}" =~ ^[Yy] ]]; then
  ENABLE_TLS=true
  echo "Enable TLS/HTTPS termination here? [n]: y (env override)"
elif [[ "${ENABLE_TLS:-}" =~ ^[Nn] ]]; then
  ENABLE_TLS=false
  echo "Enable TLS/HTTPS termination here? [n]: n (env override)"
else
  ask_yes_no "Enable TLS/HTTPS termination here?" "n" && ENABLE_TLS=true
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

if ask_yes_no "Add cross target aarch64-unknown-linux-gnu (for cross-build reuse)?" "y"; then
  rustup target add aarch64-unknown-linux-gnu || true
fi

PB_HOST="http://localhost:${PB_PORT_DEFAULT}"
if $PB_ON_PI; then
  echo "Setting up PocketBase..."
  sudo mkdir -p /opt/pocketbase "$PB_DATA_DIR"
  sudo chown "$USER":"$USER" /opt/pocketbase "$PB_DATA_DIR"
  sudo mkdir -p "$PB_MIGRATIONS_DIR"
  sudo chown "$USER":"$USER" "$PB_MIGRATIONS_DIR"
  PB_URL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_arm64.zip"
  curl -L "$PB_URL" -o /tmp/pb.zip
  unzip -o /tmp/pb.zip -d /opt/pocketbase
  sudo chmod +x "$PB_BIN_PATH"

  # Import PocketBase schema so the viewer has required collections.
  if [[ -f "$REPO_ROOT/backend/pb_schema.json" ]]; then
    echo "Importing PocketBase schema..."
    # Use expect to auto-confirm, or script for pseudo-tty, or manual fallback
    SCHEMA_IMPORTED=false
    if command -v expect >/dev/null 2>&1; then
      expect -c "
        spawn /opt/pocketbase/pocketbase migrate collections import \"$REPO_ROOT/backend/pb_schema.json\" --dir \"$PB_DATA_DIR\" --migrationsDir \"$PB_MIGRATIONS_DIR\"
        expect {
          \"(y/N)\" { send \"y\r\"; exp_continue }
          eof
        }
      " && SCHEMA_IMPORTED=true
    else
      # Try with script command to create pseudo-tty
      script -q -e -c "/opt/pocketbase/pocketbase migrate collections import '$REPO_ROOT/backend/pb_schema.json' --dir '$PB_DATA_DIR' --migrationsDir '$PB_MIGRATIONS_DIR'" /dev/null <<< "y" && SCHEMA_IMPORTED=true || true
    fi
    
    if [[ "$SCHEMA_IMPORTED" == "false" ]]; then
      echo "Note: Auto-import failed. Schema will be imported via API after PocketBase starts."
    fi
    
    /opt/pocketbase/pocketbase migrate up \
      --dir "$PB_DATA_DIR" \
      --migrationsDir "$PB_MIGRATIONS_DIR" || true
  else
    echo "Warning: backend/pb_schema.json not found; skipping schema import."
  fi

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
  
  # Wait for PocketBase to be ready and create admin user (using superuser auth)
  if wait_for_pocketbase "http://localhost:${PB_PORT_DEFAULT}"; then
    FRAME_ADMIN_EMAIL="admin@frame.local"
    FRAME_ADMIN_PASSWORD=$(generate_password)
    
    if create_admin_user "http://localhost:${PB_PORT_DEFAULT}" "$FRAME_ADMIN_EMAIL" "$FRAME_ADMIN_PASSWORD" "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD"; then
      ADMIN_CREATED=true
      echo "Admin credentials generated. They will be shown in the install summary."
    elif [ $? -eq 2 ]; then
      # Admin already exists - credentials unknown
      FRAME_ADMIN_EMAIL="(existing admin - check PocketBase)"
      FRAME_ADMIN_PASSWORD="(not changed)"
    fi
  fi
else
  PB_HOST=$(ask_value "Enter PocketBase URL (http://host:8090)" "$PB_HOST")
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
  
  ADMIN_PORT=$(ask_value "Admin UI port" "$ADMIN_PORT_DEFAULT")
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

DEVICE_ID=$(ask_value "Device ID (optional, leave blank to skip)" "")
DEVICE_KEY=$(ask_value "Device API key (optional)" "")
INTERVAL_MS=$(ask_value "Slide interval ms" "8000")
TRANSITION=$(ask_value "Transition (fade/crossfade/cut)" "fade")

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
DISPLAY_ADMIN_STATUS=$( [ "$ADMIN_CREATED" = true ] && echo "CREATED - save these credentials!" || echo "existing or not created" )

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
