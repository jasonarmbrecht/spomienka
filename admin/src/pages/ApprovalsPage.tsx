import { useCallback, useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";

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
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      });
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
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
      // Create audit record in approvals collection
      // Backend hook will handle media status update automatically
      await pb.collection("approvals").create({
        media: mediaId,
        reviewer: user.id,
        status: newStatus === "published" ? "approved" : "rejected",
        notes: mediaNotes,
        reviewedAt: new Date().toISOString(),
      });

      // Clear notes for this media
      const newNotes = { ...notes };
      delete newNotes[mediaId];
      setNotes(newNotes);

      // Reload the list
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
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
          // Backend hook will handle media status update automatically
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
        const failedCount = results.failed.length;
        const successCount = results.success.length;
        setError(
          `Bulk approve completed with errors: ${successCount} approved, ${failedCount} failed. ${results.failed.map(f => f.error).join("; ")}`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk approve failed");
    } finally {
      setProcessing(null);
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section>
      <h1>Approvals</h1>
      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}
      
      {items.length > 0 && (
        <div style={{ marginBottom: "1rem" }}>
          <button 
            onClick={approveAll} 
            disabled={processing !== null}
          >
            {processing === "all" ? "Processing..." : `Approve All (${items.length})`}
          </button>
        </div>
      )}
      
      {items.length === 0 && !loading && (
        <p>No pending items to review.</p>
      )}
      
      <ul>
        {items.map((m) => {
          const previewUrl = m.thumbUrl || m.displayUrl || m.posterUrl;
          const pbUrl = import.meta.env.VITE_PB_URL || "";
          const fullPreviewUrl = previewUrl ? `${pbUrl}${previewUrl}` : null;
          
          return (
            <li key={m.id} style={{ display: "flex", alignItems: "flex-start", gap: "1rem", padding: "1rem" }}>
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
                    style={{
                      width: "100%",
                      minHeight: "60px",
                      padding: "0.5rem",
                      marginTop: "0.25rem",
                      background: "var(--color-bg)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "var(--radius)",
                      color: "var(--color-text)",
                      fontFamily: "inherit",
                      fontSize: "0.875rem",
                    }}
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button 
                    onClick={() => act(m.id, "published")}
                    disabled={processing !== null}
                  >
                    {processing === m.id ? "..." : "Approve"}
                  </button>
                  <button 
                    onClick={() => act(m.id, "rejected")}
                    disabled={processing !== null}
                    style={{ background: "var(--color-error)" }}
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
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "2rem",
          }}
          onClick={() => setSelectedMedia(null)}
        >
          <div style={{ position: "relative", maxWidth: "90vw", maxHeight: "90vh" }}>
            <button
              onClick={() => setSelectedMedia(null)}
              style={{
                position: "absolute",
                top: "-2.5rem",
                right: 0,
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
                padding: "0.5rem 1rem",
                borderRadius: "var(--radius)",
                cursor: "pointer",
              }}
            >
              Close
            </button>
            {selectedMedia.type === "image" ? (
              <img
                src={`${import.meta.env.VITE_PB_URL || ""}${selectedMedia.displayUrl || selectedMedia.file}`}
                alt={selectedMedia.title || selectedMedia.file}
                style={{
                  maxWidth: "100%",
                  maxHeight: "90vh",
                  objectFit: "contain",
                }}
              />
            ) : (
              <video
                src={`${import.meta.env.VITE_PB_URL || ""}${selectedMedia.videoUrl || selectedMedia.file}`}
                poster={selectedMedia.posterUrl ? `${import.meta.env.VITE_PB_URL || ""}${selectedMedia.posterUrl}` : undefined}
                controls
                style={{
                  maxWidth: "100%",
                  maxHeight: "90vh",
                }}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
