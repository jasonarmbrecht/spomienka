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
  processingStatus?: string;
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

function thumbHeight(m: Media): number {
  if (m.width && m.height && m.width > 0) {
    return Math.min(108, Math.max(40, Math.round(72 * (m.height / m.width))));
  }
  return 54;
}

const ITEMS_PER_PAGE = 50;

const escapeFilterValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending" | "rejected">("all");
  const [hoveredItem, setHoveredItem] = useState<Media | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [mediaToDelete, setMediaToDelete] = useState<Media | null>(null);
  const [reprocessing, setReprocessing] = useState<Set<string>>(new Set());
  const [reprocessingAll, setReprocessingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeletePending, setBulkDeletePending] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(() => {
    return localStorage.getItem("libraryFiltersExpanded") === "true";
  });

  const toggleFilters = () => {
    setFiltersExpanded((v) => {
      localStorage.setItem("libraryFiltersExpanded", String(!v));
      return !v;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = items.length > 0 && items.every((m) => selectedIds.has(m.id));
  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        items.forEach((m) => next.delete(m.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        items.forEach((m) => next.add(m.id));
        return next;
      });
    }
  };

  const deleteMedia = async (id: string) => {
    try {
      await pb.collection("media").delete(id);
      setItems((prev) => prev.filter((m) => m.id !== id));
      setTotalItems((n) => n - 1);
      setSelectedIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } catch (err) {
      console.error("Failed to delete media:", err);
    } finally {
      setMediaToDelete(null);
    }
  };

  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      try {
        await pb.collection("media").delete(id);
        setItems((prev) => prev.filter((m) => m.id !== id));
        setTotalItems((n) => n - 1);
      } catch (err) {
        console.error("Failed to delete media:", err);
      }
    }
    setSelectedIds(new Set());
    setBulkDeletePending(false);
  };

  const reprocessMedia = async (id: string) => {
    setReprocessing((prev) => new Set(prev).add(id));
    try {
      await pb.send(`/api/spomienka/reprocess?id=${id}`, { method: "POST" });
      const updated = await pb.collection("media").getOne<Media>(id);
      setItems((prev) => prev.map((m) => (m.id === id ? updated : m)));
    } catch (err) {
      console.error("Reprocess failed:", err);
    } finally {
      setReprocessing((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  };

  const reprocessAll = async () => {
    setReprocessingAll(true);
    try {
      const all = await pb.collection("media").getFullList<Media>({ fields: "id" });
      for (const m of all) {
        setReprocessing((prev) => new Set(prev).add(m.id));
        try {
          await pb.send(`/api/spomienka/reprocess?id=${m.id}`, { method: "POST" });
          const updated = await pb.collection("media").getOne<Media>(m.id);
          setItems((prev) => prev.map((item) => (item.id === m.id ? updated : item)));
        } catch (err) {
          console.error(`Reprocess failed for ${m.id}:`, err);
        } finally {
          setReprocessing((prev) => { const s = new Set(prev); s.delete(m.id); return s; });
        }
      }
    } finally {
      setReprocessingAll(false);
    }
  };

  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sortField, setSortField] = useState<string>("-created");
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
          sort: sortField,
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
  }, [filter, page, searchQuery, typeFilter, dateFrom, dateTo, tagFilter, sortField]);

  useEffect(() => {
    setPage(1);
  }, [filter, searchQuery, typeFilter, dateFrom, dateTo, tagFilter, sortField]);

  return (
    <section className="page-wide">
      <div className="section-header">
        <h1>Library</h1>
        <button
          className="btn btn-secondary"
          onClick={reprocessAll}
          disabled={reprocessingAll}
          title="Re-run ffmpeg processing on all media to regenerate assets in the current output format"
        >
          {reprocessingAll ? "Reprocessing…" : "Reprocess All"}
        </button>
      </div>

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

          <label>
            Sort
            <select
              value={sortField}
              onChange={(e) => setSortField(e.target.value)}
            >
              <option value="-created">Date Added ↓</option>
              <option value="created">Date Added ↑</option>
              <option value="-takenAt">Date Taken ↓</option>
              <option value="takenAt">Date Taken ↑</option>
              <option value="title">Title A–Z</option>
              <option value="-title">Title Z–A</option>
            </select>
          </label>

          <button
            className="btn btn-secondary filter-toggle-btn"
            onClick={toggleFilters}
            title="Toggle date and tag filters"
          >
            Filters {filtersExpanded ? "▲" : "▼"}
          </button>
        </div>

        {filtersExpanded && (
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
        )}
      </div>

      {loading && <LoadingSpinner label="Loading library..." />}
      {error && <p className="error">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <EmptyState
          message={`No media found${filter !== "all" ? ` with status "${filter}"` : ""}.`}
        />
      )}

      {!loading && !error && totalItems > 0 && (
        <div className="library-list-header">
          <label className="library-select-all">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
            />
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : `${totalItems} items`}
          </label>
          {selectedIds.size > 0 && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => setBulkDeletePending(true)}
            >
              Delete Selected ({selectedIds.size})
            </button>
          )}
        </div>
      )}

      <ul>
        {items.map((m) => {
          const fileBase = `/api/files/${m.collectionId}/${m.id}/${m.file}`;
          const isHeic = /\.heic$/i.test(m.file);
          const thumbSrc = m.processingStatus !== "failed"
            ? (m.thumbUrl || m.displayUrl || m.posterUrl
               || (m.type === "image" && !isHeic ? `${fileBase}?thumb=144x108` : null))
            : null;
          const meta = buildMeta(m);
          const h = thumbHeight(m);
          const isSelected = selectedIds.has(m.id);
          return (
            <li key={m.id} className={`library-item${isSelected ? " selected" : ""}`}>
              <input
                type="checkbox"
                className="library-item-checkbox"
                checked={isSelected}
                onChange={() => toggleSelect(m.id)}
              />
              {thumbSrc ? (
                <img
                  src={thumbSrc}
                  alt=""
                  className="library-thumb"
                  style={{ width: 72, height: h }}
                  onError={(e) => {
                    const fallback = `${pbUrl}${fileBase}?thumb=144x108`;
                    if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback;
                  }}
                  onMouseEnter={() => setHoveredItem(m)}
                  onMouseLeave={() => setHoveredItem(null)}
                  onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <div className="library-thumb library-thumb-placeholder" style={{ width: 72, height: h }} />
              )}
              <div className="library-item-info">
                <span>{m.title || m.file}</span>
                {meta && <p className="library-item-meta">{meta}</p>}
              </div>
              <div className="library-actions">
                <span className="library-status">{m.status}</span>
                {m.processingStatus && m.processingStatus !== "completed" && (
                  <span className="library-status">{m.processingStatus}</span>
                )}
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => reprocessMedia(m.id)}
                  disabled={reprocessing.has(m.id)}
                  title="Regenerate processed assets (display, blur, thumb) using the current output format"
                >
                  {reprocessing.has(m.id) ? "…" : "Reprocess"}
                </button>
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

      {bulkDeletePending && (
        <Modal
          title="Delete Selected"
          onConfirm={bulkDelete}
          onCancel={() => setBulkDeletePending(false)}
          confirmLabel="Delete"
          confirmDestructive
        >
          <p>Delete <strong>{selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""}</strong>? This cannot be undone.</p>
        </Modal>
      )}

      {hoveredItem && (() => {
        const fileBase = `/api/files/${hoveredItem.collectionId}/${hoveredItem.id}/${hoveredItem.file}`;
        const isHeic = /\.heic$/i.test(hoveredItem.file);
        const previewSrc = hoveredItem.displayUrl || hoveredItem.posterUrl || hoveredItem.thumbUrl
          || (hoveredItem.type === "image" && !isHeic ? `${fileBase}?thumb=840x0` : null);
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
            <img src={previewSrc} alt="" />
          </div>
        );
      })()}

      <Pagination page={page} totalPages={totalPages} loading={loading} onPageChange={setPage} />
    </section>
  );
}
