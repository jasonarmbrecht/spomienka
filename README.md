# Digital Picture Frame (PocketBase + React Admin + Rust Viewer)

PocketBase backend for auth/media, React admin for uploads/approvals, and a native Rust viewer on Raspberry Pi with blurred backgrounds, fades, and plugin-friendly architecture. A single installer script can set up the Pi (viewer + optional PocketBase + optional local admin UI).

## Repo layout
- `backend/` – PocketBase schema (`pb_schema.json`), hooks/media pipeline notes.
- `admin/` – React (Vite) admin SPA using PocketBase SDK.
- `viewer/` – Rust viewer targeting Pi (SDL2 + gstreamer; wgpu-ready).
- `docs/` – Architecture and installer notes.
- `scripts/` – Pi installer.

## Easiest path: installer on the Pi
```
chmod +x scripts/install_pi.sh
./scripts/install_pi.sh
```
Or one-line fetch + run on the Pi:
```
wget -O /tmp/install_pi.sh https://raw.githubusercontent.com/jasonarmbrecht/spomienka/main/scripts/install_pi.sh && chmod +x /tmp/install_pi.sh && /tmp/install_pi.sh
```
The script is interactive and can:
- Install deps (SDL2, gstreamer, ffmpeg, rustup, etc.).
- Run PocketBase locally (HTTP by default; TLS optional).
- Build/serve the admin UI locally (optional).
- Build and install the viewer with a systemd unit.
- Auto-fetch this repo if only the script is downloaded (defaults to github.com/jasonarmbrecht/spomienka, branch main).
See `docs/installer.md` for details and environment overrides (`REPO_URL`, `REPO_BRANCH`).

## Manual notes
- Backend: run PocketBase, import `backend/pb_schema.json`, add `role` field to users, wire ffmpeg/exif hooks.
- Admin: `cd admin && npm install && npm run dev` (set `VITE_PB_URL`).
- Viewer: `cd viewer && cargo run --release` on the Pi; see `viewer/README.md` for systemd example.

See `docs/architecture.md` for flows, approvals, transitions, and plugin model.

