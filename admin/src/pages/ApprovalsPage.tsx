import { useCallback, useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { Modal } from "../components/Modal";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { EmptyState } from "../components/EmptyState";
import { useNotification } from "../hooks/useNotification";

type Media = {
  id: string;
  title?: string;
  file: string;
  type: "image" | "video";
  status: string;
  thumbUrl?: string;
  displayUrl?: string;
  posterUrl?: string;
  videoUrl?: string;
  width?: number;
  height?: number;
};

export function ApprovalsPage() {
  const { user } = useAuth();
  const { error, setError, showError } = useNotification();
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<Media | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pb.collection("media").getList<Media>(1, 50, {
        filter: "status='pending'",
        sort: "-created",
        requestKey: null,
      });
      setItems(res.items);
    } catch (err) {
      showError(err, "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const act = async (mediaId: string, newStatus: "published" | "rejected") => {
    if (!user) return;

    const mediaNotes = notes[mediaId] || "";
    if (newStatus === "rejected" && !mediaNotes.trim()) {
      setError("Please provide a reason for rejection");
      return;
    }

    setProcessing(mediaId);
    setError(null);

    try {
      await pb.collection("approvals").create({
        media: mediaId,
        reviewer: user.id,
        status: newStatus === "published" ? "approved" : "rejected",
        notes: mediaNotes,
        reviewedAt: new Date().toISOString(),
      });

      const newNotes = { ...notes };
      delete newNotes[mediaId];
      setNotes(newNotes);

      await load();
    } catch (err) {
      showError(err, "Action failed");
    } finally {
      setProcessing(null);
    }
  };

  const approveAll = async () => {
    if (!user || items.length === 0) return;

    setProcessing("all");
    setError(null);

    const results: { success: string[]; failed: Array<{ id: string; error: string }> } = {
      success: [],
      failed: [],
    };

    try {
      for (const item of items) {
        try {
          await pb.collection("approvals").create({
            media: item.id,
            reviewer: user.id,
            status: "approved",
            notes: "Bulk approved",
            reviewedAt: new Date().toISOString(),
          });
          results.success.push(item.id);
        } catch (err) {
          results.failed.push({
            id: item.id,
            error: err instanceof Error ? err.message : "Unknown error",
          });
        }
      }

      await load();

      if (results.failed.length > 0) {
        setError(
          `Bulk approve completed with errors: ${results.success.length} approved, ${results.failed.length} failed. ${results.failed.map((f) => f.error).join("; ")}`
        );
      }
    } catch (err) {
      showError(err, "Bulk approve failed");
    } finally {
      setProcessing(null);
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  const pbUrl = import.meta.env.VITE_PB_URL || "";

  return (
    <section>
      <h1>Approvals</h1>
      {loading && <LoadingSpinner label="Loading approvals..." />}
      {error && <p className="error">{error}</p>}

      {items.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <button onClick={approveAll} disabled={processing !== null}>
            {processing === "all" ? "Processing..." : `Approve All (${items.length})`}
          </button>
        </div>
      )}

      {items.length === 0 && !loading && (
        <EmptyState message="No pending items to review." />
      )}

      <ul>
        {items.map((m) => {
          const previewUrl = m.thumbUrl || m.displayUrl || m.posterUrl;
          const fullPreviewUrl = previewUrl ? `${pbUrl}${previewUrl}` : null;

          return (
            <li key={m.id}>
              <div style={{ flex: 1 }}>
                {fullPreviewUrl && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <img
                      src={fullPreviewUrl}
                      alt={m.title || m.file}
                      style={{
                        maxWidth: "200px",
                        maxHeight: "150px",
                        objectFit: "contain",
                        borderRadius: "var(--radius)",
                        cursor: "pointer",
                        border: "1px solid var(--color-border)",
                      }}
                      onClick={() => setSelectedMedia(m)}
                    />
                  </div>
                )}
                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>{m.title || m.file}</strong>
                  {m.width && m.height && (
                    <span style={{ color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
                      ({m.width}×{m.height})
                    </span>
                  )}
                  <span style={{ color: "var(--color-text-muted)", marginLeft: "0.5rem" }}>
                    {m.type}
                  </span>
                </div>
                <label style={{ display: "block", marginBottom: "0.5rem" }}>
                  Notes (required for rejection):
                  <textarea
                    value={notes[m.id] || ""}
                    onChange={(e) => setNotes({ ...notes, [m.id]: e.target.value })}
                    placeholder="Add notes..."
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button onClick={() => act(m.id, "published")} disabled={processing !== null}>
                    {processing === m.id ? "..." : "Approve"}
                  </button>
                  <button
                    onClick={() => act(m.id, "rejected")}
                    disabled={processing !== null}
                    className="btn-danger"
                  >
                    {processing === m.id ? "..." : "Reject"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {selectedMedia && (
        <Modal
          title={selectedMedia.title || selectedMedia.file}
          onCancel={() => setSelectedMedia(null)}
        >
          {selectedMedia.type === "image" ? (
            <img
              src={`${pbUrl}${selectedMedia.displayUrl || selectedMedia.file}`}
              alt={selectedMedia.title || selectedMedia.file}
              style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", display: "block" }}
            />
          ) : (
            <video
              src={`${pbUrl}${selectedMedia.videoUrl || selectedMedia.file}`}
              poster={selectedMedia.posterUrl ? `${pbUrl}${selectedMedia.posterUrl}` : undefined}
              controls
              style={{ maxWidth: "100%", maxHeight: "70vh", display: "block" }}
            />
          )}
        </Modal>
      )}
    </section>
  );
}
