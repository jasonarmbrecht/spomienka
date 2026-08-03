# Raspberry Pi Installer Script

Script: `scripts/install_pi.py`

## What It Does (Interactive)

- Installs system deps: SDL2, gstreamer, ffmpeg, exiftool, build tools.
- Installs rustup (stable), optional cross target `aarch64-unknown-linux-gnu`.
- Optional PocketBase on the Pi (HTTP by default; TLS optional).
- Optional Admin UI build + local serve via systemd (uses globally installed `serve`).
- Builds the Rust viewer, writes config, and installs a `frame-viewer` systemd unit.
- Clones the repo to `$HOME/spomienka` for persistent installation (defaults to `https://github.com/jasonarmbrecht/spomienka.git` branch `main`; override with `REPO_URL`/`REPO_BRANCH`).

## Step-by-Step: Raspberry Pi OS Setup

This walks through a fresh Pi 4 setup targeting **Raspberry Pi OS Lite
(64-bit)** as a headless kiosk — no desktop environment, the viewer owns the
display directly via KMSDRM. A minimum of **4GB RAM is recommended** for
building the viewer natively on-device (see [Resource Notes](#resource-notes)
below for what to do with less).

1. **Flash the SD card.** Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
   to write **Raspberry Pi OS Lite (64-bit)**. In the imager's advanced
   options (gear icon / Ctrl+Shift+X), pre-configure a hostname, enable SSH,
   and set a username/password so you can connect headlessly on first boot.
2. **Boot the Pi and SSH in:**
   ```bash
   ssh <username>@<hostname>.local
   ```
3. **(Optional) Prepare USB storage.** If you want PocketBase's data and the
   viewer's cache on a USB drive instead of the SD card — recommended, since
   both take frequent writes — or want a separate drive for automatic
   backups, prepare the drive(s) now. See
   [USB Storage Setup](#usb-storage-setup-optional) below; the installer
   only validates an already-mounted path, it does not partition or format
   anything itself.
4. **Run the installer.** Either directly from the web:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/jasonarmbrecht/spomienka/main/scripts/install_pi.py | python3
   ```
   or clone the repo first and run it locally:
   ```bash
   git clone https://github.com/jasonarmbrecht/spomienka.git
   chmod +x spomienka/scripts/install_pi.py
   ./spomienka/scripts/install_pi.py
   ```
5. **Answer the interactive prompts** — see [Key Prompts](#key-prompts) below.
   Installation then proceeds automatically (apt packages, Rust toolchain,
   PocketBase, admin UI, viewer build, systemd services).
6. **Reboot.** The installer sets the GL driver to Full KMS via
   `raspi-config`, which requires a reboot to take effect:
   ```bash
   sudo reboot
   ```
7. **Verify services are running** after reboot:
   ```bash
   sudo systemctl status pocketbase frame-viewer
   journalctl -u frame-viewer -f
   ```
   The viewer should come up fullscreen on the attached display within a few
   seconds of `frame-viewer` starting.

## Key Prompts

- Run PocketBase on this Pi? (y/n)
- Serve Admin UI on this Pi? (y/n)
- Enable TLS? default no (for LAN use).
- PB host URL (if remote).
- Admin UI port (if local).
- Storage for PocketBase data + viewer cache: the installer detects candidate drives and lets you pick one by number, type a custom mount path, or leave blank for the SD card. It lists both already-mounted filesystems (via `findmnt`) and plugged-in, already-formatted drives that aren't mounted yet (via `lsblk`) — picking the latter has the installer create the mount point, add an `/etc/fstab` entry, and mount it for you. It never runs `mkfs`/`fdisk`; an unformatted drive won't show up until you format it yourself (see [USB Storage Setup](#usb-storage-setup-optional)).
- Configure automatic PocketBase backups? (y/n, only if PocketBase runs locally).
  - Backup frequency (daily/weekly).
  - Backup storage: same detected-drive picker as above (leave blank to store backups alongside the primary data).
- Device ID/API key (optional if using device auth).
- Slide interval and transition.

## USB Storage Setup (Optional)

The installer detects and auto-mounts drives for you, but it will **never
run `mkfs`/`fdisk`** — partitioning and formatting always stay a manual,
human-run step, so a script can never wipe the wrong device. Everything
after formatting (mount point, fstab entry, mounting) is handled by the
installer's storage prompts automatically.

```bash
# 1. Identify the drive (look for its device name, e.g. /dev/sda1):
lsblk

# 2. Format it — DESTROYS ALL DATA on the drive. Skip if it's already
#    formatted and you want to keep what's on it:
sudo mkfs.ext4 /dev/sda1
```

That's it — plug the drive in (or leave it plugged in) and run the
installer. At the storage prompts, it will list `/dev/sda1` as detected but
not yet mounted; picking it creates the mount point (`/mnt/spomienka-sda1`),
adds the `/etc/fstab` entry (by UUID, with `nofail` so boot never hangs if
the drive is later unplugged), and mounts it — no manual `blkid`/`fstab`/
`mount` steps needed.

If you'd rather do the mount yourself (e.g. to control the mount point name
or mount options), you still can — anything already mounted when the
installer runs shows up in the same picker, used as-is:

```bash
sudo blkid /dev/sda1
sudo mkdir -p /mnt/spomienka-data
echo 'UUID=<uuid-from-blkid> /mnt/spomienka-data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
sudo mount -a
mountpoint /mnt/spomienka-data
```

Repeat with a second drive (formatted, plugged in — or manually mounted at a
different path) if you want a separate backup drive. Both drives are
optional and independent: you can use one for primary storage only, one for
backups only (backups work even if primary data stays on the SD card), both,
or neither.

## Installation Locations

| Component | Location |
|-----------|----------|
| Repository | `$HOME/spomienka` |
| Viewer binary | `/usr/local/bin/frame-viewer` |
| Viewer config | `/etc/frame-viewer/config.toml` |
| Viewer cache | `/var/cache/frame-viewer` (or `<mount>/frame-viewer-cache` if configured) |
| PocketBase binary | `/opt/pocketbase/pocketbase` |
| PocketBase data | `/var/lib/pocketbase` (or `<mount>/pocketbase` if configured) |
| PocketBase backups | `<PocketBase data>/backups` (symlinked to the backup drive if configured) |
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

## Resource Notes

Building the viewer (`cargo build --release`) natively on-device compiles
several native/bindgen-heavy crates (SDL2, GStreamer bindings, `ring` via
`rustls-tls`) — on a constrained board this can exhaust RAM.

- **4GB Pi 4** (recommended minimum): the installer temporarily grows swap
  via `dphys-swapfile` (to 2048MB) and caps the build to `--jobs 2` for the
  duration of the build, then restores the original swap size afterward.
  Expect the build to take roughly 15-25 minutes.
- **2GB Pi 4 or less**: native builds are not recommended even with the
  swap/job-cap mitigation — they're likely to be very slow or still hit
  memory pressure. Cross-compile from a more powerful machine instead using
  the `aarch64-unknown-linux-gnu` rustup target (the installer offers to add
  this target for you) and copy the resulting binary to
  `/usr/local/bin/frame-viewer` on the Pi.
- **8GB Pi 4**: native build should complete without issue; the swap/job-cap
  behavior still applies but is unlikely to be needed.

## Notes

- TLS is skipped by default; add Caddy/NGINX manually if later needed.
- Admin UI remote option: build `admin` and host elsewhere (Netlify/Vercel/S3+CF) with `VITE_PB_URL` pointing to your PocketBase.
- GL driver set to Full KMS via `raspi-config`; may need a reboot.
- The viewer targets KMSDRM directly (`SDL_VIDEODRIVER=kmsdrm` set in
  `frame-viewer.service`) for a headless/Lite kiosk boot — it does not
  require or expect a desktop (Wayland/X11) session to be running. The
  service's `SupplementaryGroups=video render input` grants the `/dev/dri`
  access this requires without needing a separate `usermod`/reboot step.
- If primary storage is on a separate drive, `pocketbase.service` and
  `frame-viewer.service` both carry `RequiresMountsFor=<mount>` so they
  won't start — and PocketBase won't silently initialize a fresh empty DB on
  the SD card underneath an unmounted mount point — until the drive is
  actually mounted. Automatic backups are configured through PocketBase's
  built-in cron backups (Settings → Backups in the admin UI), not a custom
  script.
- To update the installation: `cd $HOME/spomienka && git pull && ./scripts/install_pi.py`

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
