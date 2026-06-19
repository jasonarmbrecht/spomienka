# Spomienka

A digital picture frame system for Raspberry Pi. Guests upload photos and videos via a web interface; an admin approves them; the frame displays approved media in fullscreen with smooth transitions and blurred backgrounds.

## Quick Start (Raspberry Pi)

```bash
wget -O /tmp/install_pi.py https://raw.githubusercontent.com/jasonarmbrecht/spomienka/main/scripts/install_pi.py && python3 /tmp/install_pi.py
```

The interactive installer sets up all dependencies, PocketBase backend, admin UI, and the Rust viewer with systemd autostart. See [docs/installer.md](docs/installer.md) for advanced options and non-interactive usage.

## Architecture

- **Backend** — PocketBase handles authentication, media storage, EXIF/processing hooks, and realtime sync
- **Admin** — React SPA (Vite + TypeScript) for uploads, approval queue, library management, and device settings
- **Viewer** — Rust native app for Raspberry Pi: SDL2 rendering, GStreamer video, LRU offline cache, and realtime playlist updates

## Repository Structure

```
├── admin/          React admin interface (Vite + TypeScript + PocketBase SDK)
├── backend/        PocketBase schema, hooks, and migrations
├── viewer/         Rust viewer application for Raspberry Pi
├── scripts/        Installation, setup, and development scripts
└── docs/           Architecture and installer documentation
```

## Development

### macOS Setup

Install prerequisites if you don't have them:

```bash
# Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js and npm (for the admin SPA)
brew install node
```

First-time setup (downloads PocketBase, creates local users, and imports schema):

```bash
scripts/setup_dev.sh <admin-email> <admin-password>
```

Start the backend and admin UI:

```bash
scripts/dev.sh
```

This runs PocketBase on `http://localhost:8090` and the admin SPA on `http://localhost:5173`. Open `http://localhost:5173` in your browser to use the admin interface.

> **Note:** The viewer (Rust/SDL2/GStreamer) is designed for Raspberry Pi and is not needed for testing uploads and approvals on macOS. If you want to run it on Mac anyway, install the native dependencies first:
> ```bash
> brew install sdl2 sdl2_image sdl2_ttf gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad
> cd viewer && AUTH_EMAIL=... AUTH_PASSWORD=... cargo run
> ```

To reset the local database:

```bash
scripts/reset_dev.sh
```

To uninstall from a Raspberry Pi:

```bash
scripts/uninstall_pi.sh
```

## Documentation

- [Architecture](docs/architecture.md) — data model, upload flow, viewer internals, and planned features
- [Installer Guide](docs/installer.md) — advanced installation options and configuration
- Component READMEs: [admin/](admin/README.md), [backend/](backend/README.md), [viewer/](viewer/README.md)

## License

MIT — see [LICENSE](LICENSE) for details. Third-party attributions in [ATTRIBUTION.md](ATTRIBUTION.md).
