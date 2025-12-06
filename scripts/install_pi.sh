#!/usr/bin/env bash
set -euo pipefail

# Digital Frame installer for Raspberry Pi 4 (64-bit)
# - Installs deps (SDL2, gstreamer, ffmpeg), rustup, optional PocketBase, optional local admin UI
# - Builds viewer and sets up systemd units
# - Can auto-fetch this repository if only the script is present
# TLS is optional; default is HTTP for LAN use.

PB_VERSION="${PB_VERSION:-0.22.14}"
ADMIN_PORT_DEFAULT=4173
PB_PORT_DEFAULT=8090
VIEWER_BIN_NAME="frame-viewer"
PB_BIN_PATH="/opt/pocketbase/pocketbase"
PB_DATA_DIR="/var/lib/pocketbase"
VIEWER_CONFIG="/etc/frame-viewer/config.toml"
VIEWER_CACHE="/var/cache/frame-viewer"
REPO_URL="${REPO_URL:-https://github.com/jasonarmbrecht/spomienka.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
ADMIN_PORT_SELECTED="not installed"

ask_yes_no() {
  local prompt="$1" default="$2" answer
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
  read -r -p "$prompt${default:+ [$default]}: " val
  echo "${val:-$default}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. Aborting."; exit 1; }
}

echo "=== Digital Frame Installer (Pi 4, 64-bit) ==="
require_cmd sudo

# Locate or fetch repo so we have viewer/admin/backend assets
ORIG_SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd "$ORIG_SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
if [[ ! -f "$REPO_ROOT/admin/package.json" || ! -d "$REPO_ROOT/viewer" ]]; then
  echo "Project files not found next to script. Fetching repo from ${REPO_URL} (branch ${REPO_BRANCH})..."
  TMP_DIR=$(mktemp -d)
  if command -v git >/dev/null 2>&1; then
    git clone --depth=1 --branch "$REPO_BRANCH" "$REPO_URL" "$TMP_DIR/spomienka"
    REPO_ROOT="$TMP_DIR/spomienka"
  else
    echo "git not found; using tarball download..."
    curl -L "${REPO_URL%.git}/archive/refs/heads/${REPO_BRANCH}.tar.gz" -o "$TMP_DIR/repo.tar.gz"
    tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"
    REPO_ROOT="$(echo "$TMP_DIR"/spomienka-*)"
  fi
  ORIG_SCRIPT_DIR="$REPO_ROOT/scripts"
  echo "Fetched repo into $REPO_ROOT"
fi

ARCH=$(uname -m)
if [[ "$ARCH" != "aarch64" ]]; then
  echo "Warning: Expected aarch64 on Pi 4; got $ARCH. Continue anyway? (y/n)"
  ask_yes_no "Continue" "n" || exit 1
fi

PB_ON_PI=false
ADMIN_LOCAL=false
ENABLE_TLS=false

ask_yes_no "Run PocketBase on this Pi?" "y" && PB_ON_PI=true
ask_yes_no "Serve Admin UI on this Pi?" "y" && ADMIN_LOCAL=true
ask_yes_no "Enable TLS/HTTPS termination here?" "n" && ENABLE_TLS=true

echo "Updating apt and installing base dependencies..."
sudo apt update
sudo apt upgrade -y
sudo apt install -y git build-essential pkg-config cmake libssl-dev libudev-dev \
  libasound2-dev libxcb-shape0-dev libxcb-xfixes0-dev libsdl2-dev libsdl2-image-dev libsdl2-ttf-dev \
  ffmpeg gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-alsa gstreamer1.0-tools \
  exiftool curl unzip

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
  PB_URL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_arm64.zip"
  curl -L "$PB_URL" -o /tmp/pb.zip
  unzip -o /tmp/pb.zip -d /opt/pocketbase
  sudo chmod +x "$PB_BIN_PATH"
  sudo tee /etc/systemd/system/pocketbase.service >/dev/null <<EOF
[Unit]
Description=PocketBase
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$PB_BIN_PATH serve --http=0.0.0.0:${PB_PORT_DEFAULT} --dir $PB_DATA_DIR
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
  echo "Import schema via Admin UI or CLI:"
  echo "  $PB_BIN_PATH admin import /path/to/backend/pb_schema.json --dir $PB_DATA_DIR"
else
  PB_HOST=$(ask_value "Enter PocketBase URL (http://host:8090)" "$PB_HOST")
fi

if $ADMIN_LOCAL; then
  echo "Installing Node (NodeSource) for admin build..."
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
  fi
  ADMIN_PORT=$(ask_value "Admin UI port" "$ADMIN_PORT_DEFAULT")
  echo "Building admin SPA against PocketBase at ${PB_HOST}..."
  (
    cd "$REPO_ROOT/admin"
    npm install
    VITE_PB_URL="${PB_HOST}" npm run build
  )
  ADMIN_PORT_SELECTED="$ADMIN_PORT"
  sudo tee /etc/systemd/system/frame-admin.service >/dev/null <<EOF
[Unit]
Description=Frame Admin UI
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$REPO_ROOT/admin
ExecStart=$(command -v npx) serve -s dist -l ${ADMIN_PORT}
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
EOF
sudo mv /tmp/frame-viewer-config.toml "$VIEWER_CONFIG"

sudo tee /etc/systemd/system/frame-viewer.service >/dev/null <<EOF
[Unit]
Description=Frame Viewer
After=network-online.target
Wants=network-online.target

[Service]
Environment=RUST_LOG=info
Environment=POCKETBASE_URL=${PB_HOST}
ExecStart=/usr/local/bin/${VIEWER_BIN_NAME}
WorkingDirectory=/home/$USER
Restart=always
User=$USER

[Install]
WantedBy=graphical.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now frame-viewer

SUMMARY_FILE="/tmp/spomienka-install-summary.txt"
cat > "$SUMMARY_FILE" <<EOF
=== Spomienka Install Summary ===
Status: completed (script uses 'set -e' so earlier errors would have aborted)

PocketBase:
  Location: $([ "$PB_ON_PI" = true ] && echo "local on this Pi" || echo "remote")
  URL: ${PB_HOST}
  Data dir: $PB_DATA_DIR
  Service: pocketbase (systemd) $([ "$PB_ON_PI" = true ] && echo "ENABLED" || echo "not installed")

Admin UI:
  Mode: $([ "$ADMIN_LOCAL" = true ] && echo "local on this Pi" || echo "not installed (deploy elsewhere)")
  URL: $([ "$ADMIN_LOCAL" = true ] && echo "http://$(hostname -I | awk '{print $1}'):${ADMIN_PORT_SELECTED}" || echo "N/A")
  Build target PocketBase: ${PB_HOST}

Viewer:
  Service: frame-viewer (systemd) ENABLED
  Binary: /usr/local/bin/${VIEWER_BIN_NAME}
  Config: $VIEWER_CONFIG
  Cache: $VIEWER_CACHE

Device credentials (as provided):
  Device ID: ${DEVICE_ID:-"(none)"}
  Device API key: ${DEVICE_KEY:-"(none)"}

Notes:
- PocketBase admin credentials are not generated by this installer; create an admin user in PocketBase if needed.
- Logs: journalctl -u pocketbase -f (if installed), journalctl -u frame-admin -f (if installed), journalctl -u frame-viewer -f
- If the GL driver was changed, a reboot is recommended.
EOF

echo "=== Install complete ==="
cat "$SUMMARY_FILE"
echo "Summary saved to $SUMMARY_FILE"

