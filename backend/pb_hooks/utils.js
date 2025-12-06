/// <reference path="../pb_data/types.d.ts" />

/**
 * Utility functions for PocketBase hooks
 * 
 * Note: PocketBase's JSVM does not support Node.js-style require() for local files.
 * These utilities are embedded directly in media.pb.js. This file serves as
 * documentation and a reference for the helper functions used.
 * 
 * If PocketBase adds module support in the future, these can be imported directly.
 */

/**
 * Execute a shell command and return stdout
 * @param {string} cmd - Command to execute
 * @param {string[]} args - Command arguments
 * @returns {string} - Command output
 */
function execCommand(cmd, args) {
    // $os.exec is a PocketBase global that executes commands
    // It takes the command as first arg, then spreads the rest
    const result = $os.exec(cmd, ...args);
    return result;
}

/**
 * Generate SHA256 checksum of a file for deduplication
 * @param {string} filePath - Path to file
 * @returns {string|null} - Hex-encoded SHA256 hash or null on error
 */
function generateChecksum(filePath) {
    try {
        const output = execCommand("sha256sum", [filePath]);
        if (output) {
            // sha256sum outputs: "hash  filename"
            return output.split(" ")[0];
        }
    } catch (err) {
        console.error("Checksum generation failed:", err);
    }
    return null;
}

/**
 * Build PocketBase file URL for derived assets
 * @param {string} collectionId - Collection ID
 * @param {string} recordId - Record ID  
 * @param {string} fileName - File name
 * @returns {string} - Relative URL path
 */
function buildFileUrl(collectionId, recordId, fileName) {
    // PocketBase serves files at /api/files/{collectionId}/{recordId}/{fileName}
    return "/api/files/" + collectionId + "/" + recordId + "/" + fileName;
}

/**
 * Extract EXIF metadata from image/video using exiftool
 * @param {string} filePath - Path to media file
 * @returns {Object} - Object with width, height, orientation, takenAt, duration
 */
function extractExif(filePath) {
    const result = {
        width: null,
        height: null,
        orientation: null,
        takenAt: null,
        duration: null
    };
    
    try {
        const output = execCommand("exiftool", [
            "-json",
            "-ImageWidth",
            "-ImageHeight", 
            "-Orientation",
            "-DateTimeOriginal",
            "-Duration",
            filePath
        ]);
        
        if (output) {
            const data = JSON.parse(output);
            if (data && data[0]) {
                const exif = data[0];
                result.width = exif.ImageWidth || null;
                result.height = exif.ImageHeight || null;
                result.orientation = exif.Orientation || null;
                
                // Convert EXIF date format "YYYY:MM:DD HH:MM:SS" to ISO
                if (exif.DateTimeOriginal) {
                    const parts = exif.DateTimeOriginal.replace(/:/g, "-").replace(" ", "T");
                    result.takenAt = parts;
                }
                
                // Parse video duration
                if (exif.Duration) {
                    const dur = exif.Duration;
                    if (typeof dur === "string" && dur.includes(":")) {
                        const parts = dur.split(":");
                        let seconds = 0;
                        if (parts.length === 3) {
                            seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
                        } else if (parts.length === 2) {
                            seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
                        }
                        result.duration = seconds;
                    } else {
                        result.duration = parseFloat(dur);
                    }
                }
            }
        }
    } catch (err) {
        console.error("EXIF extraction failed:", err);
    }
    
    return result;
}

/**
 * FFmpeg commands reference for media processing:
 * 
 * Display image (1080p fit, preserving aspect ratio):
 *   ffmpeg -y -i input -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" -q:v 3 display.jpg
 * 
 * Blurred backdrop (for letterboxing):
 *   ffmpeg -y -i input -vf "scale=80:-1,gblur=sigma=20,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" -q:v 5 blur.jpg
 * 
 * Thumbnail (300px width):
 *   ffmpeg -y -i input -vf "scale=300:-1" -q:v 4 thumb.jpg
 * 
 * Video transcode (H.264 1080p):
 *   ffmpeg -y -i input -vf scale=1920:-2 -c:v libx264 -preset medium -crf 22 -c:a aac -movflags +faststart output.mp4
 * 
 * Video poster frame:
 *   ffmpeg -y -i input -ss 00:00:01 -vframes 1 -q:v 3 poster.jpg
 * 
 * Get video duration:
 *   ffprobe -v quiet -show_entries format=duration -of csv=p=0 input
 */

