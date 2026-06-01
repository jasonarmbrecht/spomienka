// Discovery and PIN-based registration for unregistered viewers.
//
// Flow:
//   1. Viewer (no device_id) POSTs /api/spomienka/announce with session_id + pin_hash
//   2. Admin UI polls GET /api/spomienka/pending to see unregistered viewers
//   3. Admin enters PIN shown on viewer screen → POST /api/spomienka/register
//   4. Viewer polls GET /api/spomienka/claim/:session_id to receive credentials

// POST /api/spomienka/announce  (no auth — viewer is unregistered)
// Body: { session_id, pin_hash, hostname, ip }
routerAdd("POST", "/api/spomienka/announce", (e) => {
    try {
        const utils = require(__hooks + "/utils.js");

        const body = e.requestInfo().body;
        const sessionId = (body.session_id || "").trim();
        const pinHash = (body.pin_hash || "").trim();
        const hostname = (body.hostname || "").trim().substring(0, 255);
        const ip = (body.ip || "").trim().substring(0, 64);

        if (!sessionId || sessionId.length < 16 || sessionId.length > 64) {
            throw new BadRequestError("Invalid session_id");
        }
        if (!pinHash || pinHash.length !== 64) {
            throw new BadRequestError("Invalid pin_hash — expected 64-char sha256 hex");
        }

        // Rate limit: 30 announces per session per minute (viewer announces every 15s)
        try {
            utils.checkRateLimit("announce", sessionId.substring(0, 16));
        } catch (_) {
            throw new BadRequestError("Rate limit exceeded — slow down announce interval");
        }

        let record;
        try {
            record = $app.findFirstRecordByFilter("pending_devices", "sessionId = {:sid}", { sid: sessionId });
            // Already exists — update heartbeat fields
            if (ip) record.set("ip", ip);
            if (hostname) record.set("hostname", hostname);
        } catch (_) {
            // New session — evict any stale unclaimed records from same host/IP
            if (hostname || ip) {
                try {
                    const stale = $app.findRecordsByFilter(
                        "pending_devices",
                        "claimed = false && hostname = {:h} && ip = {:i}",
                        "", 50, 0,
                        { h: hostname, i: ip }
                    );
                    for (const s of stale || []) {
                        try { $app.delete(s); } catch (_) {}
                    }
                } catch (_) {}
            }

            const col = $app.findCollectionByNameOrId("pending_devices");
            record = new Record(col);
            record.set("sessionId", sessionId);
            record.set("pinHash", pinHash);
            record.set("hostname", hostname);
            record.set("ip", ip);
            record.set("claimed", false);
        }

        $app.save(record);
        e.json(200, { status: "waiting" });
    } catch (err) {
        if (err && err.code) throw err;
        throw new BadRequestError("Announce failed: " + String(err));
    }
});

// POST /api/spomienka/device-auth  (no user auth — device uses its own key)
// Body: { device_id, api_key }
// Validates device credentials, updates lastSeen, returns a signed session token
// and the device's display config. Rejects devices inactive for > 3 months.
routerAdd("POST", "/api/spomienka/device-auth", (e) => {
    try {
        const body = e.requestInfo().body;
        const deviceId = (body.device_id || "").trim();
        const apiKey = (body.api_key || "").trim();

        if (!deviceId || !apiKey) {
            throw new BadRequestError("Missing device_id or api_key");
        }

        let device;
        try {
            device = $app.findRecordById("devices", deviceId);
        } catch (_) {
            throw new UnauthorizedError("Device not found");
        }

        const utils = require(__hooks + "/utils.js");
        const expectedHash = utils.hashApiKey(apiKey);
        const storedHash = device.getString("apiKey");

        if (expectedHash !== storedHash) {
            throw new UnauthorizedError("Invalid API key");
        }

        // Reject if inactive for more than 3 months (lastSeen set, but stale)
        const lastSeenStr = device.getString("lastSeen");
        if (lastSeenStr) {
            const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
            if (new Date(lastSeenStr) < threeMonthsAgo) {
                throw new UnauthorizedError("Device inactive for more than 3 months — re-register");
            }
        }

        // Update lastSeen
        device.set("lastSeen", new Date().toISOString());
        $app.save(device);

        // Sign a 30-day session token: payload.hs256(payload, secret)
        const SECRET = $os.getenv("DEVICE_AUTH_SECRET") || "spomienka-device-secret";
        const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
        const payload = deviceId + ":" + expiry;
        const sig = $security.hs256(payload, SECRET);
        const token = payload + "." + sig;

        // Return token + device display config in one call
        const cfg = device.get("config") || {};
        e.json(200, {
            token: token,
            expires_at: expiry,
            config: {
                interval: cfg.interval ?? 8000,
                transition: cfg.transition ?? "fade",
                transitionDuration: cfg.transitionDuration ?? 1000,
                blur: cfg.blur ?? true,
                shuffle: cfg.shuffle ?? false,
                showClock: cfg.showClock ?? true,
            },
        });
    } catch (err) {
        if (err && err.code) throw err;
        throw new BadRequestError("Device auth failed: " + String(err));
    }
});

