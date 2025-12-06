# Digital Picture Frame (PocketBase + React Admin + Rust Viewer)

Custom digital frame stack: PocketBase backend for media/auth, React admin for uploads/approvals, and a native Rust viewer on Raspberry Pi with blurred backgrounds, fades, and plugin-friendly architecture.

## Structure
- `backend/` – PocketBase schema, hooks, and media pipeline notes.
- `admin/` – React (Vite) admin SPA skeleton using PocketBase SDK.
- `viewer/` – Native Rust viewer targeting Raspberry Pi (SDL2 + gstreamer + wgpu-ready).
- `docs/` – Architecture and operations guides.

## Quick Start (high level)
1) Backend: run PocketBase, apply collections, set env, enable ffmpeg/gstreamer on the server.
2) Admin: `cd admin && npm install && npm run dev` (after filling env pointing to PocketBase).
3) Viewer: `cd viewer && cargo run --release` on the Pi; systemd unit provided in docs to autostart.
4) Pi installer: run `scripts/install_pi.sh` on a fresh Pi to install deps, optional PocketBase/admin, and set up the viewer service.

See `docs/architecture.md` for flows, approvals, and plugin model.

