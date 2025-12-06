# Admin SPA

Web interface for authenticated uploads, approvals, library management, and system settings. Built with React + Vite + PocketBase JS SDK.

## Installation

**For Pi deployment:** Use `../scripts/install_pi.sh` - it automatically builds and configures everything, including the PocketBase URL.

**For development only:**
```bash
cd admin
npm install

# Create .env with your PocketBase instance
echo "VITE_PB_URL=http://localhost:8090" > .env

npm run dev
```

## Pages
- **Login**: Email/password authentication
- **Upload**: Drag-and-drop upload with processing status
- **Approvals**: Admin-only queue to approve/reject pending uploads
- **Library**: Browse and filter media by status, type, and tags
- **Settings**: Configure display intervals, transitions, and device scopes
- **Users**: Manage user accounts and permissions (admin only)

## Authorization
User `role` field (`admin` or `user`) controls access. Admins can approve media and manage users; regular users can only upload.

