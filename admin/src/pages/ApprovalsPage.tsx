import { useCallback, useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { Modal } from "../components/Modal";
import { EmptyState } from "../components/EmptyState";
import { useNotification } from "../hooks/useNotification";
import {
  Grid,
  Column,
  Heading,
  Button,
  Tile,
  TextArea,
  InlineNotification,
  InlineLoading,
  Stack,
} from "@carbon/react";
import { Checkmark, Close } from "@carbon/icons-react";

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
          `Bulk approve completed: ${results.success.length} approved, ${results.failed.length} failed. ${results.failed.map((f) => f.error).join("; ")}`
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

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <Heading>Approvals</Heading>
          {items.length > 0 && (
            <Button
              kind="secondary"
              size="sm"
              renderIcon={Checkmark}
              onClick={approveAll}
              disabled={processing !== null}
            >
              {processing === "all" ? "Processing..." : `Approve All (${items.length})`}
            </Button>
          )}
        </div>

        {loading && <InlineLoading description="Loading approvals..." />}

        {error && (
          <InlineNotification
            kind="error"
            title={error}
            lowContrast
            hideCloseButton
            style={{ marginBottom: "1rem" }}
          />
        )}

        {items.length === 0 && !loading && (
          <EmptyState message="No pending items to review." />
        )}

        <Stack gap={5}>
          {items.map((m) => {
            const previewUrl = m.thumbUrl || m.displayUrl || m.posterUrl || null;

            return (
              <Tile key={m.id}>
                <Stack gap={4}>
                  {previewUrl && (
                    <img
                      src={previewUrl}
                      alt={m.title || m.file}
                      style={{
                        maxWidth: "200px",
                        maxHeight: "150px",
                        objectFit: "contain",
                        cursor: "pointer",
                        border: "1px solid var(--cds-border-subtle-01)",
                        borderRadius: "4px",
                      }}
                      onClick={() => setSelectedMedia(m)}
                    />
                  )}
                  <div>
                    <p style={{ fontWeight: 600 }}>{m.title || m.file}</p>
                    <p className="cds--label" style={{ color: "var(--cds-text-secondary)" }}>
                      {m.type}
                      {m.width && m.height && ` · ${m.width}×${m.height}`}
                    </p>
                  </div>
                  <TextArea
                    id={`notes-${m.id}`}
                    labelText="Notes (required for rejection)"
                    rows={3}
                    value={notes[m.id] || ""}
                    onChange={(e) => setNotes({ ...notes, [m.id]: e.target.value })}
                    placeholder="Add notes..."
                  />
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <Button
                      kind="primary"
                      size="sm"
                      renderIcon={Checkmark}
                      onClick={() => act(m.id, "published")}
                      disabled={processing !== null}
                    >
                      {processing === m.id ? "..." : "Approve"}
                    </Button>
                    <Button
                      kind="danger"
                      size="sm"
                      renderIcon={Close}
                      onClick={() => act(m.id, "rejected")}
                      disabled={processing !== null}
                    >
                      {processing === m.id ? "..." : "Reject"}
                    </Button>
                  </div>
                </Stack>
              </Tile>
            );
          })}
        </Stack>

        {selectedMedia && (
          <Modal
            title={selectedMedia.title || selectedMedia.file}
            onCancel={() => setSelectedMedia(null)}
          >
            {selectedMedia.type === "image" ? (
              <img
                src={selectedMedia.displayUrl || selectedMedia.file}
                alt={selectedMedia.title || selectedMedia.file}
                style={{ maxWidth: "100%", maxHeight: "70vh", objectFit: "contain", display: "block" }}
              />
            ) : (
              <video
                src={selectedMedia.videoUrl || selectedMedia.file}
                poster={selectedMedia.posterUrl || undefined}
                controls
                style={{ maxWidth: "100%", maxHeight: "70vh", display: "block" }}
              />
            )}
          </Modal>
        )}
      </Column>
    </Grid>
  );
}
