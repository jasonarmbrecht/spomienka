import { useEffect, useState } from "react";
import { pb } from "../pb/client";

type Media = {
  id: string;
  file: string;
  status: string;
  type: "image" | "video";
  title?: string;
  tags?: string[];
  takenAt?: string;
  created: string;
};

const ITEMS_PER_PAGE = 50;

const escapeFilterValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending" | "rejected">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // Build filter string
        const filters: string[] = [];
        
        if (filter !== "all") {
          filters.push(`status='${filter}'`);
        }
        
        if (typeFilter !== "all") {
          filters.push(`type='${typeFilter}'`);
        }
        
        if (searchQuery.trim()) {
          const term = escapeFilterValue(searchQuery.trim());
          filters.push(`title~'${term}' || file~'${term}'`);
        }
        
        if (dateFrom) {
          filters.push(`created>='${dateFrom}'`);
        }
        
        if (dateTo) {
          filters.push(`created<='${dateTo}'`);
        }
        
        if (tagFilter.trim()) {
          // Tags are stored as JSON array, so we need to check if it contains the tag
          const tag = escapeFilterValue(tagFilter.trim());
          filters.push(`tags~'${tag}'`);
        }

        const filterString = filters.length > 0 ? filters.join(" && ") : "";

        const res = await pb.collection("media").getList<Media>(page, ITEMS_PER_PAGE, {
          filter: filterString,
          sort: "-created",
        });
        setItems(res.items);
        setTotalPages(res.totalPages);
        setTotalItems(res.totalItems);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load library");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [filter, page, searchQuery, typeFilter, dateFrom, dateTo, tagFilter]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [filter, searchQuery, typeFilter, dateFrom, dateTo, tagFilter]);

  return (
    <section>
      <h1>Library</h1>
      
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <label style={{ flex: "1", minWidth: "200px" }}>
            Search
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title or filename..."
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </label>
          
          <label>
            Status
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              style={{ marginTop: "0.25rem" }}
            >
              <option value="all">All</option>
              <option value="published">Published</option>
              <option value="pending">Pending</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
          
          <label>
            Type
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
              style={{ marginTop: "0.25rem" }}
            >
              <option value="all">All</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
          </label>
        </div>
        
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
          <label>
            Date From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{ marginTop: "0.25rem" }}
            />
          </label>
          
          <label>
            Date To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={{ marginTop: "0.25rem" }}
            />
          </label>
          
          <label style={{ flex: "1", minWidth: "200px" }}>
            Tag Filter
            <input
              type="text"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="Filter by tag..."
              style={{ width: "100%", marginTop: "0.25rem" }}
            />
          </label>
        </div>
      </div>
      
      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}
      
      {!loading && !error && items.length === 0 && (
        <p>No media found{filter !== "all" ? ` with status "${filter}"` : ""}.</p>
      )}
      
      {!loading && !error && totalItems > 0 && (
        <p style={{ color: "var(--color-text-muted)", marginBottom: "1rem" }}>
          Showing {((page - 1) * ITEMS_PER_PAGE) + 1} to {Math.min(page * ITEMS_PER_PAGE, totalItems)} of {totalItems} items
        </p>
      )}
      
      <ul>
        {items.map((m) => (
          <li key={m.id}>
            <span>{m.title || m.file}</span> — {m.status} ({m.type})
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "1.5rem", justifyContent: "center" }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
          >
            Previous
          </button>
          <span style={{ color: "var(--color-text-muted)" }}>
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages || loading}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
