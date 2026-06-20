// Custom file-serving route for derived media assets (display, blur, thumb, poster, video).
//
// PocketBase's /api/files/ endpoint only serves files registered in file-type schema fields.
// Derived files are written directly to disk by the processing hook and must be served here.
//
// Route: GET /api/spomienka/media/:collectionId/:recordId/:filename
// Auth:  none required (media assets are not sensitive)

routerAdd("GET", "/api/spomienka/media/{collectionId}/{recordId}/{filename}", (e) => {
    const collectionId = e.request.pathValue("collectionId");
    const recordId     = e.request.pathValue("recordId");
    const filename     = e.request.pathValue("filename");

    // Reject path traversal or non-derived filenames.
    if (
        !filename ||
        filename.indexOf("/") !== -1 ||
        filename.indexOf("..") !== -1 ||
        !/^(display_|blur_|thumb_|poster_|video_)[^/]+$/.test(filename)
    ) {
        return e.json(404, { message: "Not found" });
    }

    const filePath =
        $app.dataDir() +
        "/storage/" +
        collectionId +
        "/" +
        recordId +
        "/" +
        filename;

    let bytes;
    try {
        bytes = $os.readFile(filePath);
    } catch (_) {
        return e.json(404, { message: "File not found" });
    }

    const ext = filename.split(".").pop().toLowerCase();
    const contentTypes = {
        png:  "image/png",
        jpg:  "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        mp4:  "video/mp4",
    };
    const contentType = contentTypes[ext] || "application/octet-stream";

    e.response.header().set("Cache-Control", "public, max-age=86400");
    return e.blob(200, contentType, bytes);
});
