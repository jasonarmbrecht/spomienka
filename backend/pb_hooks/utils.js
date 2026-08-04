// Shared helpers for media hooks.
// Loaded via: const h = require(__hooks + '/utils.js')
//
// PocketBase 0.25 runs each hook callback in an isolated goja VM instance
// from a pool, so module-level definitions in *.pb.js files are not in scope
// inside callbacks. require() re-evaluates this file in the callback's VM,
// making all exports available. PocketBase globals ($app, $os, Record, etc.)
// are injected into every executor VM and are usable here.

const PROCESS_DIR = $os.getenv("PB_PROCESS_DIR") || "/tmp/pb_processing";

// Resolve tool binaries at module load time so hooks don't depend on PATH.
// Checks candidate absolute paths first, falls back to plain name for PATH lookup.
function findBinary(candidates) {
    for (const p of candidates) {
        try { $os.stat(p); return p; } catch (_) {}
    }
    return candidates[candidates.length - 1].split("/").pop();
}

const FFMPEG   = findBinary(["/opt/homebrew/bin/ffmpeg",   "/usr/bin/ffmpeg",   "/usr/local/bin/ffmpeg",   "ffmpeg"]);
const FFPROBE  = findBinary(["/opt/homebrew/bin/ffprobe",  "/usr/bin/ffprobe",  "/usr/local/bin/ffprobe",  "ffprobe"]);
const EXIFTOOL = findBinary(["/opt/homebrew/bin/exiftool", "/usr/bin/exiftool", "/usr/local/bin/exiftool", "exiftool"]);

// heif-convert (from libheif-examples on Debian/Raspbian) decodes HEIC more
// reliably than ffmpeg on Linux, where ffmpeg often lacks HEIF support.
const HEIF_CONVERT = findBinary(["/usr/bin/heif-convert", "/usr/local/bin/heif-convert", "heif-convert"]);

// sha256sum is Linux-only; macOS ships shasum instead.
const SHA256_CMD  = findBinary(["/usr/bin/sha256sum", "/opt/homebrew/bin/shasum", "/usr/bin/shasum", "sha256sum"]);
const SHA256_ARGS = SHA256_CMD.includes("shasum") ? ["-a", "256"] : [];

const CP_CMD = findBinary(["/bin/cp", "/usr/bin/cp", "cp"]);

const RATE_LIMITS = {
    login:    { max: 5,   windowMs: 60000 },
    upload:   { max: 100, windowMs: 60000 },
    api:      { max: 100, windowMs: 60000 },
    announce: { max: 30,  windowMs: 60000 },
    claim:    { max: 60,  windowMs: 60000 },
};

try { $os.mkdir(PROCESS_DIR, 0o755); } catch (_) {}

function checkRateLimit(type, key) {
    const limit = RATE_LIMITS[type];
    const compositeKey = type + ":" + key;
    const now = Date.now();
    const newResetAt = new Date(now + limit.windowMs).toISOString();

    try {
        let record;
        try {
            record = $app.findFirstRecordByFilter("rate_limits", "key = {:k}", { k: compositeKey });
        } catch (_) { record = null; }

        if (!record || new Date(record.get("resetAt")).getTime() < now) {
            if (!record) {
                const col = $app.findCollectionByNameOrId("rate_limits");
                record = new Record(col);
                record.set("key", compositeKey);
                record.set("type", type);
            }
            record.set("count", 1);
            record.set("resetAt", newResetAt);
            $app.save(record);
            return true;
        }

        const count = record.get("count") + 1;
        record.set("count", count);
        $app.save(record);
        return count <= limit.max;
    } catch (e) {
        console.error("Rate limit DB error, failing open:", e);
        return true;
    }
}

function escapeFilterValue(value) {
    if (typeof value !== "string") return String(value);
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function validateStringArray(value, fieldName) {
    if (value === null || value === undefined || value === "") return { valid: true };
    if (!Array.isArray(value)) return { valid: false, error: `${fieldName} must be an array` };
    for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string") {
            return { valid: false, error: `${fieldName}[${i}] must be a string` };
        }
    }
    return { valid: true };
}

function execCommand(cmd, args) {
    try {
        const command = $os.cmd ? $os.cmd(cmd, ...args) : $os.exec(cmd, ...args);
        const result = command && command.output ? command.output() : command;
        if (result === null || result === undefined) {
            throw new Error(`Command "${cmd}" returned null`);
        }
        return toString(result);
    } catch (err) {
        const msg = `Failed to execute "${cmd}": ${err.message || err}`;
        console.error(msg);
        throw new Error(msg);
    }
}

