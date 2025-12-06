# Viewer (Rust)

Fullscreen digital frame slideshow client for Raspberry Pi. Fetches published media from PocketBase and displays with blurred backdrops and fade transitions.

## Installation

**For Pi deployment:** Use `../scripts/install_pi.sh` - it automatically:
- Installs Rust and all dependencies (SDL2, gstreamer, ffmpeg)
- Builds the viewer in release mode
- Generates `/etc/frame-viewer/config.toml` with PocketBase URL and credentials
- Creates and enables systemd service
- Configures display settings interactively

**For development only:**
```bash
# Run with environment config
POCKETBASE_URL=http://localhost:8090 \
AUTH_EMAIL=admin@example.com \
AUTH_PASSWORD=password \
cargo run

# Or create local config.toml
```

## Current Status
✅ **Implemented:**
- PocketBase authentication and media fetching
- Configuration via TOML file or environment variables
- Automatic token refresh on auth failures

🚧 **In Progress:**
- Asset caching and download management
- Rendering layer (SDL2/wgpu + gstreamer)
- Fade transitions and blurred backdrop compositing
- Realtime sync and offline fallback

