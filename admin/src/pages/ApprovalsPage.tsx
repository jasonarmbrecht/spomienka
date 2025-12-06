import { useEffect, useState } from "react";
import { pb } from "../pb/client";

type Media = {
  id: string;
  title?: string;
  file: string;
  type: "image" | "video";
  status: string;
};

export function ApprovalsPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const act = async (id: string, status: "published" | "rejected") => {
    await pb.collection("media").update(id, { status });
    await load();
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <section>
      <h1>Approvals</h1>
      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            <span>{m.title || m.file}</span>
            <button onClick={() => act(m.id, "published")}>Approve</button>
            <button onClick={() => act(m.id, "rejected")}>Reject</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

