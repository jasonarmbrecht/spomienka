import { pb } from "./pb/client";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from "./constants";

export type FileWithId = {
  id: string;
  file: File;
};

export type UploadStatus = "pending" | "uploading" | "success" | "error";

export type UploadProgress = {
  file: File;
  status: UploadStatus;
  error?: string;
};

export function generateFileId(file: File): string {
  return `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function validateFile(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `${file.name}: size (${(file.size / 1024 / 1024).toFixed(2)}MB) exceeds max ${MAX_FILE_SIZE_DISPLAY}`;
  }
  const isValidType =
    (ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type) ||
    (ALLOWED_VIDEO_TYPES as readonly string[]).includes(file.type);
  if (!isValidType) {
    return `${file.name}: invalid file type ${file.type}`;
  }
  return null;
}

/**
 * Uploads a single file to the media collection. The returned promise doesn't
 * resolve until the server finishes processing the file (thumbnail/poster
 * generation, video transcode, etc. all run synchronously server-side).
 *
 * `bulkUpload: true` is only honored by the backend when the requester is
 * also an admin — it scopes the upload-rate-limit bypass to the Bulk Upload
 * page without changing behavior for normal single-file uploads.
 */
export async function uploadOneFile(
  file: File,
  opts: { ownerId: string; role?: string; bulkUpload?: boolean }
): Promise<void> {
  const form = new FormData();
  form.append("file", file);
  form.append("type", file.type.startsWith("video/") ? "video" : "image");
  form.append("status", opts.role === "admin" ? "published" : "pending");
  form.append("owner", opts.ownerId);
  if (opts.bulkUpload) form.append("bulkUpload", "true");

  // requestKey: null disables the PocketBase SDK's default auto-cancellation
  // of concurrent requests to the same endpoint — without it, the Bulk Upload
  // page's parallel worker pool has each new create() cancel the previous
  // still-in-flight one.
  await pb.collection("media").create(form, { requestKey: null });
}