function buildFileUrl(collectionId, recordId, fileName) {
    // Derived files (display_, thumb_, poster_, video_) are placed on disk
    // by the processing hook and served via a custom route because PocketBase's
    // /api/files/ endpoint only serves files registered in file-type schema fields.
    const DERIVED_PREFIXES = ["display_", "thumb_", "poster_", "video_"];
    const isDerived = DERIVED_PREFIXES.some((p) => fileName.startsWith(p));
    if (isDerived) {
        return "/api/spomienka/media/" + collectionId + "/" + recordId + "/" + fileName;
    }
    return "/api/files/" + collectionId + "/" + recordId + "/" + fileName;
}

function extractExif(filePath) {
    const result = {
        width: null, height: null, orientation: null, takenAt: null, duration: null,
        gpsLat: null, gpsLng: null,
        cameraMake: null, cameraModel: null,
        focalLength: null, fNumber: null, exposureTime: null, iso: null,
    };
    try {
        const output = execCommand(EXIFTOOL, [
            "-json", "-n",
            "-ImageWidth", "-ImageHeight", "-Orientation",
            "-DateTimeOriginal", "-Duration",
            "-GPSLatitude", "-GPSLongitude",
            "-Make", "-Model",
            "-FocalLength", "-FNumber", "-ExposureTime", "-ISO",
            filePath,
        ]);
        if (output) {
            const data = JSON.parse(output);
            if (data && data[0]) {
                const exif = data[0];
                result.width = exif.ImageWidth || null;
                result.height = exif.ImageHeight || null;
                result.orientation = exif.Orientation || null;
                if (exif.DateTimeOriginal) {
                    result.takenAt = String(exif.DateTimeOriginal)
                        .replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
                        .replace(" ", "T");
                }
                if (exif.Duration != null) {
                    const dur = exif.Duration;
                    if (typeof dur === "string" && dur.includes(":")) {
                        const parts = dur.split(":");
                        let s = 0;
                        if (parts.length === 3) s = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
                        else if (parts.length === 2) s = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
                        if (Number.isFinite(s)) result.duration = s;
                    } else {
                        const parsedDuration = parseFloat(dur);
                        if (Number.isFinite(parsedDuration)) result.duration = parsedDuration;
                    }
                }
                if (typeof exif.GPSLatitude === "number") result.gpsLat = exif.GPSLatitude;
                if (typeof exif.GPSLongitude === "number") result.gpsLng = exif.GPSLongitude;
                if (exif.Make) result.cameraMake = String(exif.Make).trim();
                if (exif.Model) result.cameraModel = String(exif.Model).trim();
                if (typeof exif.FocalLength === "number") {
                    result.focalLength = exif.FocalLength.toFixed(1) + " mm";
                }
                if (typeof exif.FNumber === "number") {
                    result.fNumber = "f/" + exif.FNumber.toFixed(1);
                }
                if (typeof exif.ExposureTime === "number" && exif.ExposureTime > 0) {
                    if (exif.ExposureTime < 1) {
                        result.exposureTime = "1/" + Math.round(1 / exif.ExposureTime) + "s";
                    } else {
                        result.exposureTime = exif.ExposureTime.toFixed(1) + "s";
                    }
                }
                if (exif.ISO != null) result.iso = String(Math.round(exif.ISO));
            }
        }
    } catch (err) {
        console.error("EXIF extraction failed:", err);
    }
    return result;
}

function geocodeGps(lat, lng) {
    try {
        const url = "https://nominatim.openstreetmap.org/reverse?format=json&lat=" + lat + "&lon=" + lng + "&zoom=10&addressdetails=1";
        const res = $http.send({
            url: url,
            method: "GET",
            headers: {
                "User-Agent": "Spomienka/1.0 (photo-frame-app)",
                "Accept": "application/json",
            },
        });
        if (res.statusCode === 200) {
            const data = JSON.parse(res.raw);
            const addr = (data && data.address) || {};
            const parts = [
                addr.suburb || addr.neighbourhood || addr.city_district,
                addr.city || addr.town || addr.village || addr.municipality,
                addr.country,
            ].filter(function(p) { return p && p.length > 0; });
            if (parts.length > 0) return parts.join(", ");
        }
    } catch (err) {
        console.error("GPS geocoding failed:", err);
    }
    return null;
}

