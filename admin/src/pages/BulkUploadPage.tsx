import React, { FormEvent, useEffect, useRef, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { MAX_FILE_SIZE_DISPLAY, ALLOWED_IMAGE_TYPES, ALLOWED_VIDEO_TYPES } from "../constants";
import { Notification } from "../components/Notification";
import { useNotification } from "../hooks/useNotification";
import { FileWithId, UploadProgress, generateFileId, validateFile, uploadOneFile } from "../uploadUtils";
import type { DeviceRecord } from "../types/pocketbase";
import {
  Grid,
  Column,
  Heading,
  Button,
  FileUploaderDropContainer,
  FileUploaderItem,
  InlineNotification,
  ProgressBar,
  Stack,
} from "@carbon/react";
import { Upload } from "@carbon/icons-react";

// Fixed rather than user-adjustable: viewer devices aren't showing their
// slideshow during a bulk upload, so there's no live tradeoff to tune —
// this is set to a sensible value for typical Raspberry Pi core counts.
const BULK_UPLOAD_CONCURRENCY = 4;

const MAX_ADMIN_LOG_LINES = 100;
const MAX_DEVICE_LOG_LINES = 15;
const PROGRESS_BROADCAST_MIN_INTERVAL_MS = 1500;
const PROGRESS_BROADCAST_MIN_FILES = 10;
const RETRY_DELAYS_MS = [2000, 5000];

const BULK_HISTORY_KEY = "spomienka:bulkUploadedKeys";

function fileKey(file: File): string {
  return `${file.name}:${file.size}`;
}

function loadUploadedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(BULK_HISTORY_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Stats = { done: number; failed: number; total: number };

export function BulkUploadPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<FileWithId[]>([]);
  const [uploadProgress, setUploadProgress] = useState<Record<string, UploadProgress>>({});
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<Stats>({ done: 0, failed: 0, total: 0 });
  const [logLines, setLogLines] = useState<string[]>([]);
  const [skippedCount, setSkippedCount] = useState(0);
  const { error, message, setError, setMessage, showMessage } = useNotification();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logPanelRef = useRef<HTMLDivElement>(null);

  const uploadedKeysRef = useRef<Set<string>>(loadUploadedKeys());
  const runningRef = useRef(false);
  const devicesRef = useRef<DeviceRecord[]>([]);
  const statsRef = useRef<{ done: number; failed: number; total: number; lines: string[] }>({
    done: 0,
    failed: 0,
    total: 0,
    lines: [],
  });

  useEffect(() => {
    if (logPanelRef.current) {
      logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }
  }, [logLines]);

  // Best-effort: revert viewer devices even if the admin navigates away or
  // closes the tab mid-batch. Not guaranteed to complete (browsers may not
  // finish in-flight requests on unload) — the viewer's own safety timeout
  // is the real backstop for that case.
  useEffect(() => {
    const sendEnd = () => {
      if (!runningRef.current) return;
      devicesRef.current.forEach((d) => {
        pb.collection("device_inbox")
          .create({ device_id: d.id, type: "bulk-upload-end" }, { requestKey: null })
          .catch(() => {});
      });
    };
    window.addEventListener("beforeunload", sendEnd);
    return () => {
      window.removeEventListener("beforeunload", sendEnd);
      sendEnd();
    };
  }, []);

  const persistUploadedKeys = () => {
    try {
      localStorage.setItem(BULK_HISTORY_KEY, JSON.stringify(Array.from(uploadedKeysRef.current)));
    } catch {
      // localStorage unavailable/full — resumability degrades gracefully, the upload itself is unaffected
    }
  };

  const resetHistory = () => {
    uploadedKeysRef.current = new Set();
    try {
      localStorage.removeItem(BULK_HISTORY_KEY);
    } catch {
      // ignore
    }
    setSkippedCount(0);
  };

  const handleFiles = (fileList: File[]) => {
    const validFilesWithIds: FileWithId[] = [];
    const errors: string[] = [];
    let skipped = 0;

    fileList.forEach((file) => {
      const validationError = validateFile(file);
      if (validationError) {
        errors.push(validationError);
        return;
      }
      if (uploadedKeysRef.current.has(fileKey(file))) {
        skipped++;
        return;
      }
      validFilesWithIds.push({ id: generateFileId(file), file });
    });

    setError(errors.length > 0 ? errors.join("; ") : null);
    if (skipped > 0) setSkippedCount((prev) => prev + skipped);

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

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
    setUploadProgress((prev) => {
      const next = { ...prev };
      delete next[fileId];
      return next;
    });
  };

  const broadcastToDevices = async (type: string, payload?: Record<string, unknown>) => {
    await Promise.allSettled(
      devicesRef.current.map((d) =>
        pb.collection("device_inbox").create({ device_id: d.id, type, payload }, { requestKey: null })
      )
    );
  };

  const uploadWithRetry = async (
    file: File,
    ownerId: string,
    role: string | undefined
  ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        await uploadOneFile(file, { ownerId, role, bulkUpload: true });
        return { ok: true };
      } catch (err) {
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        } else {
          return { ok: false, error: err };
        }
      }
    }
    // Unreachable, but keeps TypeScript happy about the loop's exit paths.
    return { ok: false, error: new Error("Upload failed") };
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (running) return;

    const queue = files.filter((f) => uploadProgress[f.id]?.status !== "success");
    if (queue.length === 0) return;

    setError(null);
    setRunning(true);
    runningRef.current = true;

    const total = queue.length;
    statsRef.current = { done: 0, failed: 0, total, lines: [] };
    setStats({ done: 0, failed: 0, total });
    setLogLines([]);

    try {
      devicesRef.current = await pb.collection("devices").getFullList<DeviceRecord>({ requestKey: null });
    } catch {
      devicesRef.current = [];
    }

    await broadcastToDevices("bulk-upload-start");

    let lastBroadcastAt = Date.now();
    let sinceBroadcast = 0;

    const maybeBroadcastProgress = (force = false) => {
      sinceBroadcast++;
      const now = Date.now();
      if (!force && now - lastBroadcastAt < PROGRESS_BROADCAST_MIN_INTERVAL_MS && sinceBroadcast < PROGRESS_BROADCAST_MIN_FILES) {
        return;
      }
      lastBroadcastAt = now;
      sinceBroadcast = 0;
      const { done, failed, total: t, lines } = statsRef.current;
      void broadcastToDevices("bulk-upload-progress", {
        done,
        total: t,
        failed,
        lines: lines.slice(-MAX_DEVICE_LOG_LINES),
      });
    };

    const ownerId = user?.id ?? "";
    const role = user?.role;
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const item = queue[idx];

        setUploadProgress((prev) => ({ ...prev, [item.id]: { ...prev[item.id], status: "uploading" } }));
        const result = await uploadWithRetry(item.file, ownerId, role);

        if (result.ok) {
          statsRef.current.done++;
          uploadedKeysRef.current.add(fileKey(item.file));
          persistUploadedKeys();
          statsRef.current.lines.push(`${item.file.name} uploaded`);
          setUploadProgress((prev) => ({ ...prev, [item.id]: { ...prev[item.id], status: "success" } }));
        } else {
          statsRef.current.failed++;
          const msg = result.error instanceof Error ? result.error.message : "Upload failed";
          statsRef.current.lines.push(`${item.file.name} failed: ${msg}`);
          setUploadProgress((prev) => ({ ...prev, [item.id]: { ...prev[item.id], status: "error", error: msg } }));
        }

        setStats({ done: statsRef.current.done, failed: statsRef.current.failed, total: statsRef.current.total });
        setLogLines(statsRef.current.lines.slice(-MAX_ADMIN_LOG_LINES));
        maybeBroadcastProgress();
      }
    };

    await Promise.all(Array.from({ length: BULK_UPLOAD_CONCURRENCY }, worker));

    maybeBroadcastProgress(true);
    await broadcastToDevices("bulk-upload-end");

    setRunning(false);
    runningRef.current = false;
    showMessage("Bulk upload complete");
    setTimeout(() => setMessage(null), 5000);
  };

  const pendingFiles = files.filter((f) => uploadProgress[f.id]?.status !== "success");
  const progressValue = stats.total > 0 ? stats.done + stats.failed : 0;
  const percent = stats.total > 0 ? Math.round((progressValue / stats.total) * 100) : 0;

  return (
    <Grid>
      <Column sm={4} md={8} lg={8}>
        <Heading style={{ marginBottom: "1.5rem" }}>Bulk Upload</Heading>

        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Keep this device awake and this browser tab open"
          subtitle="Viewer devices will pause their slideshow and show upload progress until this finishes."
          style={{ marginBottom: "1.5rem", maxWidth: "none" }}
        />

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
                disabled={running}
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

            {skippedCount > 0 && (
              <p style={{ fontSize: "0.75rem", color: "var(--cds-text-secondary)" }}>
                {skippedCount} file{skippedCount > 1 ? "s" : ""} skipped — already uploaded in a previous run.{" "}
                <Button kind="ghost" size="sm" onClick={resetHistory} disabled={running}>
                  Reset bulk upload history
                </Button>
              </p>
            )}

            {files.length > 0 && (
              <div>
                <p style={{ marginBottom: "0.5rem", fontWeight: 500 }}>
                  Selected Files ({files.length}
                  {pendingFiles.length > 0 && pendingFiles.length !== files.length
                    ? `, ${pendingFiles.length} pending`
                    : ""}
                  )
                </p>
                <div style={{ maxHeight: "16rem", overflowY: "auto" }}>
                  {files.map(({ id, file }) => {
                    const progress = uploadProgress[id];
                    const uploaderStatus =
                      progress?.status === "success"
                        ? "complete"
                        : progress?.status === "uploading"
                        ? "uploading"
                        : "edit";
                    return (
                      <div key={id} style={{ marginBottom: "0.5rem", maxWidth: "20rem" }}>
                        <FileUploaderItem
                          name={file.name}
                          status={uploaderStatus}
                          invalid={progress?.status === "error"}
                          errorSubject={progress?.error}
                          onDelete={() => !running && removeFile(id)}
                          uuid={id}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {stats.total > 0 && (
              <div>
                <ProgressBar
                  label="Bulk upload progress"
                  helperText={`${progressValue} / ${stats.total} (${percent}%)${stats.failed > 0 ? `, ${stats.failed} failed` : ""}`}
                  value={progressValue}
                  max={stats.total}
                  status={!running ? "finished" : "active"}
                />
                <div
                  ref={logPanelRef}
                  style={{
                    marginTop: "0.75rem",
                    maxHeight: "12rem",
                    overflowY: "auto",
                    background: "var(--cds-layer-01)",
                    border: "1px solid var(--cds-border-subtle-01)",
                    borderRadius: "4px",
                    padding: "0.5rem 0.75rem",
                    fontFamily: "monospace",
                    fontSize: "0.75rem",
                    lineHeight: 1.6,
                  }}
                >
                  {logLines.length === 0 ? (
                    <span style={{ color: "var(--cds-text-secondary)" }}>Waiting for uploads to start...</span>
                  ) : (
                    logLines.map((line, i) => <div key={i}>{line}</div>)
                  )}
                </div>
              </div>
            )}

            <Button type="submit" kind="primary" disabled={pendingFiles.length === 0 || running}>
              {running
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
