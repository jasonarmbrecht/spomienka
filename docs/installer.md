# Raspberry Pi Installer Script

Script: `scripts/install_pi.sh`

## What It Does (Interactive)

- Installs system deps: SDL2, gstreamer, ffmpeg, exiftool, build tools.
- Installs rustup (stable), optional cross target `aarch64-unknown-linux-gnu`.
- Optional PocketBase on the Pi (HTTP by default; TLS optional).
- Optional Admin UI build + local serve via systemd (uses globally installed `serve`).
- Builds the Rust viewer, writes config, and installs a `frame-viewer` systemd unit.
- Clones the repo to `$HOME/spomienka` for persistent installation (defaults to `https://github.com/jasonarmbrecht/spomienka.git` branch `main`; override with `REPO_URL`/`REPO_BRANCH`).

## Usage (On the Pi, 64-bit OS)

```bash
chmod +x scripts/install_pi.sh
./scripts/install_pi.sh
```

Or run directly from the web:
```bash
curl -fsSL https://raw.githubusercontent.com/jasonarmbrecht/spomienka/main/scripts/install_pi.sh | bash
```

## Key Prompts

- Run PocketBase on this Pi? (y/n)
- Serve Admin UI on this Pi? (y/n)
- Enable TLS? default no (for LAN use).
- PB host URL (if remote).
- Admin UI port (if local).
- Device ID/API key (optional if using device auth).
- Slide interval and transition.

## Installation Locations

| Component | Location |
|-----------|----------|
| Repository | `$HOME/spomienka` |
| Viewer binary | `/usr/local/bin/frame-viewer` |
| Viewer config | `/etc/frame-viewer/config.toml` |
| Viewer cache | `/var/cache/frame-viewer` |
| PocketBase binary | `/opt/pocketbase/pocketbase` |
| PocketBase data | `/var/lib/pocketbase` |
| Admin UI source | `$HOME/spomienka/admin` |
| Install summary | `$HOME/spomienka-install-summary.txt` |

## Systemd Services

| Service | Description |
|---------|-------------|
| `pocketbase` | PocketBase server (if installed locally) |
| `frame-admin` | Admin UI static file server (if installed locally) |
| `frame-viewer` | Rust viewer application |

Manage services with:
```bash
sudo systemctl status <service>
sudo systemctl restart <service>
journalctl -u <service> -f
```

## Viewer Configuration

The viewer reads configuration from `/etc/frame-viewer/config.toml`:

```toml
pb_url = "http://localhost:8090"
interval_ms = 8000
transition = "fade"
cache_dir = "/var/cache/frame-viewer"
device_id = ""
device_api_key = ""
```

Environment variables can override config file values:
- `POCKETBASE_URL` or `PB_URL`
- `INTERVAL_MS`
- `TRANSITION`
- `CACHE_DIR`
- `DEVICE_ID`
- `DEVICE_API_KEY`

## Notes

- TLS is skipped by default; add Caddy/NGINX manually if later needed.
- Admin UI remote option: build `admin` and host elsewhere (Netlify/Vercel/S3+CF) with `VITE_PB_URL` pointing to your PocketBase.
- GL driver set to Full KMS via `raspi-config`; may need a reboot.
- To update the installation: `cd $HOME/spomienka && git pull && ./scripts/install_pi.sh`

## Troubleshooting

**Viewer won't start:**
```bash
journalctl -u frame-viewer -f
```

**Admin UI not accessible:**
```bash
journalctl -u frame-admin -f
sudo systemctl restart frame-admin
```

**PocketBase issues:**
```bash
journalctl -u pocketbase -f
# Re-import schema if needed:
/opt/pocketbase/pocketbase migrate collections import \
  $HOME/spomienka/backend/pb_schema.json \
  --dir /var/lib/pocketbase
```