function generateChecksum(filePath) {
    try {
        const output = execCommand(SHA256_CMD, [...SHA256_ARGS, filePath]);
        if (output) return output.trim().split(/\s+/)[0];
    } catch (err) {
        console.error("Checksum generation failed:", err);
    }
    return null;
}

const FFMPEG_DISPLAY_SCALE = "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease";
const FFMPEG_THUMB_SCALE   = "scale=300:-1";
// Bounding-box scale (not a fixed width) so portrait video isn't blown up:
// ffmpeg auto-rotates portrait phone footage before this filter runs, which
// swaps its effective width/height — a fixed "scale=1920:-2" then forces the
// now-short dimension up to 1920, upscaling a 1080p portrait clip to ~1920x3414.
// force_divisible_by=2 keeps dimensions even, required by libx264's yuv420p.
//
// format=yuv420p + setparams force standard 8-bit BT.709 output regardless of
// the source's bit depth/colorimetry. iPhone HDR video is 10-bit with
// bt2100-hlg tagging; without this, ffmpeg carries that tagging through to
// the encoded output (even though it's already been crushed to 8-bit), and
// the Raspberry Pi's hardware H.264 decoder (v4l2h264dec) flatly rejects
// bt2100-hlg -- its caps template only advertises bt709/bt601/smpte240m/
// bt2020 -- so the video fails to decode at all on-device.
const FFMPEG_VIDEO_SCALE =
    "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2," +
    "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709";


function processImage(record, originalPath, procDir, storagePath) {
    const recordId = record.id;
    const collectionId = record.collection().id;

    // HEIC/HEIF: prefer heif-convert (works reliably on Linux), fall back to
    // ffmpeg (works on macOS via VideoToolbox, unreliable for HEIF on Linux).
    const isHeic = /\.heic$/i.test(originalPath);
    if (isHeic) {
        const tmpPng = procDir + "/original.png";
        // Note: $os.stat does not exist in this PocketBase JSVM build (throws
        // "Object has no member 'stat'" unconditionally) — do not use it here.
        // execCommand already throws reliably on real command failures, which
        // is a sufficient success/failure signal on its own.
        try {
            const out = execCommand(HEIF_CONVERT, [originalPath, tmpPng]);
            console.log("heif-convert succeeded:", out);
        } catch (err) {
            console.error("heif-convert failed, falling back to ffmpeg:", err.message || err);
            execCommand(FFMPEG, ["-y", "-i", originalPath, "-frames:v", "1", "-update", "1", tmpPng]);
        }
        originalPath = tmpPng;
    }

    try {
        const displayPath = procDir + "/display.png";
        execCommand(FFMPEG, ["-y", "-i", originalPath, "-map", "0:v:0", "-vf", FFMPEG_DISPLAY_SCALE, displayPath]);
        const name = "display_" + recordId + ".png";
        $os.rename(displayPath, storagePath + "/" + name);
        record.set("displayUrl", buildFileUrl(collectionId, recordId, name));
    } catch (err) { console.error("Display image failed:", err); }

    try {
        const thumbPath = procDir + "/thumb.png";
        execCommand(FFMPEG, ["-y", "-i", originalPath, "-map", "0:v:0", "-vf", FFMPEG_THUMB_SCALE, thumbPath]);
        const name = "thumb_" + recordId + ".png";
        $os.rename(thumbPath, storagePath + "/" + name);
        record.set("thumbUrl", buildFileUrl(collectionId, recordId, name));
    } catch (err) { console.error("Thumbnail failed:", err); }
}

