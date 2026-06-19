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

First-time setup (creates local PocketBase users and imports schema):

```bash
scripts/setup_dev.sh <admin-email> <admin-password>
```

Start all services for development:

```bash
scripts/dev.sh
```

This runs PocketBase on `http://localhost:8090` and the admin SPA on `http://localhost:5173`. Run the viewer separately:

```bash
cd viewer && AUTH_EMAIL=... AUTH_PASSWORD=... cargo run
```

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
