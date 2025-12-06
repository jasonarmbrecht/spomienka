# Architecture Overview

## Components
- PocketBase backend (auth, media, approvals, realtime playlist).
- React admin SPA (upload, approvals, library, settings).
- Rust native viewer on Raspberry Pi (SDL2 + gstreamer; wgpu-ready) with blurred backgrounds and fades.
- Optional plugin layer for custom transitions/data sources.

## Data Model (PocketBase)
- `users`: built-in; roles via `role` field (`admin`, `user`).
- `media`: file (image/video), metadata (title, takenAt, orientation, width/height, duration, type), status (`pending|published|rejected`), `approvedBy`, `owner`, derived asset paths (`displayUrl`, `blurUrl`, `thumbUrl`, `videoUrl`, `posterUrl`), `checksum`, `tags`, `deviceScopes` (optional per-device playlisting).
- `approvals`: optional audit record with `media`, `status`, `reviewer`, `notes`, `reviewedAt`.
- `devices` (optional): register frame instances, store lastSeen, config (interval, shuffle, transitions set).
- `plugins`: registry with manifest URL/path and allowed capabilities.

## Access Rules (PocketBase)
- Users can create media as `pending`, read only their own pending items; cannot publish.
- Admins can read/write all media; setting `status=published` exposes to viewers.
- Realtime subscriptions: viewer subscribes to published media feed; admin subscribes to pending approvals.

## Upload & Processing Flow
1) Admin or user uploads via React UI to PocketBase `media`.
2) PocketBase hook runs:
   - Extract EXIF (orientation, takenAt).
   - For images: generate 1080p fit variant + blurred backdrop (e.g., Gaussian on downscaled image) + thumb.
   - For videos: transcode to H.264 1080p (ffmpeg), generate poster frame, store duration; optionally discard original to save space.
3) If uploader is `admin`, auto-set `status=published`; else remain `pending` until admin approval.
4) Viewer consumes only `published` media, caching derived assets locally.

## Viewer (Rust) Responsibilities
- Autostart on boot (systemd), kiosk fullscreen.
- Preload next item, crossfade/fade-to-black transitions.
- Aspect-fit main image/video with blurred/stretch background.
- Video playback via gstreamer; seekless looping for short clips if desired.
- Offline cache: periodic sync to PocketBase; serve from disk when offline.
- Hot-reload playlist via PocketBase realtime; fallback to last cached list.
- Config: interval, shuffle/order, transition type, device-specific filters (tags/deviceScopes).

## Admin SPA (React)
- Pages: login, upload (drag/drop), approvals queue (bulk approve/reject), library with filters, settings (interval/order/transitions), device list (optional).
- Uses PocketBase JS SDK; role-gated routes; optimistic actions for approvals.

## Plugins
- Manifest (`plugin.json`): id, version, capabilities (transition, data-source, filter), entrypoint (shared lib `.so/.dll` or command), config schema.
- Transition plugin: given two frames (textures) + time, returns rendered frame.
- Data-source plugin: yields media records or filters; must map to `media` schema before publish.
- Sandbox: load from dedicated dir with allowlist; validate checksum/signature.

## Deployment Notes
- Pi: enable GL driver, install `ffmpeg`, `gstreamer` plugins, run viewer under `systemd`, set `chromium` unused (native app).
- Backend: containerize PocketBase + ffmpeg; set storage (local or S3); nightly backups; TLS termination (Caddy/NGINX).
- Admin: static hosting (Netlify/Vercel/S3+CF) pointing to PocketBase API.
- Monitoring: viewer logs to journald; PocketBase backups; disk-usage alerts.

## Open Choices
- Keep originals after transcode? configurable `keepOriginal` flag.
- Tagging/collections and device-specific schedules are supported via `tags` + `deviceScopes`.
- Plugins scope: start with transitions/data-sources; avoid approval logic plugins for safety.

