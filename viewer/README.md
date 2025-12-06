# Rust Viewer (Pi)

Goals: fullscreen slideshow with blurred backdrops, fades, and video support; autostart via systemd.

## Stack
- Rust async for syncing with PocketBase.
- Rendering/video: plan to use SDL2 + gstreamer (or wgpu + gstreamer) on the Pi. Kept behind feature flags in `Cargo.toml` for now.

## Run (dev)
```
POCKETBASE_URL=http://localhost:8090 cargo run
```

## Next Implementation Steps
- Add asset cache (e.g., `dirs` + file hashing) and download published assets.
- Integrate gstreamer for video playback; SDL2/wgpu for textured rendering and fades.
- Implement playlist refresh via PocketBase realtime; fallback to cached list when offline.
- Config via `config` crate (interval, shuffle, transition, device scopes).

## systemd unit (example)
```
[Unit]
Description=Frame Viewer
After=network-online.target

[Service]
Environment=POCKETBASE_URL=https://pocketbase.example.com
ExecStart=/usr/bin/frame-viewer
Restart=always
User=pi
WorkingDirectory=/home/pi/frame-viewer

[Install]
WantedBy=graphical.target
```

