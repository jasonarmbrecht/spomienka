# Spomienka

A digital picture frame system for Raspberry Pi with web-based photo/video uploads, approval workflows, and native fullscreen viewing. Features automatic media processing, blurred backgrounds, smooth transitions, and device-specific playlists.

## Installation

Run this single command on your Raspberry Pi:

```bash
wget -O /tmp/install_pi.sh https://raw.githubusercontent.com/jasonarmbrecht/spomienka/main/scripts/install_pi.sh && chmod +x /tmp/install_pi.sh && /tmp/install_pi.sh
```

The interactive installer will set up everything: dependencies, PocketBase backend, admin UI, and the Rust viewer with systemd autostart.

## Architecture

- **Backend**: PocketBase (authentication, media storage, approvals, realtime sync)
- **Admin**: React SPA for uploads, approvals, library management, and settings
- **Viewer**: Rust native app for Raspberry Pi with fullscreen kiosk mode

## Documentation

- [Architecture Details](docs/architecture.md) - Data model, flows, and planned features
- [Installer Guide](docs/installer.md) - Advanced installation options and configuration
- Component READMEs: [admin/](admin/README.md), [backend/](backend/README.md), [viewer/](viewer/README.md)

## Repository Structure

```
├── admin/        React admin interface (Vite + PocketBase SDK)
├── backend/      PocketBase schema and hooks for media processing
├── viewer/       Rust viewer application for Raspberry Pi
├── scripts/      Installation scripts
└── docs/         Architecture and setup documentation
```

## License

See individual component directories for licensing details.
