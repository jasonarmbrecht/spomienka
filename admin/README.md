# Admin SPA (React + Vite)

Purpose: authenticated uploads, approvals, library browsing, and settings for the digital frame. Uses PocketBase JS SDK.

## Setup
```
cd admin
npm install
npm run dev
```
Create `.env` with:
```
VITE_PB_URL=https://your-pocketbase.example.com
```

## Pages (scaffolded)
- Login: email/password auth.
- Upload: drag/drop; shows derived status.
- Approvals: admin-only queue to approve/reject.
- Library: filters for pending/published/type/tag.
- Settings: interval/order/transitions, device scopes.

## Notes
- Role field: `role` on user (`admin|user`) determines gate.
- Hooks call PocketBase collection names from `backend/pb_schema.json`.

