// Media processing hooks for PocketBase 0.25
//
// Each callback uses require(__hooks + '/utils.js') to load shared helpers.
// PocketBase 0.25 JSVM runs callbacks in isolated goja VM instances, so
// module-level definitions are not in scope — require() is the solution.
//
// Known PB 0.25 JSVM constraints:
//   - e.requestInfo is undefined inside model hooks like onRecordCreate (it
//     only exists on custom route handlers) — there is no way to read a
//     request field that isn't also a schema field. Auth is enforced by
//     collection API rules and owner/role are read from the record body /
//     a DB lookup instead of request auth.
//   - $app.runInBackground does not exist; processing runs synchronously in
//     after-hooks, wrapped in try/catch so failures never affect the response.

// ---------------------------------------------------------------------------
// Media: before create — auth check, validate, set owner and status
// ---------------------------------------------------------------------------

onRecordCreate((e) => {
    const { checkRateLimit, validateStringArray } = require(__hooks + "/utils.js");

    const record = e.record;

    // Auth is enforced by the collection createRule (@request.auth.id != "").
    // e.requestInfo() auth is not available in PB 0.25's isolated executor VM,
    // so we read the owner field sent by the client (the SDK sets it from the
    // auth session) and look up the role directly from the DB.
    const ownerId = record.get("owner");
    if (!ownerId) {
        throw new BadRequestError("Owner field is required");
    }

    // Look up owner role early: used both to decide auto-publish below and to
    // scope the bulk-upload rate-limit bypass (admin + explicit bulkUpload flag
    // only — never trust a client-supplied role claim).
    let ownerRole = "user";
    try {
        const ownerRecord = $app.findRecordById("users", ownerId);
        if (ownerRecord) ownerRole = ownerRecord.get("role") || "user";
    } catch (_) {}

    // e.requestInfo() is unavailable inside onRecordCreate hooks in this PB
    // version (it returns null here, unlike in custom route handlers), so a
    // non-schema request field can't be read this way — `bulkUpload` has to be
    // an actual (if minimal) field on the collection for the record binder to
    // populate it from the submitted multipart data before this hook runs.
    const bulkUpload = record.get("bulkUpload") === true;
    // Not persisted: this is a one-shot signal for this request only, cleared
    // below before save so it never accumulates as stored data on records.

    if (!(ownerRole === "admin" && bulkUpload)) {
        if (!checkRateLimit("upload", ownerId)) {
            throw new BadRequestError("Upload rate limit exceeded. Please try again later.");
        }
    }

    const tags = record.get("tags");
    if (tags) {
        const v = validateStringArray(tags, "tags");
        if (!v.valid) throw new BadRequestError(v.error);
    }

    const deviceScopes = record.get("deviceScopes");
    if (deviceScopes) {
        const v = validateStringArray(deviceScopes, "deviceScopes");
        if (!v.valid) throw new BadRequestError(v.error);
    }

    if (ownerRole === "admin") {
        record.set("status", "published");
        record.set("approvedBy", ownerId);
    } else {
        record.set("status", "pending");
    }

    record.set("bulkUpload", false);

    e.next();
}, "media");

// ---------------------------------------------------------------------------
// Media: after create — process media (sync; errors must not affect response)
// ---------------------------------------------------------------------------

onRecordAfterCreateSuccess((e) => {
    try {
        const { processMediaRecord } = require(__hooks + "/utils.js");
        const record = e.record;

        try { record.set("processingStatus", "pending"); $app.save(record); } catch (_) {}

        // $app.runInBackground not available in PB 0.25 JSVM — run synchronously.
        // Errors are caught so a processing failure never causes a 4xx/5xx response.
        try {
            processMediaRecord(record);
        } catch (err) {
            console.error("Media processing error for", record.id, ":", err);
        }
    } catch (err) {
        console.error("onRecordAfterCreateSuccess (media) unexpected error:", err);
    }
}, "media");

// ---------------------------------------------------------------------------
// Approvals: after create — update media status
// ---------------------------------------------------------------------------

onRecordAfterCreateSuccess((e) => {
    try {
        const { processApproval } = require(__hooks + "/utils.js");
        const approval = e.record;
        processApproval(approval, approval.get("status"), approval.get("media"), approval.get("reviewer"));
    } catch (err) {
        console.error("onRecordAfterCreateSuccess (approvals) unexpected error:", err);
    }
}, "approvals");

// ---------------------------------------------------------------------------
// Devices: before create/update — hash the API key
// ---------------------------------------------------------------------------

onRecordCreate((e) => {
    try {
        const { hashApiKey } = require(__hooks + "/utils.js");
        const record = e.record;
        const apiKey = record.get("apiKey");
        if (apiKey) record.set("apiKey", hashApiKey(apiKey));
    } catch (err) {
        console.error("Device create hook error:", err);
    }
    e.next();
}, "devices");

onRecordUpdate((e) => {
    try {
        const { hashApiKey } = require(__hooks + "/utils.js");
        const record = e.record;
        const apiKey = record.get("apiKey");
        // Only hash if it looks like a new (unhashed) key — hashed keys are 64 hex chars
        if (apiKey && apiKey.length !== 64) record.set("apiKey", hashApiKey(apiKey));
    } catch (err) {
        console.error("Device update hook error:", err);
    }
    e.next();
}, "devices");

// ---------------------------------------------------------------------------
// Cron: clean up expired rate limit records every 10 minutes
// ---------------------------------------------------------------------------

cronAdd("cleanup_rate_limits", "*/10 * * * *", () => {
    try {
        const now = new Date().toISOString();
        const expired = $app.findRecordsByFilter(
            "rate_limits",
            "resetAt < {:now}",
            "-resetAt", 0, 0,
            { now: now }
        );
        for (const r of expired) {
            try { $app.delete(r); } catch (_) {}
        }
        if (expired.length > 0) {
            console.log("cleanup_rate_limits: removed", expired.length, "expired records");
        }
    } catch (e) {
        console.error("cleanup_rate_limits cron failed:", e);
    }
});

// ---------------------------------------------------------------------------
// Cron: clean up old device_inbox records every 30 minutes
// ---------------------------------------------------------------------------

cronAdd("cleanup_device_inbox", "*/30 * * * *", () => {
    try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const old = $app.findRecordsByFilter(
            "device_inbox",
            "created < {:cutoff}",
            "-created", 0, 0,
            { cutoff: cutoff }
        );
        for (const r of old) {
            try { $app.delete(r); } catch (_) {}
        }
        if (old.length > 0) {
            console.log("cleanup_device_inbox: removed", old.length, "old records");
        }
    } catch (e) {
        console.error("cleanup_device_inbox cron failed:", e);
    }
});

// ---------------------------------------------------------------------------
// Auth: rate limit login attempts by IP
// ---------------------------------------------------------------------------

onRecordAuthWithPasswordRequest((e) => {
    try {
        const { checkRateLimit } = require(__hooks + "/utils.js");
        const info = typeof e.requestInfo === "function" ? e.requestInfo() : null;
        const headers = (info && info.headers) || {};
        const ip = headers["x-forwarded-for"] || headers["x-real-ip"] || "unknown";
        if (!checkRateLimit("login", ip)) {
            throw new BadRequestError("Too many login attempts. Please try again later.");
        }
    } catch (err) {
        if (err && err.code === 400) throw err;
        console.error("Login rate limit hook error:", err);
    }
    e.next();
}, "users");
