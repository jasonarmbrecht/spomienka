import { useEffect, useState } from "react";
import { pb } from "../pb/client";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { useNotification } from "../hooks/useNotification";

type Media = {
  id: string;
  collectionId: string;
  file: string;
  status: string;
  type: "image" | "video";
  title?: string;
  tags?: string[];
  takenAt?: string;
  created: string;
  width?: number;
  height?: number;
  duration?: number;
  thumbUrl?: string;
  displayUrl?: string;
  posterUrl?: string;
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function buildMeta(m: Media): string {
  const parts: string[] = [];
  const ext = m.file.split(".").pop()?.toUpperCase();
  if (ext) parts.push(ext);
  if (m.width && m.height) parts.push(`${m.width}×${m.height}`);
  if (m.type === "video" && m.duration) parts.push(formatDuration(m.duration));
  const date = m.takenAt || m.created;
  if (date) parts.push(date.slice(0, 10));
  return parts.join(" · ");
}

const ITEMS_PER_PAGE = 50;

const escapeFilterValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const pbUrl = import.meta.env.VITE_PB_URL || "";

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending" | "rejected">("all");
  const [hoveredItem, setHoveredItem] = useState<Media | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [mediaToDelete, setMediaToDelete] = useState<Media | null>(null);

  const deleteMedia = async (id: string) => {
    try {
      await pb.collection("media").delete(id);
      setItems((prev) => prev.filter((m) => m.id !== id));
      setTotalItems((n) => n - 1);
    } catch (err) {
      console.error("Failed to delete media:", err);
    } finally {
      setMediaToDelete(null);
    }
  };
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const { error, setError, showError } = useNotification();
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
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
          filters.push(`created>='${escapeFilterValue(dateFrom)}'`);
        }

        if (dateTo) {
          filters.push(`created<='${escapeFilterValue(dateTo)}'`);
        }

        if (tagFilter.trim()) {
          const tag = escapeFilterValue(tagFilter.trim());
          filters.push(`tags~'${tag}'`);
        }

        const filterString = filters.length > 0 ? filters.join(" && ") : "";

        const res = await pb.collection("media").getList<Media>(page, ITEMS_PER_PAGE, {
          filter: filterString,
          sort: "-created",
          requestKey: null,
        });
        setItems(res.items);
        setTotalPages(res.totalPages);
        setTotalItems(res.totalItems);
      } catch (err) {
        showError(err, "Failed to load library");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [filter, page, searchQuery, typeFilter, dateFrom, dateTo, tagFilter]);

  useEffect(() => {
    setPage(1);
  }, [filter, searchQuery, typeFilter, dateFrom, dateTo, tagFilter]);

  return (
    <section className="page-wide">
      <h1>Library</h1>

      <div className="filter-bar">
        <div className="filter-row">
          <label className="filter-label-grow">
            Search
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by title or filename..."
            />
          </label>

          <label>
            Status
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
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
            >
              <option value="all">All</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
          </label>
        </div>

        <div className="filter-row">
          <label>
            Date From
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>

          <label>
            Date To
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>

          <label className="filter-label-grow">
            Tag Filter
            <input
              type="text"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="Filter by tag..."
            />
          </label>
        </div>
      </div>

      {loading && <LoadingSpinner label="Loading library..." />}
      {error && <p className="error">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <EmptyState
          message={`No media found${filter !== "all" ? ` with status "${filter}"` : ""}.`}
        />
      )}

      {!loading && !error && totalItems > 0 && (
        <p className="result-count">
          Showing {(page - 1) * ITEMS_PER_PAGE + 1} to{" "}
          {Math.min(page * ITEMS_PER_PAGE, totalItems)} of {totalItems} items
        </p>
      )}

      <ul>
        {items.map((m) => {
          const fileBase = `/api/files/${m.collectionId}/${m.id}/${m.file}`;
          const thumbSrc = m.thumbUrl || m.displayUrl || m.posterUrl
            || (m.type === "image" ? `${fileBase}?thumb=144x108` : null);
          const meta = buildMeta(m);
          return (
            <li key={m.id} className="library-item">
              {thumbSrc ? (
                <img
                  src={`${pbUrl}${thumbSrc}`}
                  alt=""
                  className="library-thumb"
                  onMouseEnter={() => setHoveredItem(m)}
                  onMouseLeave={() => setHoveredItem(null)}
                  onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
                />
              ) : (
                <div className="library-thumb library-thumb-placeholder" />
              )}
              <div className="library-item-info">
                <span>{m.title || m.file}</span>
                {meta && <p className="library-item-meta">{meta}</p>}
              </div>
              <div className="library-actions">
                <span className="library-status">{m.status}</span>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => {/* TODO: edit */}}
                >
                  Edit
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => setMediaToDelete(m)}
                >
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {mediaToDelete && (
        <Modal
          title="Delete Media"
          onConfirm={() => deleteMedia(mediaToDelete.id)}
          onCancel={() => setMediaToDelete(null)}
          confirmLabel="Delete"
          confirmDestructive
        >
          <p>Delete <strong>{mediaToDelete.title || mediaToDelete.file}</strong>? This cannot be undone.</p>
        </Modal>
      )}

      {hoveredItem && (() => {
        const fileBase = `/api/files/${hoveredItem.collectionId}/${hoveredItem.id}/${hoveredItem.file}`;
        const previewSrc = hoveredItem.displayUrl || hoveredItem.posterUrl || hoveredItem.thumbUrl
          || (hoveredItem.type === "image" ? `${fileBase}?thumb=840x0` : null);
        if (!previewSrc) return null;
        const PREVIEW_W = 420;
        const OFFSET_X = 18;
        const OFFSET_Y = 12;
        const x = hoverPos.x + OFFSET_X + PREVIEW_W > window.innerWidth
          ? hoverPos.x - OFFSET_X - PREVIEW_W
          : hoverPos.x + OFFSET_X;
        const y = Math.max(8, Math.min(hoverPos.y - OFFSET_Y, window.innerHeight - 320));
        return (
          <div
            className="library-hover-preview"
            style={{ left: x, top: y }}
          >
            <img src={`${pbUrl}${previewSrc}`} alt="" />
          </div>
        );
      })()}

      <Pagination page={page} totalPages={totalPages} loading={loading} onPageChange={setPage} />
    </section>
  );
}
