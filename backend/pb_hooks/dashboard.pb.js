// Dashboard "System" panel data — storage usage, backup status, and
// software versions running on the backend host.
//
// GET /api/spomienka/system-status  (admin only)

routerAdd("GET", "/api/spomienka/system-status", (e) => {
    const auth = e.auth;
    if (!auth || auth.collection().name !== "users" || auth.getString("role") !== "admin") {
        throw new UnauthorizedError("Admin access required");
    }

    const utils = require(__hooks + "/utils.js");
    const dataDir = $app.dataDir();

    // Storage used by processed/original media, in bytes. `du` is used instead
    // of $os.stat (unavailable in this PocketBase 0.25 JSVM build) or summing
    // $os.readFile lengths (would load every file into memory).
    let storageBytes = null;
    try {
        const out = utils.execCommand("du", ["-sb", dataDir + "/storage"]);
        const bytes = parseInt(out.trim().split(/\s+/)[0], 10);
        if (!isNaN(bytes)) storageBytes = bytes;
    } catch (err) {
        console.error("system-status: du failed:", String(err));
    }

    // Backup files — PocketBase's own backup dir, named pb_backup_<yyyyMMddHHmmss>.zip
    // by its built-in cron backup feature (Settings > Backups). Read the directory
    // directly rather than PocketBase's /api/backups, which requires a separate
    // superuser auth token distinct from this app's users/role=admin auth.
    let backups = [];
    try {
        const files = $os.readdir(dataDir + "/backups");
        backups = files
            .filter((f) => /^pb_backup_\d{14}\.zip$/.test(f))
            .map((f) => {
                const m = f.match(/^pb_backup_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.zip$/);
                const timestamp = m
                    ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`
                    : null;
                return { name: f, timestamp };
            })
            .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    } catch (_) {
        // Backups directory doesn't exist — backups were never configured.
        backups = [];
    }

    // Software versions on the backend host. Each is best-effort — a missing
    // or misbehaving tool shouldn't take down the whole response.
    const software = {};

    try {
        const out = utils.execCommand("/opt/pocketbase/pocketbase", ["--version"]);
        const parts = out.trim().split(/\s+/);
        software.pocketbase = parts[parts.length - 1];
    } catch (err) {
        console.error("system-status: pocketbase --version failed:", String(err));
    }

    try {
        const firstLine = utils.execCommand(utils.FFMPEG, ["-version"]).split("\n")[0];
        const parts = firstLine.trim().split(/\s+/);
        const idx = parts.indexOf("version");
        software.ffmpeg = idx !== -1 ? parts[idx + 1] : firstLine.trim();
    } catch (err) {
        console.error("system-status: ffmpeg -version failed:", String(err));
    }

    try {
        software.exiftool = utils.execCommand(utils.EXIFTOOL, ["-ver"]).trim();
    } catch (err) {
        console.error("system-status: exiftool -ver failed:", String(err));
    }

    try {
        const osRelease = toString($os.readFile("/etc/os-release"));
        const m = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?$/m);
        software.hostOs = m ? m[1] : null;
    } catch (err) {
        console.error("system-status: /etc/os-release read failed:", String(err));
    }

    e.json(200, { storageBytes, backups, software });
}, $apis.requireAuth());
