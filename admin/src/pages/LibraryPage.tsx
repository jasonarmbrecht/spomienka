import { useEffect, useState } from "react";
import { pb } from "../pb/client";

type Media = {
  id: string;
  file: string;
  status: string;
  type: "image" | "video";
};

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending">("all");

  useEffect(() => {
    const load = async () => {
      const res = await pb.collection("media").getList<Media>(1, 100, {
        filter: filter === "all" ? "" : `status='${filter}'`,
        sort: "-created",
      });
      setItems(res.items);
    };
    load();
  }, [filter]);

  return (
    <section>
      <h1>Library</h1>
      <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
        <option value="all">All</option>
        <option value="published">Published</option>
        <option value="pending">Pending</option>
      </select>
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            <span>{m.file}</span> — {m.status} ({m.type})
          </li>
        ))}
      </ul>
    </section>
  );
}

