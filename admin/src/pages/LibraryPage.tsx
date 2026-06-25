import { useEffect, useRef, useState } from "react";
import { pb } from "../pb/client";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { useNotification } from "../hooks/useNotification";
import {
  Grid,
  Column,
  Heading,
  Button,
  Tag,
  InlineNotification,
  DataTableSkeleton,
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  TableBatchActions,
  TableBatchAction,
  TableSelectAll,
  TableSelectRow,
  Select,
  SelectItem,
  DatePicker,
  DatePickerInput,
  TextInput,
  TextArea,
} from "@carbon/react";
import { TrashCan, View, ViewOff, Renew, Edit } from "@carbon/icons-react";

const pbUrl = import.meta.env.VITE_PB_URL as string;

type Media = {
  id: string;
  collectionId: string;
  file: string;
  status: string;
  processingStatus?: string;
  type: "image" | "video";
  title?: string;
  description?: string;
  location?: string;
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

function statusTagType(status: string): "green" | "gray" | "red" | "magenta" | "outline" {
  switch (status) {
    case "published": return "green";
    case "unpublished": return "gray";
    case "rejected": return "red";
    case "pending": return "magenta";
    default: return "outline";
  }
}

const headers = [
  { key: "thumb", header: "" },
  { key: "title", header: "Title / Meta" },
  { key: "status", header: "Status" },
  { key: "actions", header: "Actions" },
];

export function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [filter, setFilter] = useState<"all" | "published" | "pending" | "rejected" | "unpublished">("all");
  const [hoveredItem, setHoveredItem] = useState<Media | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [mediaToDelete, setMediaToDelete] = useState<Media | null>(null);
  const [reprocessing, setReprocessing] = useState<Set<string>>(new Set());
  const [togglingPublish, setTogglingPublish] = useState<Set<string>>(new Set());
  const [reprocessingAll, setReprocessingAll] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [pendingBulkIds, setPendingBulkIds] = useState<string[]>([]);
  const [mediaToEdit, setMediaToEdit] = useState<Media | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [saving, setSaving] = useState(false);

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
  const [stackedLayout, setStackedLayout] = useState(false);
  const [iconOnlyActions, setIconOnlyActions] = useState(false);
  const [narrowLayout, setNarrowLayout] = useState(false);
  const [veryNarrowLayout, setVeryNarrowLayout] = useState(false);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const bulkDelete = async (selectedIds: string[]) => {
    setBulkDeleting(true);
    try {
      await Promise.all(selectedIds.map((id) => pb.collection("media").delete(id)));
      setItems((prev) => prev.filter((m) => !selectedIds.includes(m.id)));
      setTotalItems((n) => n - selectedIds.length);
    } catch (err) {
      console.error("Bulk delete failed:", err);
    } finally {
      setBulkDeleting(false);
      setShowBulkDeleteModal(false);
      setPendingBulkIds([]);
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

  const openEditModal = (m: Media) => {
    setMediaToEdit(m);
    setEditTitle(m.title ?? "");
    setEditDescription(m.description ?? "");
    setEditLocation(m.location ?? "");
  };

  const saveEdit = async () => {
    if (!mediaToEdit) return;
    setSaving(true);
    try {
      const updated = await pb.collection("media").update(mediaToEdit.id, {
        title: editTitle,
        description: editDescription,
        location: editLocation,
      });
      setItems((prev) =>
        prev.map((m) =>
          m.id === mediaToEdit.id
            ? { ...m, title: updated.title, description: updated.description, location: updated.location }
            : m
        )
      );
      setMediaToEdit(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const togglePublish = async (id: string, currentStatus: string) => {
    setTogglingPublish((prev) => new Set(prev).add(id));
    try {
      const newStatus = currentStatus === "published" ? "unpublished" : "published";
      await pb.collection("media").update(id, { status: newStatus });
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: newStatus } : m)));
    } catch (err) {
      console.error("Failed to toggle publish status:", err);
    } finally {
      setTogglingPublish((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
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
      setReprocessing((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
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
          setReprocessing((prev) => {
            const s = new Set(prev);
            s.delete(m.id);
            return s;
          });
        }
      }
    } finally {
      setReprocessingAll(false);
    }
  };

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
  }, [filter, searchQuery, typeFilter, dateFrom, dateTo, tagFilter, sortField]);

  useEffect(() => {
    const el = tableContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      setIconOnlyActions(w < 1300);
      setStackedLayout(w < 900);
      setNarrowLayout(w < 770);
      setVeryNarrowLayout(w < 705);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading]);

  const rows = items.map((m) => {
    const isHeic = /\.heic$/i.test(m.file);
    const derivedUrl =
      m.processingStatus !== "failed"
        ? m.thumbUrl || m.displayUrl || m.posterUrl || null
        : null;
    const fallbackUrl =
      m.type === "image" && !isHeic && m.processingStatus !== "failed"
        ? pb.files.getURL(m, m.file, { thumb: "144x0" })
        : null;
    const thumbSrc = derivedUrl ? `${pbUrl}${derivedUrl}` : fallbackUrl || null;
    const meta = buildMeta(m);

    return {
      id: m.id,
      thumb: thumbSrc,
      title: `${m.title || m.file}||${meta}`,
      status: m.status,
      processingStatus: m.processingStatus,
      actions: m.id,
      _media: m,
    };
  });

  return (
    <Grid>
      <Column sm={4} md={8} lg={16} style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <Heading>Library</Heading>
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Renew}
            onClick={reprocessAll}
            disabled={reprocessingAll}
            title="Re-run ffmpeg processing on all media to regenerate assets in the current output format"
          >
            {reprocessingAll ? "Reprocessing…" : "Reprocess All"}
          </Button>
        </div>

        {error && (
          <InlineNotification
            kind="error"
            title={error}
            lowContrast
            hideCloseButton
            style={{ marginBottom: "1rem" }}
          />
        )}

        {/* Filter toolbar — flex-wrap so filters reflow on small screens */}
        <div className="library-filters" style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem", minWidth: 0 }}>
          <div style={{ flex: "1 1 140px", minWidth: 0 }}>
            <Select
              id="status-filter"
              labelText="Status"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              size="sm"
            >
              <SelectItem value="all" text="All" />
              <SelectItem value="published" text="Published" />
              <SelectItem value="unpublished" text="Unpublished" />
              <SelectItem value="pending" text="Pending" />
              <SelectItem value="rejected" text="Rejected" />
            </Select>
          </div>
          <div style={{ flex: "1 1 120px", minWidth: 0 }}>
            <Select
              id="type-filter"
              labelText="Type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
              size="sm"
            >
              <SelectItem value="all" text="All" />
              <SelectItem value="image" text="Image" />
              <SelectItem value="video" text="Video" />
            </Select>
          </div>
          <div style={{ flex: "2 1 260px", minWidth: 0 }}>
            <DatePicker
              datePickerType="range"
              onChange={(dates) => {
                if (dates[0]) setDateFrom(dates[0].toISOString().slice(0, 10));
                if (dates[1]) setDateTo(dates[1].toISOString().slice(0, 10));
                if (dates.length === 0) { setDateFrom(""); setDateTo(""); }
              }}
            >
              <DatePickerInput id="date-from" labelText="From" placeholder="mm/dd/yyyy" size="sm" />
              <DatePickerInput id="date-to" labelText="To" placeholder="mm/dd/yyyy" size="sm" />
            </DatePicker>
          </div>
          <div style={{ flex: "1 1 120px", minWidth: 0 }}>
            <TextInput
              id="tag-filter"
              labelText="Tag"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="Tag..."
              size="sm"
            />
          </div>
          <div style={{ flex: "1 1 140px", minWidth: 0 }}>
            <Select
              id="sort-filter"
              labelText="Sort"
              value={sortField}
              onChange={(e) => setSortField(e.target.value)}
              size="sm"
            >
              <SelectItem value="-created" text="Added ↓" />
              <SelectItem value="created" text="Added ↑" />
              <SelectItem value="-takenAt" text="Taken ↓" />
              <SelectItem value="takenAt" text="Taken ↑" />
              <SelectItem value="title" text="Title A–Z" />
              <SelectItem value="-title" text="Title Z–A" />
            </Select>
          </div>
        </div>

        {loading ? (
          <DataTableSkeleton headers={headers.map((h) => h.header)} rowCount={8} showHeader={false} showToolbar={false} />
        ) : (
          <div ref={tableContainerRef} className={stackedLayout ? "library-table-stacked" : undefined} style={{ overflowX: stackedLayout ? "hidden" : "auto", width: "100%" }}>
            <DataTable rows={rows} headers={headers}>
              {({
                rows: tableRows,
                headers: tableHeaders,
                getTableProps,
                getHeaderProps,
                getRowProps,
                getToolbarProps,
                getBatchActionProps,
                getSelectionProps,
                selectedRows,
              }) => {
                const batchActionProps = getBatchActionProps();
                return (
                  <>
                    <TableToolbar {...getToolbarProps()}>
                      <TableBatchActions {...batchActionProps}>
                        <TableBatchAction
                          renderIcon={TrashCan}
                          onClick={() => {
                            setPendingBulkIds(selectedRows.map((r) => r.id));
                            setShowBulkDeleteModal(true);
                          }}
                          disabled={bulkDeleting}
                        >
                          Delete
                        </TableBatchAction>
                      </TableBatchActions>
                      <TableToolbarContent>
                        <TableToolbarSearch
                          value={searchQuery}
                          onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                          placeholder="Search title or filename..."
                          persistent
                        />
                      </TableToolbarContent>
                    </TableToolbar>
                    <Table {...getTableProps()} size="md" className="library-table">
                      <TableHead>
                        <TableRow>
                          <TableSelectAll {...getSelectionProps()} />
                          {tableHeaders.map((header) => (
                            <TableHeader
                              {...getHeaderProps({ header })}
                              key={header.key}
                              style={(header.key === "status" || header.key === "actions") && stackedLayout ? { display: "none" } : undefined}
                            >
                              {header.header}
                            </TableHeader>
                          ))}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {tableRows.map((row) => {
                          const m = items.find((item) => item.id === row.id)!;
                          if (!m) return null;
                          const thumbSrc = row.cells.find((c) => c.info.header === "thumb")?.value as string | null;
                          const titleRaw = row.cells.find((c) => c.info.header === "title")?.value as string;
                          const [titleText, metaText] = titleRaw?.split("||") ?? ["", ""];
                          return (
                            <TableRow {...getRowProps({ row })} key={row.id}>
                              <TableSelectRow {...getSelectionProps({ row })} />
                              <TableCell style={{ padding: "0.5rem" }}>
                                {thumbSrc && (
                                  <img
                                    src={thumbSrc}
                                    alt=""
                                    style={{ width: "64px", height: "48px", objectFit: "cover", display: "block", borderRadius: "2px" }}
                                    onMouseEnter={() => setHoveredItem(m)}
                                    onMouseLeave={() => setHoveredItem(null)}
                                    onMouseMove={(e) => setHoverPos({ x: e.clientX, y: e.clientY })}
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                                  />
                                )}
                              </TableCell>
                              <TableCell>
                                <p style={{ fontWeight: 500 }}>{titleText}</p>
                                {metaText && (
                                  <p className="cds--label" style={{ color: "var(--cds-text-secondary)" }}>
                                    {metaText}
                                  </p>
                                )}
                                {stackedLayout && (
                                  <div style={{ marginTop: "0.5rem" }}>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", alignItems: "center" }}>
                                      <Tag type={statusTagType(m.status)} size="sm">{m.status}</Tag>
                                      {m.processingStatus && m.processingStatus !== "completed" && (
                                        <Tag type={m.processingStatus === "failed" ? "red" : "outline"} size="sm">{m.processingStatus}</Tag>
                                      )}
                                      {!narrowLayout && (
                                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginLeft: "-1rem" }}>
                                          <Button kind="ghost" size="sm" renderIcon={m.status === "published" ? ViewOff : View} onClick={() => togglePublish(m.id, m.status)} disabled={togglingPublish.has(m.id)} iconDescription={m.status === "published" ? "Unpublish" : "Publish"}>
                                            {togglingPublish.has(m.id) ? "…" : m.status === "published" ? "Unpublish" : "Publish"}
                                          </Button>
                                          <Button kind="ghost" size="sm" renderIcon={Renew} onClick={() => reprocessMedia(m.id)} disabled={reprocessing.has(m.id)} iconDescription="Reprocess">
                                            {reprocessing.has(m.id) ? "…" : "Reprocess"}
                                          </Button>
                                          <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit" onClick={() => openEditModal(m)}>Edit</Button>
                                          <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} onClick={() => setMediaToDelete(m)} iconDescription="Delete">Delete</Button>
                                        </div>
                                      )}
                                    </div>
                                    {narrowLayout && !veryNarrowLayout && (
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem", marginTop: "0.25rem", marginLeft: "-1rem" }}>
                                        <Button kind="ghost" size="sm" renderIcon={m.status === "published" ? ViewOff : View} onClick={() => togglePublish(m.id, m.status)} disabled={togglingPublish.has(m.id)} iconDescription={m.status === "published" ? "Unpublish" : "Publish"}>
                                          {togglingPublish.has(m.id) ? "…" : m.status === "published" ? "Unpublish" : "Publish"}
                                        </Button>
                                        <Button kind="ghost" size="sm" renderIcon={Renew} onClick={() => reprocessMedia(m.id)} disabled={reprocessing.has(m.id)} iconDescription="Reprocess">
                                          {reprocessing.has(m.id) ? "…" : "Reprocess"}
                                        </Button>
                                        <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit" onClick={() => openEditModal(m)}>Edit</Button>
                                        <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} onClick={() => setMediaToDelete(m)} iconDescription="Delete">Delete</Button>
                                      </div>
                                    )}
                                    {veryNarrowLayout && (
                                      <>
                                        <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.25rem", marginLeft: "-1rem" }}>
                                          <Button kind="ghost" size="sm" hasIconOnly renderIcon={m.status === "published" ? ViewOff : View} onClick={() => togglePublish(m.id, m.status)} disabled={togglingPublish.has(m.id)} iconDescription={m.status === "published" ? "Unpublish" : "Publish"} />
                                          <Button kind="ghost" size="sm" hasIconOnly renderIcon={Renew} onClick={() => reprocessMedia(m.id)} disabled={reprocessing.has(m.id)} iconDescription="Reprocess" />
                                          <Button kind="ghost" size="sm" hasIconOnly renderIcon={Edit} iconDescription="Edit" onClick={() => openEditModal(m)} />
                                          <Button kind="danger--ghost" size="sm" hasIconOnly renderIcon={TrashCan} onClick={() => setMediaToDelete(m)} iconDescription="Delete" />
                                        </div>
                                      </>
                                    )}
                                  </div>
                                )}
                              </TableCell>
                              <TableCell style={stackedLayout ? { display: "none" } : undefined}>
                                <Tag type={statusTagType(m.status)} size="sm">
                                  {m.status}
                                </Tag>
                                {m.processingStatus && m.processingStatus !== "completed" && (
                                  <Tag type={m.processingStatus === "failed" ? "red" : "outline"} size="sm" style={{ marginLeft: "0.25rem" }}>
                                    {m.processingStatus}
                                  </Tag>
                                )}
                              </TableCell>
                              <TableCell style={stackedLayout ? { display: "none" } : undefined}>
                                <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                                  <Button
                                    kind="ghost"
                                    size="sm"
                                    renderIcon={m.status === "published" ? ViewOff : View}
                                    onClick={() => togglePublish(m.id, m.status)}
                                    disabled={togglingPublish.has(m.id)}
                                    iconDescription={m.status === "published" ? "Unpublish" : "Publish"}
                                    hasIconOnly={iconOnlyActions}
                                  >
                                    {togglingPublish.has(m.id) ? "…" : m.status === "published" ? "Unpublish" : "Publish"}
                                  </Button>
                                  <Button
                                    kind="ghost"
                                    size="sm"
                                    renderIcon={Renew}
                                    onClick={() => reprocessMedia(m.id)}
                                    disabled={reprocessing.has(m.id)}
                                    iconDescription="Reprocess"
                                    title="Regenerate processed assets using the current output format"
                                    hasIconOnly={iconOnlyActions}
                                  >
                                    {reprocessing.has(m.id) ? "…" : "Reprocess"}
                                  </Button>
                                  <Button
                                    kind="ghost"
                                    size="sm"
                                    renderIcon={Edit}
                                    iconDescription="Edit"
                                    onClick={() => openEditModal(m)}
                                    hasIconOnly={iconOnlyActions}
                                  >
                                    Edit
                                  </Button>
                                  <Button
                                    kind="danger--ghost"
                                    size="sm"
                                    renderIcon={TrashCan}
                                    onClick={() => setMediaToDelete(m)}
                                    iconDescription="Delete"
                                    hasIconOnly={iconOnlyActions}
                                  >
                                    Delete
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </>
                );
              }}
            </DataTable>
          </div>
        )}

        <Pagination
          page={page}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={ITEMS_PER_PAGE}
          loading={loading}
          onPageChange={setPage}
        />

        {showBulkDeleteModal && (
          <Modal
            title="Delete Selected"
            onConfirm={() => bulkDelete(pendingBulkIds)}
            onCancel={() => { setShowBulkDeleteModal(false); setPendingBulkIds([]); }}
            confirmLabel={bulkDeleting ? "Deleting…" : `Delete ${pendingBulkIds.length} item${pendingBulkIds.length !== 1 ? "s" : ""}`}
            confirmDestructive
          >
            <p>
              Delete <strong>{pendingBulkIds.length}</strong> item{pendingBulkIds.length !== 1 ? "s" : ""}? This cannot be undone.
            </p>
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
            <p>
              Delete <strong>{mediaToDelete.title || mediaToDelete.file}</strong>? This cannot be undone.
            </p>
          </Modal>
        )}

        {mediaToEdit && (
          <Modal
            title="Edit Media"
            onConfirm={saveEdit}
            onCancel={() => setMediaToEdit(null)}
            confirmLabel={saving ? "Saving…" : "Save"}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", paddingTop: "0.5rem" }}>
              <TextInput
                id="edit-title"
                labelText="Title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
              <TextArea
                id="edit-description"
                labelText="Description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={3}
              />
              <TextInput
                id="edit-location"
                labelText="Location"
                value={editLocation}
                onChange={(e) => setEditLocation(e.target.value)}
                placeholder="e.g. Paris, France"
              />
            </div>
          </Modal>
        )}

        {hoveredItem && (() => {
          const isHeic = /\.heic$/i.test(hoveredItem.file);
          const derivedPreview = hoveredItem.displayUrl || hoveredItem.posterUrl || hoveredItem.thumbUrl || null;
          const previewSrc = derivedPreview
            ? `${pbUrl}${derivedPreview}`
            : hoveredItem.type === "image" && !isHeic
              ? pb.files.getURL(hoveredItem, hoveredItem.file, { thumb: "840x0" })
              : null;
          if (!previewSrc) return null;
          const PREVIEW_W = 420;
          const OFFSET_X = 18;
          const OFFSET_Y = 12;
          const x =
            hoverPos.x + OFFSET_X + PREVIEW_W > window.innerWidth
              ? hoverPos.x - OFFSET_X - PREVIEW_W
              : hoverPos.x + OFFSET_X;
          const y = Math.max(8, Math.min(hoverPos.y - OFFSET_Y, window.innerHeight - 320));
          return (
            <div className="library-hover-preview" style={{ left: x, top: y }}>
              <img src={previewSrc} alt="" />
            </div>
          );
        })()}
      </Column>
    </Grid>
  );
}
