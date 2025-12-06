import { useEffect, useState } from "react";
import { pb } from "../pb/client";

type Media = {
  id: string;
  file: string;
  status: string;
  type: "image" | "video";
  title?: string;
};

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending" | "rejected">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await pb.collection("media").getList<Media>(1, 100, {
          filter: filter === "all" ? "" : `status='${filter}'`,
          sort: "-created",
        });
        setItems(res.items);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load library");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [filter]);

  return (
    <section>
      <h1>Library</h1>
      
      <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
        <option value="all">All</option>
        <option value="published">Published</option>
        <option value="pending">Pending</option>
        <option value="rejected">Rejected</option>
      </select>
      
      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}
      
      {!loading && !error && items.length === 0 && (
        <p>No media found{filter !== "all" ? ` with status "${filter}"` : ""}.</p>
      )}
      
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            <span>{m.title || m.file}</span> — {m.status} ({m.type})
          </li>
        ))}
      </ul>
    </section>
  );
}
