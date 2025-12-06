# Viewer (Rust)

Fullscreen digital frame slideshow client for Raspberry Pi. Fetches published media from PocketBase and displays with blurred backdrops, transitions, and video support.

## Features

- **SDL2 Rendering**: Hardware-accelerated fullscreen display
- **Transitions**: Fade, crossfade, and cut transitions between slides
- **Blurred Backgrounds**: Aspect-fit images with stretched blurred backdrop
- **Video Playback**: GStreamer-based video with seamless looping for short clips
- **Offline Cache**: LRU cache with configurable size limit for offline operation
- **Realtime Sync**: WebSocket subscription for instant playlist updates
- **Device Filtering**: Show media only scoped to this device via tags/deviceScopes

## Installation

**For Pi deployment:** Use `../scripts/install_pi.sh` - it automatically:
- Installs Rust and all dependencies (SDL2, GStreamer, FFmpeg)
- Builds the viewer in release mode
- Generates `/etc/frame-viewer/config.toml` with PocketBase URL and credentials
- Creates and enables systemd service
- Configures display settings interactively

**For development only:**
```bash
# Install dependencies (Ubuntu/Debian)
sudo apt install libsdl2-dev libsdl2-image-dev libsdl2-ttf-dev \
    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad

# Run with environment config
POCKETBASE_URL=http://localhost:8090 \
AUTH_EMAIL=admin@example.com \
AUTH_PASSWORD=password \
cargo run

# Or create local config.toml
```

## Configuration

Configuration is loaded from (in order of precedence):
1. Environment variables
2. `/etc/frame-viewer/config.toml`
3. `./config.toml` (for development)

### Options

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `pb_url` | `POCKETBASE_URL` | `http://localhost:8090` | PocketBase API URL |
| `interval_ms` | `INTERVAL_MS` | `8000` | Slide display duration (ms) |
| `transition` | `TRANSITION` | `fade` | Transition type: `fade`, `crossfade`, `cut` |
| `transition_duration_ms` | `TRANSITION_DURATION_MS` | `1000` | Transition animation duration (ms) |
| `cache_dir` | `CACHE_DIR` | `/var/cache/frame-viewer` | Local cache directory |
| `cache_size_limit_gb` | `CACHE_SIZE_LIMIT_GB` | `10` | Maximum cache size in GB |
| `device_id` | `DEVICE_ID` | (none) | Device ID for filtering media |
| `auth_email` | `AUTH_EMAIL` | (none) | PocketBase user email |
| `auth_password` | `AUTH_PASSWORD` | (none) | PocketBase user password |
| `auth_token` | `AUTH_TOKEN` | (none) | Direct PocketBase auth token |
| `enable_realtime` | `ENABLE_REALTIME` | `true` | Enable WebSocket sync |
| `video_loop_threshold_sec` | `VIDEO_LOOP_THRESHOLD_SEC` | `30` | Videos shorter than this loop |
| `shuffle` | `SHUFFLE` | `false` | Shuffle playlist order |

### Example config.toml

```toml
pb_url = "http://192.168.1.100:8090"
interval_ms = 10000
transition = "crossfade"
transition_duration_ms = 1500
cache_dir = "/var/cache/frame-viewer"
cache_size_limit_gb = 20
device_id = "living-room-frame"
auth_email = "viewer@example.com"
auth_password = "secure-password"
enable_realtime = true
video_loop_threshold_sec = 30
shuffle = true
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Main Loop                             │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌───────────────┐  │
│  │Renderer │  │  Video   │  │  Cache  │  │   Realtime    │  │
│  │ (SDL2)  │  │(GStreamer)│ │  (LRU)  │  │  (WebSocket)  │  │
│  └────┬────┘  └────┬─────┘  └────┬────┘  └───────┬───────┘  │
│       │            │             │               │           │
│       └────────────┴──────┬──────┴───────────────┘           │
│                           │                                   │
│                    ┌──────┴──────┐                           │
│                    │Asset Manager│                           │
│                    └──────┬──────┘                           │
│                           │                                   │
└───────────────────────────┼───────────────────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  PocketBase   │
                    │    Server     │
                    └───────────────┘
```

### Modules

- **renderer.rs**: SDL2 window, texture management, transitions, aspect-fit rendering
- **video.rs**: GStreamer pipeline for video playback with seamless looping
- **cache.rs**: LRU cache with download, eviction, and playlist persistence
- **assets.rs**: Asset loading, preloading, texture creation
- **realtime.rs**: PocketBase WebSocket subscription for live updates

## Offline Mode

When the network is unavailable:
1. Assets are served from the local cache
2. The cached playlist (`playlist.json`) is used
3. When the connection is restored, realtime sync resumes automatically

## Device-Specific Filtering

Media can be scoped to specific devices using the `deviceScopes` field:
- Empty/null `deviceScopes`: Media shows on all devices
- Array of device IDs: Media only shows on listed devices

Configure `device_id` in the viewer to filter the playlist.

## Keyboard Controls

- **ESC** or **Q**: Quit the viewer

## Logging

Set the `RUST_LOG` environment variable for debug output:
```bash
RUST_LOG=frame_viewer=debug ./frame-viewer
```

Logs are sent to stderr, which systemd captures in journald:
```bash
journalctl -u frame-viewer -f
```
