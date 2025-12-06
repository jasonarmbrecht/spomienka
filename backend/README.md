# Backend (PocketBase) Setup

## Collections
- Defined in `pb_schema.json`: `media`, `approvals`, `devices`, `plugins`.
- Users: built-in PocketBase auth with `role` text field (`admin|user`).

## Rules (summary)
- Users can upload, but only admins can publish/approve.
- Published media is world-readable to authenticated users; pending is visible only to owner/admin.
- Devices and plugins are admin-only.

## Hooks (outline)
Implement with PocketBase JS/Go hooks:
- `beforeCreate(media)`: set `status` to `pending` unless uploader is admin; compute checksum to dedupe.
- `afterCreate/afterUpdate(media)`: enqueue processing job:
  - Extract EXIF (`exifr` or `exiftool` via exec).
  - Images: `ffmpeg -i input -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" -q:v 3 display.jpg`; blurred backdrop via `ffmpeg -vf "gblur=sigma=30,scale=1920:1080"`.
  - Videos: transcode to H.264 1080p `ffmpeg -i input -vf scale=1920:-2 -c:v libx264 -preset medium -crf 22 -c:a aac output.mp4`; grab poster `-ss 00:00:01 -vframes 1 poster.jpg`.
  - Update `media` with derived URLs/paths and metadata (duration, width/height, orientation).
- `approvals` hook: when status=approved, set related `media.status = 'published'` and `approvedBy`.

## Processing Worker
- Option A: run inside PocketBase hook with async exec.
- Option B: separate worker (Go/Node) watching PocketBase realtime `media` events to offload heavy ffmpeg work.

## Realtime Feeds
- Viewer subscribes to `media` where `status='published'`; optionally filter by `deviceScopes`.
- Admin subscribes to `media` where `status='pending'` for approvals queue.

## Storage
- Default: local filesystem. For multi-device/remote: configure S3-compatible bucket; set PocketBase file storage env.

## Dev Boot
1) Download PocketBase binary.
2) Run `./pocketbase serve`.
3) Import `pb_schema.json` via admin UI or CLI.
4) Create admin user; add `role='admin'` field.
5) Configure CORS to allow admin SPA origin and viewer origin.

