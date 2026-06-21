import { useEffect, useState } from "react";
import { pb } from "../pb/client";

const pbUrl = import.meta.env.VITE_PB_URL as string;

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

const ITEMS_PER_PAGE = 50;

const escapeFilterValue = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending" | "rejected" | "unpublished">("all");
  const [hoveredItem, setHoveredItem] = useState<Media | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [mediaToDelete, setMediaToDelete] = useState<Media | null>(null);
  const [reprocessing, setReprocessing] = useState<Set<string>>(new Set());
  const [togglingPublish, setTogglingPublish] = useState<Set<string>>(new Set());
  const [reprocessingAll, setReprocessingAll] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);

  const bulkDelete = async () => {
    setBulkDeleting(true);
    try {
      await Promise.all([...selectedIds].map((id) => pb.collection("media").delete(id)));
      setItems((prev) => prev.filter((m) => !selectedIds.has(m.id)));
      setTotalItems((n) => n - selectedIds.size);
      setSelectedIds(new Set());
    } catch (err) {
      console.error("Bulk delete failed:", err);
    } finally {
      setBulkDeleting(false);
      setShowBulkDeleteModal(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const allSelected = items.length > 0 && items.every((m) => selectedIds.has(m.id));
  const someSelected = items.some((m) => selectedIds.has(m.id));

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
    } catch (err) {
      console.error("Failed to delete media:", err);
    } finally {
      setMediaToDelete(null);
    }
  };

  const togglePublish = async (id: string, currentStatus: string) => {
    setTogglingPublish((prev) => new Set(prev).add(id));
    try {
      const newStatus = currentStatus === "published" ? "unpublished" : "published";
      await pb.collection("media").update(id, { status: newStatus });
      setItems((prev) => prev.map((m) => m.id === id ? { ...m, status: newStatus } : m));
    } catch (err) {
      console.error("Failed to toggle publish status:", err);
    } finally {
      setTogglingPublish((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
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
        if (filter !== "all") filters.push(`status='${filter}'`);
        if (typeFilter !== "all") filters.push(`type='${typeFilter}'`);
        if (searchQuery.trim()) {
          const term = escapeFilterValue(searchQuery.trim());
          filters.push(`title~'${term}' || file~'${term}'`);
        }
        if (dateFrom) filters.push(`created>='${escapeFilterValue(dateFrom)}'`);
        if (dateTo) filters.push(`created<='${escapeFilterValue(dateTo)}'`);
        if (tagFilter.trim()) {
          const tag = escapeFilterValue(tagFilter.trim());
          filters.push(`tags~'${tag}'`);
        }
        const filterString = filters.join(" && ");
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
    setSelectedIds(new Set());
  }, [filter, searchQuery, typeFilter, dateFrom, dateTo, tagFilter, sortField]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [page]);

  return (
    <section className="page-wide">
      <div className="section-header">
        <h1>Library</h1>
        <button
          onClick={reprocessAll}
          disabled={reprocessingAll}
          title="Re-run ffmpeg processing on all media to regenerate assets in the current output format"
        >
          {reprocessingAll ? "Reprocessing…" : "Reprocess All"}
        </button>
      </div>

      <div className="filter-bar">
        <label className="filter-label-grow">
          Search
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
          />
        </label>
        <label>
          Status
          <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All</option>
            <option value="published">Published</option>
            <option value="unpublished">Unpublished</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label>
          Type
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}>
            <option value="all">All</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </label>
        <label>
          From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </label>
        <label>
          Tag
          <input
            type="text"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            placeholder="Tag..."
          />
        </label>
        <label>
          Sort
          <select value={sortField} onChange={(e) => setSortField(e.target.value)}>
            <option value="-created">Added ↓</option>
            <option value="created">Added ↑</option>
            <option value="-takenAt">Taken ↓</option>
            <option value="takenAt">Taken ↑</option>
            <option value="title">Title A–Z</option>
            <option value="-title">Title Z–A</option>
          </select>
        </label>
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
          <label className="label-checkbox">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              onChange={toggleSelectAll}
            />
            Select all
            {someSelected && <span className="library-selection-count">({selectedIds.size} selected)</span>}
          </label>
          {selectedIds.size > 0 && (
            <button
              className="btn btn-sm btn-danger"
              onClick={() => setShowBulkDeleteModal(true)}
              disabled={bulkDeleting}
            >
              Delete {selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}

      <ul>
        {items.map((m) => {
          const isHeic = /\.heic$/i.test(m.file);
          const derivedUrl = m.processingStatus !== "failed"
            ? (m.thumbUrl || m.displayUrl || m.posterUrl) || null
            : null;
          const fallbackUrl = (m.type === "image" && !isHeic && m.processingStatus !== "failed")
            ? pb.files.getURL(m, m.file, { thumb: "144x0" })
            : null;
          const thumbSrc = derivedUrl ? `${pbUrl}${derivedUrl}` : (fallbackUrl || null);
          const meta = buildMeta(m);
          const isSelected = selectedIds.has(m.id);
          return (
            <li key={m.id} className={`library-item${isSelected ? " library-item-selected" : ""}`}>
              <input
                type="checkbox"
                className="library-checkbox"
                checked={isSelected}
                onChange={() => toggleSelect(m.id)}
                aria-label={`Select ${m.title || m.file}`}
              />
              {thumbSrc && (
                <img
                  src={thumbSrc}
                  alt=""
                  className="library-thumb"
                  onMouseEnter={() => setHoveredItem(m)}
                  onMouseLeave={() => setHoveredItem(null)}
                  onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              )}
              <div className="library-item-info">
                <span>{m.title || m.file}</span>
                {meta && <p className="library-item-meta">{meta}</p>}
              </div>
              <div className="library-actions">
                <span className={`library-status${m.status === "published" ? " library-status-published" : m.status === "rejected" ? " library-status-failed" : m.status === "unpublished" ? " library-status-unpublished" : ""}`}>
                  {m.status}
                </span>
                <button
                  className={`btn btn-sm library-toggle-btn${m.status === "published" ? " library-toggle-btn-unpublish" : " library-toggle-btn-publish"}`}
                  onClick={() => togglePublish(m.id, m.status)}
                  disabled={togglingPublish.has(m.id)}
                  title={m.status === "published" ? "Unpublish this item" : "Publish this item"}
                >
                  {togglingPublish.has(m.id) ? "…" : m.status === "published" ? "Unpublish" : "Publish"}
                </button>
                {m.processingStatus && m.processingStatus !== "completed" && (
                  <span className={`library-status${m.processingStatus === "failed" ? " library-status-failed" : ""}`}>
                    {m.processingStatus}
                  </span>
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

      {showBulkDeleteModal && (
        <Modal
          title="Delete Selected"
          onConfirm={bulkDelete}
          onCancel={() => setShowBulkDeleteModal(false)}
          confirmLabel={bulkDeleting ? "Deleting…" : `Delete ${selectedIds.size} item${selectedIds.size !== 1 ? "s" : ""}`}
          confirmDestructive
        >
          <p>Delete <strong>{selectedIds.size}</strong> item{selectedIds.size !== 1 ? "s" : ""}? This cannot be undone.</p>
        </Modal>
      )}

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
        const isHeic = /\.heic$/i.test(hoveredItem.file);
        const derivedPreview = hoveredItem.displayUrl || hoveredItem.posterUrl || hoveredItem.thumbUrl || null;
        const previewSrc = derivedPreview
          ? `${pbUrl}${derivedPreview}`
          : (hoveredItem.type === "image" && !isHeic
              ? pb.files.getURL(hoveredItem, hoveredItem.file, { thumb: "840x0" })
              : null);
        if (!previewSrc) return null;
        const PREVIEW_W = 420;
        const OFFSET_X = 18;
        const OFFSET_Y = 12;
        const x = hoverPos.x + OFFSET_X + PREVIEW_W > window.innerWidth
          ? hoverPos.x - OFFSET_X - PREVIEW_W
          : hoverPos.x + OFFSET_X;
        const y = Math.max(8, Math.min(hoverPos.y - OFFSET_Y, window.innerHeight - 320));
        return (
          <div className="library-hover-preview" style={{ left: x, top: y }}>
            <img src={previewSrc} alt="" />
          </div>
        );
      })()}

      <Pagination page={page} totalPages={totalPages} loading={loading} onPageChange={setPage} />
    </section>
  );
}