function processVideo(record, originalPath, procDir, storagePath) {
    const recordId = record.id;
    const collectionId = record.collection().id;

    try {
        const output = execCommand(FFPROBE, [
            "-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", originalPath,
        ]);
        if (output) {
            const duration = parseFloat(output.trim());
            if (Number.isFinite(duration)) record.set("duration", duration);
        }
    } catch (err) { console.error("Duration extraction failed:", err); }

    try {
        const videoPath = procDir + "/video.mp4";
        execCommand(FFMPEG, ["-y", "-i", originalPath, "-vf", FFMPEG_VIDEO_SCALE,
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            "-c:a", "aac", "-movflags", "+faststart", videoPath]);
        const name = "video_" + recordId + ".mp4";
        $os.rename(videoPath, storagePath + "/" + name);
        record.set("videoUrl", buildFileUrl(collectionId, recordId, name));
    } catch (err) { console.error("Video transcode failed:", err); }

    let posterCreated = false;
    try {
        const posterPath = procDir + "/poster.png";
        // Note: $os.stat does not exist in this PocketBase JSVM build (throws
        // "Object has no member 'stat'" unconditionally) — do not use it here.
        // execCommand already throws reliably on real command failures.
        execCommand(FFMPEG, ["-y", "-i", originalPath, "-ss", "00:00:01", "-vframes", "1",
            "-vf", FFMPEG_DISPLAY_SCALE, posterPath]);
        const name = "poster_" + recordId + ".png";
        $os.rename(posterPath, storagePath + "/" + name);
        record.set("posterUrl", buildFileUrl(collectionId, recordId, name));
        posterCreated = true;
    } catch (err) { console.error("Poster extraction failed:", err); }

    try {
        const thumbPath = procDir + "/thumb.png";
        execCommand(FFMPEG, ["-y", "-i", originalPath, "-ss", "00:00:01", "-vframes", "1",
            "-vf", FFMPEG_THUMB_SCALE, thumbPath]);
        const name = "thumb_" + recordId + ".png";
        $os.rename(thumbPath, storagePath + "/" + name);
        record.set("thumbUrl", buildFileUrl(collectionId, recordId, name));
    } catch (err) { console.error("Video thumbnail failed:", err); }
}

// Copies derived files (display/thumb/poster/video) from an existing
// duplicate record instead of re-running ffmpeg/exiftool. Returns false
// (and leaves the record untouched) if anything's missing, so the caller
// falls back to full processing.
function reuseDuplicateProcessing(record, existing, mediaType, collectionId, storagePath) {
    const existingStoragePath = $app.dataDir() + "/storage/" + collectionId + "/" + existing.id;
    const recordId = record.id;

    const fileSpecs = mediaType === "video"
        ? [["video_", ".mp4", "videoUrl"], ["poster_", ".png", "posterUrl"], ["thumb_", ".png", "thumbUrl"]]
        : [["display_", ".png", "displayUrl"], ["thumb_", ".png", "thumbUrl"]];

    for (const [prefix, ext, field] of fileSpecs) {
        const srcPath = existingStoragePath + "/" + prefix + existing.id + ext;
        const dstPath = storagePath + "/" + prefix + recordId + ext;
        try {
            execCommand(CP_CMD, [srcPath, dstPath]);
            record.set(field, buildFileUrl(collectionId, recordId, prefix + recordId + ext));
        } catch (err) {
            console.error("Failed to copy derived file for duplicate", recordId, ":", err.message || err);
            return false;
        }
    }

    ["width", "height", "orientation", "duration"].forEach((f) => {
        const v = existing.get(f);
        if (v) record.set(f, v);
    });
    return true;
}

function processMediaRecord(record) {
    const recordId = record.id;
    const collectionId = record.collection().id;
    const fileName = record.get("file");
    const mediaType = record.get("type");
    const procDir = PROCESS_DIR + "/" + recordId;
    const storagePath = $app.dataDir() + "/storage/" + collectionId + "/" + recordId;
    const originalPath = storagePath + "/" + fileName;
    let processingFailed = false;

    console.log("processMediaRecord start:", recordId, mediaType, fileName);
    console.log("  tools: ffmpeg=" + FFMPEG + " exiftool=" + EXIFTOOL + " sha256=" + SHA256_CMD);

    try {
        try { record.set("processingStatus", "processing"); $app.save(record); } catch (_) {}

        if (!fileName) throw new Error("No file attached to media record");

        try { $os.mkdir(procDir, 0o755); } catch (_) {}

        const exifData = extractExif(originalPath);
        if (exifData.width) record.set("width", exifData.width);
        if (exifData.height) record.set("height", exifData.height);
        if (exifData.orientation) record.set("orientation", exifData.orientation);
        if (exifData.takenAt) record.set("takenAt", exifData.takenAt);
        if (exifData.cameraMake) record.set("cameraMake", exifData.cameraMake);
        if (exifData.cameraModel) record.set("cameraModel", exifData.cameraModel);
        if (exifData.focalLength) record.set("focalLength", exifData.focalLength);
        if (exifData.fNumber) record.set("fNumber", exifData.fNumber);
        if (exifData.exposureTime) record.set("exposureTime", exifData.exposureTime);
        if (exifData.iso) record.set("iso", exifData.iso);

        // Reverse-geocode GPS to suburb/city/country if location not already set
        const existingLocation = record.get("location");
        if (!existingLocation && exifData.gpsLat !== null && exifData.gpsLng !== null) {
            try {
                const geocoded = geocodeGps(exifData.gpsLat, exifData.gpsLng);
                if (geocoded) record.set("location", geocoded);
            } catch (_) {}
        }

        const checksum = generateChecksum(originalPath);
        let reused = false;
        if (checksum) {
            record.set("checksum", checksum);
            try {
                const existing = $app.findFirstRecordByFilter(
                    "media",
                    "checksum='" + escapeFilterValue(checksum) + "' && id!='" + escapeFilterValue(recordId) + "'"
                );
                if (existing) {
                    console.log("Duplicate media detected:", recordId, "matches:", existing.id);
                    if (existing.get("processingStatus") === "completed") {
                        reused = reuseDuplicateProcessing(record, existing, mediaType, collectionId, storagePath);
                    }
                }
            } catch (_) {}
        }

        if (!reused) {
            if (mediaType === "image") processImage(record, originalPath, procDir, storagePath);
            else if (mediaType === "video") processVideo(record, originalPath, procDir, storagePath);
        }

        try { record.set("processingStatus", "completed"); record.set("processingError", null); } catch (_) {}
        $app.save(record);

    } catch (err) {
        processingFailed = true;
        const msg = err.message || String(err);
        console.error("Media processing failed for", recordId, ":", msg);
        try {
            record.set("processingStatus", "failed");
            record.set("processingError", msg);
            $app.save(record);
        } catch (_) {}
    } finally {
        try { $os.removeAll(procDir); } catch (_) {}
        if (processingFailed) {
            try {
                const files = $os.readdir(storagePath);
                const derived = ["display_", "thumb_", "video_", "poster_"];
                for (const file of files) {
                    for (const prefix of derived) {
                        if (file.startsWith(prefix)) {
                            try { $os.remove(storagePath + "/" + file); } catch (_) {}
                        }
                    }
                }
            } catch (_) {}
        }
    }
}

