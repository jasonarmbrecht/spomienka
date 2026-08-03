import React, { FormEvent, useState, useRef } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES, MAX_FILE_SIZE_DISPLAY } from "../constants";
import { Notification } from "../components/Notification";
import { useNotification } from "../hooks/useNotification";
import {
  Grid,
  Column,
  Heading,
  Button,
  FileUploaderDropContainer,
  FileUploaderItem,
  ProgressBar,
  Stack,
} from "@carbon/react";
import { Upload } from "@carbon/icons-react";

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

function generateFileId(file: File): string {
  return `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function UploadPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<FileWithId[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
  const { error, message, setError, setMessage, showMessage } = useNotification();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = (file: File): string | null => {
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
  };

  const handleFiles = (fileList: File[]) => {
    const validFilesWithIds: FileWithId[] = [];
    const errors: string[] = [];

    fileList.forEach((file) => {
      const validationError = validateFile(file);
      if (validationError) {
        errors.push(validationError);
      } else {
        validFilesWithIds.push({ id: generateFileId(file), file });
      }
    });

    if (errors.length > 0) {
      setError(errors.join("; "));
    } else {
      setError(null);
    }

    if (validFilesWithIds.length > 0) {
      setFiles((prev) => [...prev, ...validFilesWithIds]);
      setUploadProgress((prev) => {
        const next = { ...prev };
        validFilesWithIds.forEach(({ id, file }) => {
          next[id] = { file, progress: 0, status: "pending" };
        });
        return next;
      });
    }
  };

  const uploadFile = async (fileWithId: FileWithId): Promise<void> => {
    const { id, file } = fileWithId;
    let progressInterval: ReturnType<typeof setInterval> | null = null;

    setUploadProgress((prev) => ({ ...prev, [id]: { ...prev[id], status: "uploading", progress: 0 } }));

    const form = new FormData();
    form.append("file", file);
    form.append("type", file.type.startsWith("video/") ? "video" : "image");
    form.append("status", user?.role === "admin" ? "published" : "pending");
    form.append("owner", user?.id ?? "");

    try {
      progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          const current = prev[id];
          if (current && current.progress < 90) {
            return { ...prev, [id]: { ...current, progress: current.progress + 10 } };
          }
          return prev;
        });
      }, 200);

      await pb.collection("media").create(form);

      clearInterval(progressInterval);
      setUploadProgress((prev) => ({ ...prev, [id]: { ...prev[id], status: "success", progress: 100 } }));
    } catch (err) {
      setUploadProgress((prev) => ({
        ...prev,
        [id]: { ...prev[id], status: "error", error: err instanceof Error ? err.message : "Upload failed" },
      }));
      throw err;
    } finally {
      if (progressInterval) clearInterval(progressInterval);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (files.length === 0) return;

    showMessage("Uploading...");
    setError(null);

    for (const fileWithId of files) {
      try {
        await uploadFile(fileWithId);
      } catch (err) {
        console.error("Upload failed for", fileWithId.file.name, err);
      }
    }

    showMessage("Upload complete");
    setTimeout(() => setMessage(null), 3000);
  };

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    setUploadProgress((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  };

  const isUploading = Object.values(uploadProgress).some((p) => p.status === "uploading");

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <Heading style={{ marginBottom: "1.5rem" }}>Upload</Heading>
        <Grid className="cds--grid--no-gutter" style={{ margin: 0 }}>
          <Column sm={4} md={6} lg={10}>
            <form onSubmit={onSubmit}>
              <Stack gap={6}>
                <div>
                  <FileUploaderDropContainer
                    labelText={
                      <>
                        <Upload size={32} style={{ display: "block", margin: "0 auto 0.5rem" }} />
                        Drag and drop files here, or click to select
                        <br />
                        <span style={{ fontSize: "0.75rem", color: "var(--cds-text-secondary)" }}>
                          Supports images and videos (max {MAX_FILE_SIZE_DISPLAY} per file)
                        </span>
                      </>
                    }
                    multiple
                    accept={[...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES]}
                    onAddFiles={(_e, { addedFiles }) => handleFiles(addedFiles)}
                    style={{ width: "100%", minHeight: "120px", display: "flex", alignItems: "center", justifyContent: "center" }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      if (e.target.files) handleFiles(Array.from(e.target.files));
                    }}
                    multiple
                    style={{ display: "none" }}
                  />
                </div>

                {files.length > 0 && (
                  <div>
                    <p style={{ marginBottom: "0.5rem", fontWeight: 500 }}>
                      Selected Files ({files.length})
                    </p>
                    {files.map(({ id, file }) => {
                      const progress = uploadProgress[id];
                      const uploaderStatus =
                        progress?.status === "success"
                          ? "complete"
                          : progress?.status === "error"
                          ? "edit"
                          : progress?.status === "uploading"
                          ? "uploading"
                          : "edit";
                      return (
                        <div key={id} style={{ marginBottom: "0.5rem" }}>
                          <FileUploaderItem
                            name={file.name}
                            status={uploaderStatus}
                            errorSubject={progress?.error}
                            onDelete={() => removeFile(id)}
                            uuid={id}
                          />
                          {progress?.status === "uploading" && (
                            <ProgressBar
                              value={progress.progress}
                              max={100}
                              label={file.name}
                              hideLabel
                              size="sm"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <Button
                  type="submit"
                  kind="primary"
                  disabled={files.length === 0 || isUploading}
                >
                  {isUploading
                    ? "Uploading..."
                    : `Upload${files.length > 0 ? ` ${files.length} file${files.length > 1 ? "s" : ""}` : ""}`}
                </Button>
              </Stack>
            </form>
            <Notification error={error} message={message} />
          </Column>
        </Grid>
      </Column>
    </Grid>
  );
}
