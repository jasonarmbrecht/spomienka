import React, { FormEvent, useState, useRef } from "react";
import { useAuth } from "../pb/auth";
import { MAX_FILE_SIZE_DISPLAY, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from "../constants";
import { Notification } from "../components/Notification";
import { useNotification } from "../hooks/useNotification";
import { FileWithId, UploadProgress, generateFileId, validateFile, uploadOneFile } from "../uploadUtils";
import {
  Grid,
  Column,
  Heading,
  Button,
  FileUploaderDropContainer,
  FileUploaderItem,
  InlineLoading,
  Stack,
} from "@carbon/react";
import { Upload } from "@carbon/icons-react";

export function UploadPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<FileWithId[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
  const { error, message, setError, setMessage, showMessage } = useNotification();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          next[id] = { file, status: "pending" };
        });
        return next;
      });
    }
  };

  const uploadFile = async (fileWithId: FileWithId): Promise<void> => {
    const { id, file } = fileWithId;

    setUploadProgress((prev) => ({ ...prev, [id]: { ...prev[id], status: "uploading" } }));

    try {
      // This request doesn't resolve until the server finishes processing the
      // file (thumbnail/poster generation, video transcode, etc. all run
      // synchronously server-side) — for video that can take a while, so
      // there's no meaningful progress percentage to show in the meantime.
      await uploadOneFile(file, { ownerId: user?.id ?? "", role: user?.role });
      setUploadProgress((prev) => ({ ...prev, [id]: { ...prev[id], status: "success" } }));
    } catch (err) {
      setUploadProgress((prev) => ({
        ...prev,
        [id]: { ...prev[id], status: "error", error: err instanceof Error ? err.message : "Upload failed" },
      }));
      throw err;
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const pendingFiles = files.filter((f) => uploadProgress[f.id]?.status !== "success");
    if (pendingFiles.length === 0) return;

    showMessage("Uploading...");
    setError(null);

    for (const fileWithId of pendingFiles) {
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
  const pendingFiles = files.filter((f) => uploadProgress[f.id]?.status !== "success");

  return (
    <Grid>
      <Column sm={4} md={8} lg={8}>
        <Heading style={{ marginBottom: "1.5rem" }}>Upload</Heading>
        <form onSubmit={onSubmit}>
          <Stack gap={6}>
            <div>
              <FileUploaderDropContainer
                labelText={
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.375rem" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                      <Upload size={20} />
                      Drag and drop files here, or click to select
                    </span>
                    <span style={{ fontSize: "0.75rem", color: "var(--cds-text-secondary)" }}>
                      Supports images and videos (max {MAX_FILE_SIZE_DISPLAY} per file)
                    </span>
                  </span>
                }
                multiple
                accept={[...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES]}
                onAddFiles={(_e, { addedFiles }) => handleFiles(addedFiles)}
                style={{ width: "100%", maxWidth: "none", minHeight: "120px", display: "flex", alignItems: "center", justifyContent: "center" }}
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
                  Selected Files ({files.length}
                  {pendingFiles.length > 0 && pendingFiles.length !== files.length
                    ? `, ${pendingFiles.length} pending`
                    : ""}
                  )
                </p>
                {files.map(({ id, file }) => {
                  const progress = uploadProgress[id];
                  const uploaderStatus =
                    progress?.status === "success"
                      ? "complete"
                      : progress?.status === "uploading"
                      ? "uploading"
                      : "edit";
                  return (
                    // Carbon's FileUploaderItem hardcodes max-inline-size: 20rem on
                    // its root element (.cds--file__selected-file); cap this wrapper
                    // to match so the ProgressBar below it doesn't stretch wider.
                    <div key={id} style={{ marginBottom: "0.5rem", maxWidth: "20rem" }}>
                      <FileUploaderItem
                        name={file.name}
                        status={uploaderStatus}
                        invalid={progress?.status === "error"}
                        errorSubject={progress?.error}
                        onDelete={() => removeFile(id)}
                        uuid={id}
                      />
                      {progress?.status === "success" && (
                        <span style={{ fontSize: "0.75rem", color: "var(--cds-support-success, #24a148)" }}>
                          Uploaded
                        </span>
                      )}
                      {progress?.status === "uploading" && (
                        <InlineLoading
                          status="active"
                          description={
                            file.type.startsWith("video/")
                              ? "Processing video — this can take a few minutes on this device..."
                              : "Processing..."
                          }
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
              disabled={pendingFiles.length === 0 || isUploading}
            >
              {isUploading
                ? "Uploading..."
                : `Upload${pendingFiles.length > 0 ? ` ${pendingFiles.length} file${pendingFiles.length > 1 ? "s" : ""}` : ""}`}
            </Button>
          </Stack>
        </form>
        <Notification error={error} message={message} />
      </Column>
    </Grid>
  );
}
