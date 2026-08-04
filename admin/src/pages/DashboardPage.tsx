import { ReactNode, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { getDeviceStatus } from "../utils";
import { Notification } from "../components/Notification";
import { EmptyState } from "../components/EmptyState";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { useNotification } from "../hooks/useNotification";
import {
  Grid,
  Column,
  Heading,
  Tile,
  ClickableTile,
  Tag,
  Stack,
  StructuredListWrapper,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from "@carbon/react";
import { Image as ImageIcon, Video as VideoIcon } from "@carbon/icons-react";
import type { DeviceRecord, DeviceConfig } from "../types/pocketbase";

type MediaSummary = {
  id: string;
  title?: string;
  file: string;
  type: "image" | "video";
  created: string;
  expand?: {
    owner?: { id: string; email: string; name?: string };
  };
};

type ApprovalSummary = {
  id: string;
  status: "approved" | "rejected";
  reviewedAt?: string;
  expand?: {
    media?: { id: string; title?: string; file: string };
  };
};

type MediaStats = {
  total: number;
  images: number;
  videos: number;
  failedProcessing: number;
};

type BackupInfo = { name: string; timestamp: string | null };

type SystemStatus = {
  storageBytes: number | null;
  backups: BackupInfo[];
  software: { pocketbase?: string; ffmpeg?: string; exiftool?: string; hostOs?: string };
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function relativeTime(iso: string): string {
  const diffMin = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function uploaderLabel(m: MediaSummary): string {
  const owner = m.expand?.owner;
  if (!owner) return "—";
  return owner.name || owner.email;
}

function configSummary(cfg?: DeviceConfig): string {
  if (!cfg) return "default settings";
  const interval = cfg.interval ?? 8000;
  const transition = cfg.transition ?? "fade";
  const shuffle = cfg.shuffle ? "shuffle on" : "shuffle off";
  const mode = cfg.displayMode === "dynamic" ? "dynamic layout" : "single image";
  return `${Math.round(interval / 1000)}s · ${transition} · ${shuffle} · ${mode}`;
}

function StatTile({
  label,
  value,
  sublabel,
  to,
  warn,
}: {
  label: string;
  value: ReactNode;
  sublabel?: string;
  to?: string;
  warn?: boolean;
}) {
  const navigate = useNavigate();
  const inner = (
    <Stack gap={2}>
      <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
        {label}
      </span>
      <span
        style={{
          fontSize: "2rem",
          fontWeight: 600,
          lineHeight: 1.2,
          color: warn ? "var(--cds-support-error)" : "var(--cds-text-primary)",
        }}
      >
        {value}
      </span>
      {sublabel && (
        <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
          {sublabel}
        </span>
      )}
    </Stack>
  );
  if (!to) {
    return <Tile style={{ height: "100%" }}>{inner}</Tile>;
  }
  return (
    <ClickableTile
      href={to}
      onClick={(e: React.MouseEvent | React.KeyboardEvent) => {
        e.preventDefault();
        navigate(to);
      }}
      style={{ height: "100%" }}
    >
      {inner}
    </ClickableTile>
  );
}

function ChipStat({
  label,
  value,
  warn,
  to,
}: {
  label: string;
  value: number;
  warn?: boolean;
  to?: string;
}) {
  const navigate = useNavigate();
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: to ? "pointer" : undefined }}
      onClick={to ? () => navigate(to) : undefined}
      role={to ? "button" : undefined}
      tabIndex={to ? 0 : undefined}
    >
      <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
        {label}
      </span>
      {warn && value > 0 ? (
        <Tag type="red" size="sm">
          {value}
        </Tag>
      ) : (
        <span style={{ fontWeight: 600 }}>{value}</span>
      )}
    </div>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { error, showError } = useNotification();

  const [loading, setLoading] = useState(true);
  const [mediaStats, setMediaStats] = useState<MediaStats | null>(null);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [totalUsers, setTotalUsers] = useState(0);
  const [pendingPairings, setPendingPairings] = useState(0);
  const [recentMedia, setRecentMedia] = useState<MediaSummary[]>([]);
  const [recentApprovals, setRecentApprovals] = useState<ApprovalSummary[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  const load = useCallback(async () => {
    try {
      const [totalRes, imagesRes, videosRes, failedRes] = await Promise.all([
        pb.collection("media").getList(1, 1, { requestKey: null }),
        pb.collection("media").getList(1, 1, { filter: "type='image'", requestKey: null }),
        pb.collection("media").getList(1, 1, { filter: "type='video'", requestKey: null }),
        pb.collection("media").getList(1, 1, { filter: "processingStatus='failed'", requestKey: null }),
      ]);
      setMediaStats({
        total: totalRes.totalItems,
        images: imagesRes.totalItems,
        videos: videosRes.totalItems,
        failedProcessing: failedRes.totalItems,
      });

      if (isAdmin) {
        const [devicesRes, approvalsRes, usersRes, pendingRes, recentMediaRes, recentApprovalsRes, systemStatusRes] =
          await Promise.all([
            pb.collection("devices").getFullList<DeviceRecord>({ sort: "name", requestKey: null }),
            pb.collection("media").getList(1, 1, { filter: "status='pending'", requestKey: null }),
            pb.collection("users").getList(1, 1, { requestKey: null }),
            pb.send("/api/spomienka/pending", { method: "GET" }).catch(() => []),
            pb.collection("media").getList<MediaSummary>(1, 6, { sort: "-created", expand: "owner", requestKey: null }),
            pb.collection("approvals").getList<ApprovalSummary>(1, 6, {
              sort: "-reviewedAt",
              expand: "media",
              requestKey: null,
            }),
            pb.send("/api/spomienka/system-status", { method: "GET" }).catch(() => null),
          ]);
        setDevices(devicesRes);
        setPendingApprovals(approvalsRes.totalItems);
        setTotalUsers(usersRes.totalItems);
        setPendingPairings(Array.isArray(pendingRes) ? pendingRes.length : 0);
        setRecentMedia(recentMediaRes.items);
        setRecentApprovals(recentApprovalsRes.items);
        setSystemStatus(systemStatusRes);
      }
    } catch (err) {
      showError(err, "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

  const onlineCount = devices.filter((d) => getDeviceStatus(d.lastSeen).label === "Online").length;

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <Heading style={{ marginBottom: "1.5rem" }}>Dashboard</Heading>

        <Notification error={error} message={null} />

        {loading ? (
          <LoadingSpinner label="Loading dashboard..." />
        ) : (
          <Stack gap={6}>
            {/* Row 1: primary stat tiles */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <StatTile
                  label="Media Library"
                  value={mediaStats?.total ?? 0}
                  sublabel={`${mediaStats?.images ?? 0} images · ${mediaStats?.videos ?? 0} videos`}
                  to="/library"
                />
              </div>
              {isAdmin && (
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <StatTile
                    label="Viewers Online"
                    value={`${onlineCount} / ${devices.length}`}
                    to="/viewer-control"
                  />
                </div>
              )}
              {isAdmin && (
                <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                  <StatTile
                    label="Pending Approvals"
                    value={pendingApprovals}
                    warn={pendingApprovals > 0}
                    to="/approvals"
                  />
                </div>
              )}
            </div>

            {/* Row 2: chip strip */}
            {isAdmin && (
              <Tile>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem" }}>
                  <ChipStat label="Users" value={totalUsers} to="/users" />
                  <ChipStat
                    label="Failed processing"
                    value={mediaStats?.failedProcessing ?? 0}
                    warn
                    to="/library"
                  />
                  <ChipStat label="Pending device pairings" value={pendingPairings} to="/settings" />
                </div>
              </Tile>
            )}

            {/* Viewers panel */}
            {isAdmin && (
              <div>
                <p className="cds--productive-heading-02" style={{ marginBottom: "0.75rem" }}>
                  Viewers
                </p>
                {devices.length === 0 ? (
                  <EmptyState message="No devices configured yet." />
                ) : (
                  <StructuredListWrapper>
                    <StructuredListBody>
                      {devices.map((d) => {
                        const status = getDeviceStatus(d.lastSeen);
                        return (
                          <StructuredListRow key={d.id}>
                            <StructuredListCell>
                              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                <span style={{ color: status.color, fontSize: "0.6rem", lineHeight: 1 }}>●</span>
                                <strong>{d.name}</strong>
                              </div>
                            </StructuredListCell>
                            <StructuredListCell>
                              <span className="cds--helper-text-01" style={{ color: status.color }}>
                                {status.label}
                                {status.detail ? ` — ${status.detail}` : ""}
                              </span>
                            </StructuredListCell>
                            <StructuredListCell>
                              <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
                                {configSummary(d.config)}
                              </span>
                            </StructuredListCell>
                          </StructuredListRow>
                        );
                      })}
                    </StructuredListBody>
                  </StructuredListWrapper>
                )}
              </div>
            )}

            {/* System: storage, backups, software versions */}
            {isAdmin && systemStatus && (
              <div>
                <p className="cds--productive-heading-02" style={{ marginBottom: "0.75rem" }}>
                  System
                </p>
                <Tile>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "2rem",
                      paddingBottom: "1rem",
                      marginBottom: "0.5rem",
                      borderBottom: "1px solid var(--cds-border-subtle-01)",
                    }}
                  >
                    <div>
                      <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
                        Storage used
                      </span>
                      <div style={{ fontWeight: 600 }}>{formatBytes(systemStatus.storageBytes)}</div>
                    </div>
                    <div>
                      <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)" }}>
                        Backups
                      </span>
                      <div style={{ fontWeight: 600 }}>
                        {systemStatus.backups.length === 0
                          ? "Not configured"
                          : `${systemStatus.backups.length} kept · last ${relativeTime(systemStatus.backups[0].timestamp || "")}`}
                      </div>
                    </div>
                  </div>
                  {(
                    [
                      ["Admin SPA", import.meta.env.VITE_APP_VERSION || "—"],
                      ["PocketBase", systemStatus.software.pocketbase || "—"],
                      ["ffmpeg", systemStatus.software.ffmpeg || "—"],
                      ["exiftool", systemStatus.software.exiftool || "—"],
                      ["Backend host OS", systemStatus.software.hostOs || "—"],
                    ] as [string, string][]
                  ).map(([label, value], i, arr) => (
                    <div
                      key={label}
                      style={{
                        display: "flex",
                        gap: "2rem",
                        padding: "0.375rem 0",
                        borderBottom: i < arr.length - 1 ? "1px solid var(--cds-border-subtle-01)" : undefined,
                      }}
                    >
                      <span
                        className="cds--helper-text-01"
                        style={{ color: "var(--cds-text-secondary)", width: "9rem", flexShrink: 0 }}
                      >
                        {label}
                      </span>
                      <span>{value}</span>
                    </div>
                  ))}
                </Tile>
              </div>
            )}

            {/* Recent activity */}
            {isAdmin && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "2rem" }}>
                <div style={{ flex: "2 1 420px", minWidth: 0 }}>
                  <p className="cds--productive-heading-02" style={{ marginBottom: "0.75rem" }}>
                    Recent Uploads
                  </p>
                  {recentMedia.length === 0 ? (
                    <EmptyState message="No uploads yet." />
                  ) : (
                    <Stack gap={3}>
                      {recentMedia.map((m) => (
                        <div key={m.id} style={{ display: "flex", alignItems: "center", gap: "0.75rem", minWidth: 0 }}>
                          {m.type === "video" ? <VideoIcon size={16} /> : <ImageIcon size={16} />}
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.title || m.file}
                          </span>
                          <span
                            className="cds--helper-text-01"
                            style={{
                              color: "var(--cds-text-secondary)",
                              width: "9rem",
                              flexShrink: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {uploaderLabel(m)}
                          </span>
                          <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)", whiteSpace: "nowrap", flexShrink: 0 }}>
                            {relativeTime(m.created)}
                          </span>
                        </div>
                      ))}
                    </Stack>
                  )}
                </div>
                <div style={{ flex: "1 1 260px", minWidth: 0 }}>
                  <p className="cds--productive-heading-02" style={{ marginBottom: "0.75rem" }}>
                    Recent Approvals
                  </p>
                  {recentApprovals.length === 0 ? (
                    <EmptyState message="No approval activity yet." />
                  ) : (
                    <Stack gap={3}>
                      {recentApprovals.map((a) => (
                        <div key={a.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
                          <Tag type={a.status === "approved" ? "green" : "red"} size="sm">
                            {a.status}
                          </Tag>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.expand?.media?.title || a.expand?.media?.file || "Deleted item"}
                          </span>
                          <span className="cds--helper-text-01" style={{ color: "var(--cds-text-secondary)", whiteSpace: "nowrap", flexShrink: 0 }}>
                            {a.reviewedAt ? relativeTime(a.reviewedAt) : ""}
                          </span>
                        </div>
                      ))}
                    </Stack>
                  )}
                </div>
              </div>
            )}
          </Stack>
        )}
      </Column>
    </Grid>
  );
}
