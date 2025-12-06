/// <reference path="../pb_data/types.d.ts" />

// Media processing hooks for PocketBase
// Handles: status management, EXIF extraction, image/video processing

const PROCESS_DIR = $os.getenv("PB_PROCESS_DIR") || "/tmp/pb_processing";

// Ensure processing directory exists
try {
    $os.mkdir(PROCESS_DIR, 0o755);
} catch (e) {
    // Directory may already exist
}

/**
 * Validate that required tools are available
 */
function validateRequiredTools() {
    const requiredTools = [
        { name: "ffmpeg", check: ["-version"] },
        { name: "exiftool", check: ["-ver"] },
        { name: "sha256sum", check: ["--version"] }
    ];
    
    const missingTools = [];
    
    for (const tool of requiredTools) {
        try {
            execCommand(tool.name, tool.check);
        } catch (err) {
            missingTools.push(tool.name);
            console.error("Required tool not found:", tool.name);
        }
    }
    
    if (missingTools.length > 0) {
        console.error("Missing required tools:", missingTools.join(", "));
        console.error("Media processing may fail. Please install:", missingTools.join(", "));
        return false;
    }
    
    return true;
}

// Validate tools on startup
validateRequiredTools();

/**
 * Before creating media: set status based on uploader role
 */
onRecordBeforeCreateRequest((e) => {
    const record = e.record;
    const user = e.httpContext.get("authRecord");
    
    if (!user) {
        throw new BadRequestError("Authentication required");
    }
    
    // Set owner to current user
    record.set("owner", user.id);
    
    // Auto-publish if admin, otherwise pending
    if (user.get("role") === "admin") {
        record.set("status", "published");
        record.set("approvedBy", user.id);
    } else {
        record.set("status", "pending");
    }
}, "media");

/**
 * After creating media: process the file asynchronously
 */
onRecordAfterCreateRequest((e) => {
    const record = e.record;
    
    // Set initial processing status
    try {
        record.set("processingStatus", "pending");
        $app.dao().saveRecord(record);
    } catch (e) {
        // Field may not exist in schema yet
    }
    
    // Run processing in background (don't block the response)
    $app.runInBackground(() => {
        try {
            processMediaRecord(record);
        } catch (err) {
            console.error("Media processing failed:", err);
        }
    });
}, "media");

/**
 * After creating approval: update media status if approved
 */
onRecordAfterCreateRequest((e) => {
    const approval = e.record;
    const status = approval.get("status");
    const mediaId = approval.get("media");
    const reviewerId = approval.get("reviewer");
    
    if (status === "approved" && mediaId) {
        try {
            const mediaRecord = $app.dao().findRecordById("media", mediaId);
            mediaRecord.set("status", "published");
            mediaRecord.set("approvedBy", reviewerId);
            $app.dao().saveRecord(mediaRecord);
            
            // Update the approval with review timestamp
            approval.set("reviewedAt", new Date().toISOString());
            $app.dao().saveRecord(approval);
        } catch (err) {
            console.error("Failed to update media status:", err);
        }
    } else if (status === "rejected" && mediaId) {
        try {
            const mediaRecord = $app.dao().findRecordById("media", mediaId);
            mediaRecord.set("status", "rejected");
            $app.dao().saveRecord(mediaRecord);
            
            approval.set("reviewedAt", new Date().toISOString());
            $app.dao().saveRecord(approval);
        } catch (err) {
            console.error("Failed to update media status:", err);
        }
    }
}, "approvals");

/**
 * Main processing function for media records
 */
