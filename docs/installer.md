# Raspberry Pi Installer Script

Script: `scripts/install_pi.sh`

What it does (interactive):
- Installs system deps: SDL2, gstreamer, ffmpeg, exiftool, build tools.
- Installs rustup (stable), optional cross target `aarch64-unknown-linux-gnu`.
- Optional PocketBase on the Pi (HTTP by default; TLS optional).
- Optional Admin UI build + local serve via systemd.
- Builds the Rust viewer, writes config, and installs a `frame-viewer` systemd unit.
- Auto-fetches the repo if only the script is present (defaults to `https://github.com/jasonarmbrecht/spomienka.git` branch `main`; override with `REPO_URL`/`REPO_BRANCH`).

Usage (on the Pi, 64-bit OS):
```
chmod +x scripts/install_pi.sh
./scripts/install_pi.sh
```

Key prompts:
- Run PocketBase on this Pi? (y/n)
- Serve Admin UI on this Pi? (y/n)
- Enable TLS? default no (for LAN use).
- PB host URL (if remote).
- Admin UI port (if local).
- Device ID/API key (optional if using device auth).
- Slide interval and transition.

Outputs/config:
- PocketBase: `/etc/systemd/system/pocketbase.service` (if chosen), data in `/var/lib/pocketbase`.
- Admin (local option): `frame-admin.service` serving `admin/dist` via `serve`.
- Viewer: binary in `/usr/local/bin/frame-viewer`, config at `/etc/frame-viewer/config.toml`, service `frame-viewer.service`, cache in `/var/cache/frame-viewer`.

Notes:
- TLS is skipped by default; add Caddy/NGINX manually if later needed.
- Admin UI remote option: build `admin` and host elsewhere (Netlify/Vercel/S3+CF) with `VITE_PB_URL` pointing to your PocketBase.
- GL driver set to Full KMS via `raspi-config`; may need a reboot.