// Pure-JS SHA-256 for ASCII input. Used for PIN verification where the hash
// must match what the Rust viewer computes (sha2 crate, no trailing newline).
// $os.exec() in PocketBase 0.25 returns the command path, not stdout output,
// so we cannot rely on shell-based hashing for comparison with viewer-computed values.
function sha256hex(str) {
    const K = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ];
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    function rr(v, n) { return (v >>> n) | (v << (32 - n)); }

    const bytes = [];
    for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff);
    const msgLen = bytes.length;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const bitLen = msgLen * 8;
    bytes.push(0, 0, 0, 0, (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

    for (let blk = 0; blk < bytes.length; blk += 64) {
        const W = [];
        for (let i = 0; i < 16; i++) {
            W.push((bytes[blk+i*4]<<24)|(bytes[blk+i*4+1]<<16)|(bytes[blk+i*4+2]<<8)|bytes[blk+i*4+3]);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rr(W[i-15],7) ^ rr(W[i-15],18) ^ (W[i-15]>>>3);
            const s1 = rr(W[i-2],17) ^ rr(W[i-2],19) ^ (W[i-2]>>>10);
            W.push((W[i-16]+s0+W[i-7]+s1)|0);
        }
        let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rr(e,6)^rr(e,11)^rr(e,25)) + ((e&f)^(~e&g)) + K[i] + W[i]) | 0;
            const t2 = ((rr(a,2)^rr(a,13)^rr(a,22)) + ((a&b)^(a&c)^(b&c))) | 0;
            h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
        }
        H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
        H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    return H.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

function hashApiKey(apiKey) {
    // Uses pure-JS SHA-256 — $os.exec does not capture stdout in PB 0.25.
    return sha256hex(apiKey);
}

function processApproval(approval, status, mediaId, reviewerId) {
    if (!mediaId) return;
    try {
        const mediaRecord = $app.findRecordById("media", mediaId);
        const newStatus = status === "approved" ? "published" : "rejected";
        mediaRecord.set("status", newStatus);
        if (status === "approved") mediaRecord.set("approvedBy", reviewerId);
        $app.save(mediaRecord);
        approval.set("reviewedAt", new Date().toISOString());
        $app.save(approval);
    } catch (err) {
        console.error("Failed to process approval (" + status + ") for media " + mediaId + ":", err);
    }
}

module.exports = {
    PROCESS_DIR,
    FFMPEG,
    EXIFTOOL,
    checkRateLimit,
    escapeFilterValue,
    validateStringArray,
    execCommand,
    buildFileUrl,
    extractExif,
    geocodeGps,
    generateChecksum,
    processImage,
    processVideo,
    processMediaRecord,
    hashApiKey,
    sha256hex,
    processApproval,
};