function processMediaRecord(record) {
    const recordId = record.id;
    const collectionId = record.collection().id;
    const fileName = record.get("file");
    const mediaType = record.get("type");
    const procDir = PROCESS_DIR + "/" + recordId;
    const storagePath = $app.dataDir() + "/storage/" + collectionId + "/" + recordId;
    const originalPath = storagePath + "/" + fileName;
    let processingFailed = false;
    let errorMessage = null;
    
    try {
        // Set processing status
        try {
            record.set("processingStatus", "processing");
            $app.dao().saveRecord(record);
        } catch (e) {
            // Field may not exist in schema yet
        }
        
        if (!fileName) {
            throw new Error("No file attached to media record");
        }
        
        // Create processing subdirectory for this record
        try {
            $os.mkdir(procDir, 0o755);
        } catch (e) {
            // May already exist
        }
        
        // Extract EXIF metadata first
        const exifData = extractExif(originalPath);
        
        // Update record with EXIF data
        if (exifData.width) record.set("width", exifData.width);
        if (exifData.height) record.set("height", exifData.height);
        if (exifData.orientation) record.set("orientation", exifData.orientation);
        if (exifData.takenAt) record.set("takenAt", exifData.takenAt);
        
        // Generate checksum for deduplication
        const checksum = generateChecksum(originalPath);
        if (checksum) {
            record.set("checksum", checksum);
            
            // Check for existing media with same checksum
            try {
                const existingMedia = $app.dao().findFirstRecordByFilter(
                    "media",
                    "checksum='" + checksum + "' && id!='" + recordId + "'"
                );
                
                if (existingMedia) {
                    console.log("Duplicate media detected:", recordId, "matches existing:", existingMedia.id);
                    // Optionally link to existing record or skip processing
                    // For now, we'll continue processing but log the duplicate
                    // You could set a duplicateOf field if added to schema
                }
            } catch (e) {
                // No existing record found, which is fine
            }
        }
        
        // Process based on media type
        if (mediaType === "image") {
            processImage(record, originalPath, procDir, storagePath);
        } else if (mediaType === "video") {
            processVideo(record, originalPath, procDir, storagePath);
        }
        
        // Save updated record and mark as completed
        try {
            record.set("processingStatus", "completed");
            record.set("processingError", null);
        } catch (e) {
            // Fields may not exist in schema yet
        }
        $app.dao().saveRecord(record);
        
    } catch (err) {
        processingFailed = true;
        errorMessage = err.message || String(err);
        console.error("Media processing failed for record", recordId, ":", errorMessage);
        
        // Mark record with error status
        try {
            record.set("processingStatus", "failed");
            record.set("processingError", errorMessage);
            $app.dao().saveRecord(record);
        } catch (e) {
            console.error("Failed to save error status:", e);
        }
    } finally {
        // Cleanup processing directory
        try {
            $os.removeAll(procDir);
        } catch (e) {
            console.error("Failed to cleanup processing dir:", e);
        }
        
        // Cleanup partial files from storage if processing failed
        if (processingFailed) {
            try {
                // List files in storage directory
                const files = $os.readdir(storagePath);
                // Remove derived files (display, blur, thumb, video, poster)
                const derivedPrefixes = ["display_", "blur_", "thumb_", "video_", "poster_"];
                for (const file of files) {
                    for (const prefix of derivedPrefixes) {
                        if (file.startsWith(prefix)) {
                            try {
                                $os.remove(storagePath + "/" + file);
                            } catch (e) {
                                console.error("Failed to remove partial file:", file, e);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to cleanup partial files:", e);
            }
        }
    }
}

/**
 * Extract EXIF metadata using exiftool
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
        const output = execCommand("exiftool", ["-json", "-ImageWidth", "-ImageHeight", "-Orientation", "-DateTimeOriginal", "-Duration", filePath]);
        
        if (output) {
            const data = JSON.parse(output);
            if (data && data[0]) {
                const exif = data[0];
                result.width = exif.ImageWidth || null;
                result.height = exif.ImageHeight || null;
                result.orientation = exif.Orientation || null;
                
                // Parse date
                if (exif.DateTimeOriginal) {
                    // Convert EXIF date format "YYYY:MM:DD HH:MM:SS" to ISO
                    const parts = exif.DateTimeOriginal.replace(/:/g, "-").replace(" ", "T");
                    result.takenAt = parts;
                }
                
                // Parse duration for videos
                if (exif.Duration) {
                    // Duration might be in format "0:00:30" or seconds
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
 * Generate SHA256 checksum of a file
 */
function generateChecksum(filePath) {
    try {
        const output = execCommand("sha256sum", [filePath]);
        if (output) {
            return output.split(" ")[0];
        }
    } catch (err) {
        console.error("Checksum generation failed:", err);
    }
    return null;
}

/**
 * Process image: generate display, blur, and thumbnail variants
 */
function processImage(record, originalPath, procDir, storagePath) {
    const recordId = record.id;
    const collectionId = record.collection().id;
    
    // Display image (1080p fit)
    const displayPath = procDir + "/display.jpg";
    try {
        execCommand("ffmpeg", [
            "-y", "-i", originalPath,
            "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
            "-q:v", "3",
            displayPath
        ]);
        
        // Move to storage and set URL
        const displayFileName = "display_" + recordId + ".jpg";
        const displayStoragePath = storagePath + "/" + displayFileName;
        $os.rename(displayPath, displayStoragePath);
        record.set("displayUrl", buildFileUrl(collectionId, recordId, displayFileName));
    } catch (err) {
        console.error("Display image generation failed:", err);
    }
    
    // Blurred backdrop
    const blurPath = procDir + "/blur.jpg";
    try {
        execCommand("ffmpeg", [
            "-y", "-i", originalPath,
            "-vf", "scale=80:-1,gblur=sigma=20,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
            "-q:v", "5",
            blurPath
        ]);
        
        const blurFileName = "blur_" + recordId + ".jpg";
        const blurStoragePath = storagePath + "/" + blurFileName;
        $os.rename(blurPath, blurStoragePath);
        record.set("blurUrl", buildFileUrl(collectionId, recordId, blurFileName));
    } catch (err) {
        console.error("Blur image generation failed:", err);
    }
    
    // Thumbnail (300px)
    const thumbPath = procDir + "/thumb.jpg";
    try {
        execCommand("ffmpeg", [
            "-y", "-i", originalPath,
            "-vf", "scale=300:-1",
            "-q:v", "4",
            thumbPath
        ]);
        
        const thumbFileName = "thumb_" + recordId + ".jpg";
        const thumbStoragePath = storagePath + "/" + thumbFileName;
        $os.rename(thumbPath, thumbStoragePath);
        record.set("thumbUrl", buildFileUrl(collectionId, recordId, thumbFileName));
    } catch (err) {
        console.error("Thumbnail generation failed:", err);
    }
}

/**
 * Process video: transcode, extract poster, get duration
 */
function processVideo(record, originalPath, procDir, storagePath) {
    const recordId = record.id;
    const collectionId = record.collection().id;
    
    // Get video duration from EXIF/ffprobe
    try {
        const output = execCommand("ffprobe", [
            "-v", "quiet",
            "-show_entries", "format=duration",
            "-of", "csv=p=0",
            originalPath
        ]);
        if (output) {
            record.set("duration", parseFloat(output.trim()));
        }
    } catch (err) {
        console.error("Duration extraction failed:", err);
    }
    
    // Transcode to H.264 1080p
    const videoPath = procDir + "/video.mp4";
    try {
        execCommand("ffmpeg", [
            "-y", "-i", originalPath,
            "-vf", "scale=1920:-2",
            "-c:v", "libx264",
            "-preset", "medium",
            "-crf", "22",
            "-c:a", "aac",
            "-movflags", "+faststart",
            videoPath
        ]);
        
        const videoFileName = "video_" + recordId + ".mp4";
        const videoStoragePath = storagePath + "/" + videoFileName;
        $os.rename(videoPath, videoStoragePath);
        record.set("videoUrl", buildFileUrl(collectionId, recordId, videoFileName));
    } catch (err) {
        console.error("Video transcode failed:", err);
    }
    
    // Extract poster frame at 1 second (or first frame for short videos)
    const posterPath = procDir + "/poster.jpg";
    let posterCreated = false;
    try {
        execCommand("ffmpeg", [
            "-y", "-i", originalPath,
            "-ss", "00:00:01",
            "-vframes", "1",
            "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
            "-q:v", "3",
            posterPath
        ]);
        
        // Verify poster was created before moving
        try {
            $os.stat(posterPath);
            posterCreated = true;
        } catch (e) {
            console.error("Poster file was not created:", e);
            throw new Error("Poster extraction failed: file not created");
        }
        
        const posterFileName = "poster_" + recordId + ".jpg";
        const posterStoragePath = storagePath + "/" + posterFileName;
        $os.rename(posterPath, posterStoragePath);
        record.set("posterUrl", buildFileUrl(collectionId, recordId, posterFileName));
    } catch (err) {
        console.error("Poster extraction failed:", err);
        posterCreated = false;
    }
    
    // Generate blurred backdrop from poster (only if poster was successfully created)
    const blurPath = procDir + "/blur.jpg";
    if (posterCreated) {
        try {
            // Use the poster file from storage (after it's been moved)
            const posterSource = storagePath + "/poster_" + recordId + ".jpg";
            // Verify poster exists in storage before using
            try {
                $os.stat(posterSource);
            } catch (e) {
                throw new Error("Poster file not found in storage");
            }
            execCommand("ffmpeg", [
                "-y", "-i", posterSource,
                "-vf", "scale=80:-1,gblur=sigma=20,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
                "-q:v", "5",
                blurPath
            ]);
        
        const blurFileName = "blur_" + recordId + ".jpg";
        const blurStoragePath = storagePath + "/" + blurFileName;
        $os.rename(blurPath, blurStoragePath);
        record.set("blurUrl", buildFileUrl(collectionId, recordId, blurFileName));
    } catch (err) {
        console.error("Video blur generation failed:", err);
    }
    
    // Generate thumbnail from poster
    const thumbPath = procDir + "/thumb.jpg";
    try {
        execCommand("ffmpeg", [
            "-y", "-i", originalPath,
            "-ss", "00:00:01",
            "-vframes", "1",
            "-vf", "scale=300:-1",
            "-q:v", "4",
            thumbPath
        ]);
        
        const thumbFileName = "thumb_" + recordId + ".jpg";
        const thumbStoragePath = storagePath + "/" + thumbFileName;
        $os.rename(thumbPath, thumbStoragePath);
        record.set("thumbUrl", buildFileUrl(collectionId, recordId, thumbFileName));
    } catch (err) {
        console.error("Video thumbnail generation failed:", err);
    }
}

/**
 * Build PocketBase file URL
 */
function buildFileUrl(collectionId, recordId, fileName) {
    return "/api/files/" + collectionId + "/" + recordId + "/" + fileName;
}

/**
 * Execute a command and return stdout
 * @throws {Error} If command fails or returns no output when expected
 */
function execCommand(cmd, args) {
    try {
        const result = $os.exec(cmd, ...args);
        if (result === null || result === undefined) {
            throw new Error(`Command "${cmd}" returned null or undefined`);
        }
        return result;
    } catch (err) {
        const errorMsg = `Failed to execute command "${cmd}": ${err.message || err}`;
        console.error(errorMsg, "Args:", args);
        throw new Error(errorMsg);
    }
}

