import React, { FormEvent, useState, useRef } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES, MAX_FILE_SIZE_DISPLAY } from "../constants";
import { Notification } from "../components/Notification";
import { useNotification } from "../hooks/useNotification";

type FileWithId = {
  id: string;
  file: File;
};

type UploadProgress = {
  file: File;
  progress: number;
  status: "pending" | "uploading" | "success" | "error";
  error?: string;
};

/**
 * Generate a unique ID for tracking file uploads
 */
function generateFileId(file: File): string {
  return `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function UploadPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<FileWithId[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
  const [isDragging, setIsDragging] = useState(false);
  const { error, message, setError, setMessage, showMessage } = useNotification();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const validateFile = (file: File): string | null => {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return `File size (${(file.size / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size of ${MAX_FILE_SIZE_DISPLAY}`;
    }

    // Validate MIME type
    const isValidType = 
      (ALLOWED_IMAGE_TYPES as readonly string[]).includes(file.type) || 
      (ALLOWED_VIDEO_TYPES as readonly string[]).includes(file.type);

    if (!isValidType) {
      return `Invalid file type: ${file.type}. Please upload an image or video file.`;
    }

    return null;
  };

  const handleFiles = (fileList: FileList | File[]) => {
    const fileArray = Array.from(fileList);
    const validFilesWithIds: FileWithId[] = [];
    const errors: string[] = [];

    fileArray.forEach((file) => {
      const validationError = validateFile(file);
      if (validationError) {
        errors.push(`${file.name}: ${validationError}`);
      } else {
        validFilesWithIds.push({
          id: generateFileId(file),
          file,
        });
      }
    });

    if (errors.length > 0) {
      setError(errors.join("; "));
    } else {
      setError(null);
    }

    if (validFilesWithIds.length > 0) {
      setFiles((prev) => [...prev, ...validFilesWithIds]);
      // Initialize progress tracking using callback to avoid race conditions
      setUploadProgress((prev) => {
        const newProgress = { ...prev };
        validFilesWithIds.forEach(({ id, file }) => {
          newProgress[id] = {
            file,
            progress: 0,
            status: "pending",
          };
        });
        return newProgress;
      });
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFiles(e.target.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const uploadFile = async (fileWithId: FileWithId): Promise<void> => {
    const { id, file } = fileWithId;
    let progressInterval: ReturnType<typeof setInterval> | null = null;

    // Update status to uploading
    setUploadProgress((prev) => ({
      ...prev,
      [id]: { ...prev[id], status: "uploading", progress: 0 },
    }));

    const form = new FormData();
    form.append("file", file);
    form.append("type", file.type.startsWith("video/") ? "video" : "image");
    form.append("status", user?.role === "admin" ? "published" : "pending");
    form.append("owner", user?.id ?? "");

    try {
      // PocketBase doesn't provide progress events in the SDK, so we simulate progress
      progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          const current = prev[id];
          if (current && current.progress < 90) {
            return {
              ...prev,
              [id]: { ...current, progress: current.progress + 10 },
            };
          }
          return prev;
        });
      }, 200);

      await pb.collection("media").create(form);

      clearInterval(progressInterval);
      
      // Mark as success
      setUploadProgress((prev) => ({
        ...prev,
        [id]: { ...prev[id], status: "success", progress: 100 },
      }));

      // Remove from files list after 2 seconds
      setTimeout(() => {
        setFiles((prev) => prev.filter((f) => f.id !== id));
        setUploadProgress((prev) => {
          const newProgress = { ...prev };
          delete newProgress[id];
          return newProgress;
        });
      }, 2000);
    } catch (err) {
      setUploadProgress((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        },
      }));
      throw err;
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;

    showMessage("Uploading...");
    setError(null);

    // Upload files sequentially
    for (const fileWithId of files) {
      try {
        await uploadFile(fileWithId);
      } catch (err) {
        // Error already tracked in uploadProgress
        console.error("Upload failed for", fileWithId.file.name, err);
      }
    }

    showMessage("Upload complete");
    setTimeout(() => setMessage(null), 3000);
  };

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    setUploadProgress((prev) => {
      const newProgress = { ...prev };
      delete newProgress[fileId];
      return newProgress;
    });
  };

  return (
    <section>
      <h1>Upload</h1>
      <form onSubmit={onSubmit}>
        <div
          ref={dropZoneRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`drop-zone${isDragging ? " dragging" : ""}`}
          style={{ marginBottom: "1rem" }}
          onClick={() => fileInputRef.current?.click()}
        >
          <p style={{ color: "var(--color-text-muted)", marginBottom: "0.5rem" }}>
            Drag and drop files here, or click to select
          </p>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem" }}>
            Supports images and videos (max {MAX_FILE_SIZE_DISPLAY} per file)
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          onChange={handleFileChange}
          multiple
          style={{ display: "none" }}
        />
        
        {files.length > 0 && (
          <div style={{ marginBottom: "1rem" }}>
            <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Selected Files ({files.length})</h3>
            {files.map(({ id, file }) => {
              const progress = uploadProgress[id];
              return (
                <div
                  key={id}
                  style={{
                    padding: "0.75rem",
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius)",
                    marginBottom: "0.5rem",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                    <span style={{ fontSize: "0.875rem" }}>{file.name}</span>
                    {progress?.status !== "uploading" && (
                      <button
                        type="button"
                        onClick={() => removeFile(id)}
                        className="btn-icon"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {progress && (
                    <div>
                      {progress.status === "uploading" && (
                        <div className="progress-bar">
                          <div
                            className="progress-bar-fill"
                            style={{ width: `${progress.progress}%` }}
                          />
                        </div>
                      )}
                      {progress.status === "success" && (
                        <span style={{ color: "var(--color-success)", fontSize: "0.875rem" }}>✓ Uploaded</span>
                      )}
                      {progress.status === "error" && (
                        <span style={{ color: "var(--color-error)", fontSize: "0.875rem" }}>✗ {progress.error}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <button type="submit" disabled={files.length === 0 || Object.values(uploadProgress).some(p => p.status === "uploading")}>
          {Object.values(uploadProgress).some(p => p.status === "uploading") ? "Uploading..." : `Upload ${files.length > 0 ? `${files.length} file${files.length > 1 ? "s" : ""}` : ""}`}
        </button>
      </form>
      <Notification error={error} message={message} />
    </section>
  );
}