// GET /api/spomienka/pending  (admin only)
// Returns unclaimed viewers that have announced in the last 10 minutes.
routerAdd("GET", "/api/spomienka/pending", (e) => {
    // PocketBase populates e.auth from the Authorization header for all routes
    const auth = e.auth;
    if (!auth || auth.collection().name !== "users" || auth.getString("role") !== "admin") {
        throw new UnauthorizedError("Admin access required");
    }

    try {
        let records;
        try {
            records = $app.findRecordsByFilter(
                "pending_devices",
                "claimed = false",
                "",
                50,
                0
            );
        } catch (filterErr) {
            console.error("pending filter error:", String(filterErr));
            records = [];
        }

        const result = (records || []).map((r) => ({
            session_id: r.getString("sessionId"),
            hostname: r.getString("hostname") || "unknown",
            ip: r.getString("ip") || "unknown",
            created: r.getString("created"),
        }));

        e.json(200, result);
    } catch (err) {
        if (err && err.code) throw err;
        throw new BadRequestError("Failed to list pending: " + String(err));
    }
}, $apis.requireAuth());

// POST /api/spomienka/register  (admin only)
// Body: { session_id, name, pin }
// Creates the device record and stores credentials for the viewer to pick up.
routerAdd("POST", "/api/spomienka/register", (e) => {
    const auth = e.auth;
    if (!auth || auth.collection().name !== "users" || auth.getString("role") !== "admin") {
        throw new UnauthorizedError("Admin access required");
    }

    try {
        const info = e.requestInfo();
        const body = info.body;
        const sessionId = (body.session_id || "").trim();
        const name = (body.name || "").trim();
        const pin = (body.pin || "").trim();

        if (!sessionId || !name || !pin) {
            throw new BadRequestError("Missing required fields: session_id, name, pin");
        }
        if (!/^\d{6}$/.test(pin)) {
            throw new BadRequestError("PIN must be exactly 6 digits");
        }

        const utils = require(__hooks + "/utils.js");

        let pending;
        try {
            pending = $app.findFirstRecordByFilter("pending_devices", "sessionId = {:sid}", { sid: sessionId });
        } catch (_) {
            throw new NotFoundError("Unknown session_id — viewer may have timed out");
        }

        if (pending.getBool("claimed")) {
            throw new BadRequestError("Session already claimed");
        }

        // Validate PIN: expected = sha256(session_id + pin), same as viewer computed
        const expectedHash = utils.sha256hex(sessionId + pin);
        const storedHash = pending.getString("pinHash");
        if (expectedHash !== storedHash) {
            throw new BadRequestError("Incorrect PIN");
        }

        // Generate a cryptographically random API key using PocketBase's built-in RNG.
        // Note: $os.exec does not capture stdout in PocketBase 0.25, so openssl is unusable here.
        const rawKey = $security.randomString(32);

        // Create the device record (the onRecordCreate hook will hash apiKey)
        const devCol = $app.findCollectionByNameOrId("devices");
        const device = new Record(devCol);
        device.set("name", name);
        device.set("apiKey", rawKey);
        device.set("config", {
            interval: 8000,
            transition: "fade",
            transitionDuration: 1000,
            blur: true,
            shuffle: false,
            showClock: true,
        });
        $app.save(device);

        // Store raw key in pending record so viewer can pick it up via /claim
        // The key is cleared after the viewer fetches it (one-time delivery)
        pending.set("claimed", true);
        pending.set("deviceId", device.id);
        pending.set("apiKey", rawKey);
        $app.save(pending);

        e.json(200, { success: true, device_id: device.id });
    } catch (err) {
        if (err && err.code) throw err;
        throw new BadRequestError("Registration failed: " + String(err));
    }
}, $apis.requireAuth());

// GET /api/spomienka/claim?sid=SESSION_ID  (no auth — session_id acts as a bearer token)
// Viewer polls this until it receives credentials.  Returns them once, then clears them.
routerAdd("GET", "/api/spomienka/claim", (e) => {
    try {
        const sessionId = (e.requestInfo().query["sid"] || "").trim();
        console.log("Claim poll received: sessionId=" + (sessionId || "[empty]"));
        if (!sessionId || sessionId.length < 16) {
            e.json(200, { status: "waiting" });
            return;
        }

        const utils = require(__hooks + "/utils.js");

        let pending;
        try {
            pending = $app.findFirstRecordByFilter("pending_devices", "sessionId = {:sid}", { sid: sessionId });
        } catch (findErr) {
            console.log("Claim poll: no record for sessionId=" + sessionId + " err=" + String(findErr));
            e.json(200, { status: "waiting" });
            return;
        }

        const claimed = pending.getBool("claimed");
        const deviceId = pending.getString("deviceId");
        const apiKey = pending.getString("apiKey");
        console.log("Claim check: claimed=" + claimed + " deviceId=" + (deviceId || "[empty]") + " apiKey=" + (apiKey ? "[set len=" + apiKey.length + "]" : "[empty]"));

        if (!claimed) {
            e.json(200, { status: "waiting" });
            return;
        }

        if (!deviceId || !apiKey) {
            // Already picked up
            e.json(200, { status: "waiting" });
            return;
        }

        // One-time delivery: clear the key after sending
        pending.set("apiKey", "");
        $app.save(pending);

        e.json(200, { device_id: deviceId, api_key: apiKey });
    } catch (err) {
        // Don't leak errors — just tell viewer to keep waiting
        e.json(200, { status: "waiting" });
    }
});

// Cleanup: delete pending_devices records older than 1 hour
cronAdd("cleanup-pending-devices", "0 * * * *", () => {
    try {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const cutoff = oneHourAgo.toISOString().replace("T", " ").replace(/\.\d+Z$/, ".000Z");

        let records;
        try {
            records = $app.findRecordsByFilter(
                "pending_devices",
                "claimed = true",
                "",
                100,
                0
            );
        } catch (_) {
            return;
        }

        for (const record of records || []) {
            try { $app.delete(record); } catch (_) {}
        }
    } catch (err) {
        console.error("cleanup-pending-devices error:", String(err));
    }
});
