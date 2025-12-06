import { useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";

type Media = {
  id: string;
  title?: string;
  file: string;
  type: "image" | "video";
  status: string;
};

export function ApprovalsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  const load = async () => {
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
  };

  const act = async (mediaId: string, newStatus: "published" | "rejected") => {
    if (!user) return;
    
    setProcessing(mediaId);
    setError(null);
    
    try {
      // Update media status and set approvedBy if publishing
      const mediaUpdate: Record<string, unknown> = { status: newStatus };
      if (newStatus === "published") {
        mediaUpdate.approvedBy = user.id;
      }
      await pb.collection("media").update(mediaId, mediaUpdate);

      // Create audit record in approvals collection
      await pb.collection("approvals").create({
        media: mediaId,
        reviewer: user.id,
        status: newStatus === "published" ? "approved" : "rejected",
        notes: "",
        reviewedAt: new Date().toISOString(),
      });

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
    
    try {
      for (const item of items) {
        await pb.collection("media").update(item.id, {
          status: "published",
          approvedBy: user.id,
        });
        await pb.collection("approvals").create({
          media: item.id,
          reviewer: user.id,
          status: "approved",
          notes: "Bulk approved",
          reviewedAt: new Date().toISOString(),
        });
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk approve failed");
    } finally {
      setProcessing(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

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
        {items.map((m) => (
          <li key={m.id}>
            <span>{m.title || m.file}</span>
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
          </li>
        ))}
      </ul>
    </section>
  );
}
