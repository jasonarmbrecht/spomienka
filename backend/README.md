# Backend (PocketBase)

PocketBase provides authentication, database, file storage, and media processing via hooks.

## Collections
Defined in `pb_schema.json`:
- **users**: Built-in auth collection with `role` field (`admin` or `user`)
- **media**: Uploaded images/videos with processing status and derived assets
- **approvals**: Admin review queue with approve/reject workflow
- **devices**: Registered viewer devices with API keys and config
- **plugins**: Future extensibility (not currently used)

## Access Rules
- Users can upload media; admins can publish/approve
- Published media is visible to all authenticated users; pending media only to owner/admin
- Devices and approvals are admin-only

## Hooks
Implemented in `pb_hooks/media.pb.js`:

**Media Upload (`beforeCreate`):**
- Auto-set owner to current user
- Admins auto-publish; regular users set to `pending`

**Media Processing (`afterCreate`):**
- Extract EXIF metadata (dimensions, orientation, timestamp)
- Compute SHA256 checksum for deduplication
- **Images**: Generate display (1080p fit), blurred backdrop, and thumbnail
- **Videos**: Transcode to H.264 1080p, extract poster frame and thumbnail, blur backdrop
- Processing runs asynchronously in background; status tracked via `processingStatus` field

**Approvals (`afterCreate`):**
- Approved items: set `media.status = 'published'` and populate `approvedBy`
- Rejected items: set `media.status = 'rejected'`

## Requirements
- `ffmpeg` - video/image processing
- `exiftool` - metadata extraction
- `sha256sum` - checksum generation

## Installation

**For Pi deployment:** Use `../scripts/install_pi.sh` - it automatically:
- Installs PocketBase and all dependencies (ffmpeg, exiftool, sha256sum)
- Imports the schema from `pb_schema.json`
- Installs hooks from `pb_hooks/`
- Creates superuser and admin accounts with secure passwords
- Sets up systemd service

**For development only:**
```bash
# Download PocketBase binary for your platform
wget https://github.com/pocketbase/pocketbase/releases/latest/download/pocketbase_linux_amd64.zip
unzip pocketbase_linux_amd64.zip

# Import schema
./pocketbase migrate collections import pb_schema.json

# Copy hooks
cp -r pb_hooks/ pb_data/pb_hooks/

# Run PocketBase
./pocketbase serve

# Create admin user via UI (http://127.0.0.1:8090/_/), set role='admin'
```

## Storage
Local filesystem by default. For multi-device deployments, configure S3-compatible storage via environment variables.

