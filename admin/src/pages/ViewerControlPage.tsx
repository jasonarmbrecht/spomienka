import { useEffect, useRef, useState } from "react";
import { pb } from "../pb/client";
import {
  Grid,
  Column,
  Heading,
  Button,
  Select,
  SelectItem,
  Tag,
  TextInput,
  InlineNotification,
  Tile,
} from "@carbon/react";
import {
  PauseFilled,
  PlayFilled,
  PreviousFilled,
  NextFilled,
  Shuffle,
  Filter,
  FilterRemove,
} from "@carbon/icons-react";
import type { DeviceRecord } from "../types/pocketbase";
import { isDeviceOnline } from "../utils";

const PAUSE_SECS = 300; // 5 minutes

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ViewerControlPage() {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  // Pause countdown
  const [pauseSecs, setPauseSecs] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tag filter
  const [tagInput, setTagInput] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [filterMode, setFilterMode] = useState<"whitelist" | "blacklist">("whitelist");
  const [filterApplied, setFilterApplied] = useState(false);

  // Load devices
  useEffect(() => {
    const load = async () => {
      try {
        const list = await pb.collection("devices").getFullList<DeviceRecord>({
          sort: "name",
          requestKey: null,
        });
        setDevices(list);
        if (list.length > 0) setSelectedId(list[0].id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("autocancelled")) {
          console.debug("Device poll autocancelled (safe to ignore)");
        } else {
          setError(msg || "Failed to load devices");
        }
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Clear tag filter on unmount if applied
  useEffect(() => {
    return () => {
      if (filterApplied && selectedId) {
        pb.collection("device_inbox")
          .create({ device_id: selectedId, type: "tag-filter-clear" }, { requestKey: null })
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterApplied, selectedId]);

  const sendCommand = async (type: string, payload?: Record<string, unknown>) => {
    if (!selectedId) return;
    setSending(type);
    setError(null);
    try {
      await pb.collection("device_inbox").create(
        { device_id: selectedId, type, payload },
        { requestKey: null },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send command");
    } finally {
      setSending(null);
    }
  };

  const handlePause = async () => {
    await sendCommand("pause", { secs: PAUSE_SECS });
    // Start local countdown
    let secs = PAUSE_SECS;
    setPauseSecs(secs);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      secs -= 1;
      if (secs <= 0) {
        clearInterval(countdownRef.current!);
        countdownRef.current = null;
        setPauseSecs(null);
      } else {
        setPauseSecs(secs);
      }
    }, 1000);
  };

  const handleResume = async () => {
    await sendCommand("resume");
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setPauseSecs(null);
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !selectedTags.includes(tag)) {
      setSelectedTags((prev) => [...prev, tag]);
    }
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  };

  const applyTagFilter = async () => {
    await sendCommand("tag-filter", { tags: selectedTags, mode: filterMode });
    setFilterApplied(true);
  };

  const clearTagFilter = async () => {
    await sendCommand("tag-filter-clear");
    setFilterApplied(false);
    setSelectedTags([]);
  };

  const selectedDevice = devices.find((d) => d.id === selectedId);
  const online = selectedDevice ? isDeviceOnline(selectedDevice.lastSeen) : false;
  const isPaused = pauseSecs !== null;

  return (
    <Grid>
      <Column sm={4} md={8} lg={8}>
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          <Heading>Viewer Control</Heading>

          {error && (
            <InlineNotification
              kind="error"
              title="Error"
              subtitle={error}
              onClose={() => setError(null)}
              lowContrast
            />
          )}

          {/* Device selector */}
          <Tile>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <Select
                id="device-select"
                labelText="Device"
                value={selectedId}
                onChange={(e) => {
                  setSelectedId(e.target.value);
                  setPauseSecs(null);
                  setFilterApplied(false);
                  setSelectedTags([]);
                }}
                disabled={loading}
              >
                {devices.map((d) => (
                  <SelectItem key={d.id} value={d.id} text={d.name} />
                ))}
                {devices.length === 0 && (
                  <SelectItem value="" text={loading ? "Loading…" : "No devices"} />
                )}
              </Select>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span
                  style={{
                    color: online ? "var(--cds-support-success)" : "var(--cds-text-disabled)",
                    fontSize: "0.75rem",
                  }}
                >
                  ●
                </span>
                <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
                  {online ? "Online" : "Offline"}
                  {selectedDevice?.lastSeen && !online
                    ? ` · last seen ${new Date(selectedDevice.lastSeen).toLocaleString()}`
                    : ""}
                </span>
              </div>
            </div>
          </Tile>

          {/* Playback controls */}
          <Tile>
            <Heading style={{ fontSize: "1rem", marginBottom: "1rem" }}>Playback</Heading>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {isPaused ? (
                <Button
                  kind="primary"
                  renderIcon={PlayFilled}
                  style={{ minHeight: 64, width: "100%" }}
                  onClick={handleResume}
                  disabled={!selectedId || sending === "resume"}
                >
                  {sending === "resume"
                    ? "Resuming…"
                    : `Resume (${formatCountdown(pauseSecs!)} remaining)`}
                </Button>
              ) : (
                <Button
                  kind="secondary"
                  renderIcon={PauseFilled}
                  style={{ minHeight: 64, width: "100%" }}
                  onClick={handlePause}
                  disabled={!selectedId || sending === "pause"}
                >
                  {sending === "pause" ? "Pausing…" : "Pause (5 min)"}
                </Button>
              )}
              <Button
                kind="tertiary"
                renderIcon={PreviousFilled}
                style={{ minHeight: 64, width: "100%" }}
                onClick={() => sendCommand("prev")}
                disabled={!selectedId || sending === "prev"}
              >
                {sending === "prev" ? "…" : "Previous"}
              </Button>
              <Button
                kind="tertiary"
                renderIcon={NextFilled}
                style={{ minHeight: 64, width: "100%" }}
                onClick={() => sendCommand("next")}
                disabled={!selectedId || sending === "next"}
              >
                {sending === "next" ? "…" : "Next"}
              </Button>
              <Button
                kind="tertiary"
                renderIcon={Shuffle}
                style={{ minHeight: 64, width: "100%" }}
                onClick={() => sendCommand("random")}
                disabled={!selectedId || sending === "random"}
              >
                {sending === "random" ? "Jumping…" : "Random"}
              </Button>
            </div>
          </Tile>

          {/* Tag filter */}
          <Tile>
            <Heading style={{ fontSize: "1rem", marginBottom: "1rem" }}>Tag Filter</Heading>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                <Button
                  kind={filterMode === "whitelist" ? "primary" : "ghost"}
                  size="sm"
                  style={{ justifyContent: "center" }}
                  onClick={() => setFilterMode("whitelist")}
                >
                  Whitelist
                </Button>
                <Button
                  kind={filterMode === "blacklist" ? "primary" : "ghost"}
                  size="sm"
                  style={{ justifyContent: "center" }}
                  onClick={() => setFilterMode("blacklist")}
                >
                  Blacklist
                </Button>
              </div>
              <p className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
                {filterMode === "whitelist"
                  ? "Only show images with any of the selected tags."
                  : "Hide images with any of the selected tags."}
              </p>

              <div style={{ display: "flex", gap: "0.5rem" }}>
                <TextInput
                  id="tag-input"
                  labelText="Add tag"
                  hideLabel
                  placeholder="Enter a tag and press Add"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addTag();
                  }}
                  style={{ flex: 1 }}
                />
                <Button kind="secondary" size="md" onClick={addTag} style={{ minHeight: 48 }}>
                  Add
                </Button>
              </div>

              {selectedTags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {selectedTags.map((tag) => (
                    <Tag
                      key={tag}
                      type="blue"
                      filter
                      onClose={() => removeTag(tag)}
                    >
                      {tag}
                    </Tag>
                  ))}
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
                <Button
                  kind="primary"
                  renderIcon={Filter}
                  style={{ minHeight: 64, width: "100%" }}
                  onClick={applyTagFilter}
                  disabled={!selectedId || selectedTags.length === 0 || sending === "tag-filter"}
                >
                  {sending === "tag-filter" ? "Applying…" : "Apply Filter"}
                </Button>
                <Button
                  kind="danger--ghost"
                  renderIcon={FilterRemove}
                  style={{ minHeight: 64, width: "100%" }}
                  onClick={clearTagFilter}
                  disabled={!selectedId || !filterApplied || sending === "tag-filter-clear"}
                >
                  {sending === "tag-filter-clear" ? "Clearing…" : "Clear Filter"}
                </Button>
              </div>

              {filterApplied && (
                <InlineNotification
                  kind="info"
                  title="Filter active"
                  subtitle={`${filterMode === "whitelist" ? "Showing only" : "Hiding"} images tagged: ${selectedTags.join(", ")}. Filter will clear when you leave this page.`}
                  lowContrast
                  hideCloseButton
                />
              )}
            </div>
          </Tile>
        </div>
      </Column>
    </Grid>
  );
}
