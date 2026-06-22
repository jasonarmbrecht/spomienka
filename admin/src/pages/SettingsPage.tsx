import { useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { SecureApiKeyDisplay } from "../components/SecureApiKeyDisplay";
import { Modal } from "../components/Modal";
import { Notification } from "../components/Notification";
import { PAGINATION } from "../constants";
import { generateApiKey } from "../utils";
import { useNotification } from "../hooks/useNotification";
import {
  Grid,
  Column,
  Heading,
  Button,
  Tile,
  NumberInput,
  Select,
  SelectItem,
  Toggle,
  TextInput,
  InlineNotification,
  InlineLoading,
  Stack,
  StructuredListWrapper,
  StructuredListRow,
  StructuredListCell,
  StructuredListBody,
} from "@carbon/react";
import { Edit, Renew, TrashCan, Link as LinkIcon } from "@carbon/icons-react";

function getViewerStatus(lastSeen?: string): { label: string; color: string; detail: string } {
  if (!lastSeen) return { label: "Never seen", color: "var(--cds-text-disabled)", detail: "" };
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffMin = diffMs / 60_000;

  let label: string;
  let color: string;
  if (diffMin < 3) {
    label = "Online";
    color = "var(--cds-support-success)";
  } else if (diffMin < 60) {
    label = "Recently online";
    color = "var(--cds-support-warning)";
  } else {
    label = "Offline";
    color = "var(--cds-support-error)";
  }

  let detail: string;
  if (diffMin < 1) {
    detail = "just now";
  } else if (diffMin < 60) {
    detail = `${Math.floor(diffMin)}m ago`;
  } else if (diffMin < 60 * 24) {
    detail = `${Math.floor(diffMin / 60)}h ago`;
  } else {
    detail = new Date(lastSeen).toLocaleDateString();
  }

  return { label, color, detail };
}

function DeviceStatus({ lastSeen }: { lastSeen?: string }) {
  const { label, color, detail } = getViewerStatus(lastSeen);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
      <span style={{ color, fontSize: "0.6rem", lineHeight: 1 }}>●</span>
      <span className="cds--helper-text-01" style={{ color }}>
        {label}
      </span>
      {detail && (
        <span className="cds--helper-text-01" style={{ color: "var(--cds-text-disabled)" }}>
          — {detail}
        </span>
      )}
    </div>
  );
}

type Device = {
  id: string;
  name: string;
  apiKey: string;
  lastSeen?: string;
  config?: {
    interval?: number;
    transition?: string;
    transitionDuration?: number;
    blur?: boolean;
    shuffle?: boolean;
    showClock?: boolean;
  };
};

type PendingDevice = {
  session_id: string;
  hostname: string;
  ip: string;
  created: string;
};

type DeviceCardProps = {
  device: Device;
  onRefresh: (preferredId?: string) => void;
  showMessage: (msg: string) => void;
  showError: (err: unknown, fallback: string) => void;
  onNewApiKey: (key: string) => void;
};

function DeviceCard({ device, onRefresh, showMessage, showError, onNewApiKey }: DeviceCardProps) {
  const cfg = device.config ?? {};
  const [slideInterval, setSlideInterval] = useState(cfg.interval ?? 8000);
  const [transition, setTransition] = useState(cfg.transition ?? "fade");
  const [transitionDuration, setTransitionDuration] = useState(cfg.transitionDuration ?? 1000);
  const [blur, setBlur] = useState(cfg.blur ?? true);
  const [shuffle, setShuffle] = useState(cfg.shuffle ?? false);
  const [showClock, setShowClock] = useState(cfg.showClock ?? true);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(device.name);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRegenModal, setShowRegenModal] = useState(false);

  const isDirty =
    (cfg.interval ?? 8000) !== slideInterval ||
    (cfg.transition ?? "fade") !== transition ||
    (cfg.transitionDuration ?? 1000) !== transitionDuration ||
    (cfg.blur ?? true) !== blur ||
    (cfg.shuffle ?? false) !== shuffle ||
    (cfg.showClock ?? true) !== showClock;

  const saveConfig = async () => {
    try {
      const newConfig = { interval: slideInterval, transition, transitionDuration, blur, shuffle, showClock };
      await pb.collection("devices").update(device.id, { config: newConfig });
      try {
        await pb.collection("device_inbox").create({ device_id: device.id, type: "config_reload" });
      } catch {
        // non-fatal — viewer will pick up changes on next poll
      }
      setSaveSuccess(true);
      showMessage("Settings saved — viewer will restart shortly.");
      onRefresh(device.id);
    } catch (err) {
      showError(err, "Failed to save settings");
    }
  };

  const saveEditName = async () => {
    if (!editName.trim()) return;
    try {
      await pb.collection("devices").update(device.id, { name: editName.trim() });
      setEditing(false);
      showMessage("Device name updated");
      onRefresh(device.id);
    } catch (err) {
      showError(err, "Failed to update device name");
    }
  };

  const regenerateApiKey = async () => {
    try {
      const newKey = generateApiKey();
      await pb.collection("devices").update(device.id, { apiKey: newKey });
      setShowRegenModal(false);
      onNewApiKey(newKey);
      showMessage("API key regenerated successfully");
      onRefresh(device.id);
    } catch (err) {
      showError(err, "Failed to regenerate API key");
    }
  };

  const deleteDevice = async () => {
    try {
      await pb.collection("devices").delete(device.id);
      setShowDeleteModal(false);
      showMessage("Device deleted successfully");
      onRefresh();
    } catch (err) {
      showError(err, "Failed to delete device");
    }
  };

  return (
    <Tile style={{ height: "100%" }}>
      {showRegenModal && (
        <Modal
          title="Regenerate API Key"
          onConfirm={regenerateApiKey}
          onCancel={() => setShowRegenModal(false)}
          confirmLabel="Regenerate"
          confirmDestructive
        >
          <p>The old API key will stop working immediately. The device will need to be reconfigured with the new key.</p>
        </Modal>
      )}
      {showDeleteModal && (
        <Modal
          title="Confirm Deletion"
          onConfirm={deleteDevice}
          onCancel={() => setShowDeleteModal(false)}
          confirmLabel="Delete"
          confirmDestructive
        >
          <p>Are you sure you want to delete this device? This action cannot be undone.</p>
        </Modal>
      )}

      <Stack gap={5}>
        {/* Header */}
        <div>
          {editing ? (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
              <TextInput
                id={`rename-${device.id}`}
                labelText="Device name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveEditName();
                  if (e.key === "Escape") { setEditing(false); setEditName(device.name); }
                }}
                autoFocus
                size="sm"
              />
              <Button size="sm" onClick={saveEditName}>Save</Button>
              <Button kind="secondary" size="sm" onClick={() => { setEditing(false); setEditName(device.name); }}>Cancel</Button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <p className="cds--productive-heading-03">{device.name}</p>
              <Button kind="ghost" size="sm" renderIcon={Edit} iconDescription="Rename" onClick={() => { setEditing(true); setEditName(device.name); }}>
                Rename
              </Button>
            </div>
          )}
          <DeviceStatus lastSeen={device.lastSeen} />
        </div>

        {/* Slideshow Settings */}
        <div>
          <p className="cds--productive-heading-01" style={{ marginBottom: "1rem" }}>Slideshow Settings</p>
          <Stack gap={4}>
            <NumberInput
              id={`interval-${device.id}`}
              label="Display Duration (ms)"
              value={slideInterval}
              min={1000}
              step={1000}
              onChange={(_e, { value }) => { setSlideInterval(Number(value)); setSaveSuccess(false); }}
              size="sm"
            />
            <Select
              id={`transition-${device.id}`}
              labelText="Transition Effect"
              value={transition}
              onChange={(e) => { setTransition(e.target.value); setSaveSuccess(false); }}
              size="sm"
            >
              <SelectItem value="fade" text="Fade" />
              <SelectItem value="crossfade" text="Crossfade" />
              <SelectItem value="cut" text="Cut" />
            </Select>
            <NumberInput
              id={`transition-duration-${device.id}`}
              label="Transition Duration (ms)"
              value={transitionDuration}
              min={100}
              step={100}
              onChange={(_e, { value }) => { setTransitionDuration(Number(value)); setSaveSuccess(false); }}
              size="sm"
            />
            <Toggle
              id={`blur-${device.id}`}
              labelText="Background Blur"
              toggled={blur}
              onToggle={(val) => { setBlur(val); setSaveSuccess(false); }}
              size="sm"
            />
            <Toggle
              id={`shuffle-${device.id}`}
              labelText="Shuffle Playlist"
              toggled={shuffle}
              onToggle={(val) => { setShuffle(val); setSaveSuccess(false); }}
              size="sm"
            />
            <Toggle
              id={`clock-${device.id}`}
              labelText="Clock"
              toggled={showClock}
              onToggle={(val) => { setShowClock(val); setSaveSuccess(false); }}
              size="sm"
            />
          </Stack>
          {saveSuccess && (
            <InlineNotification
              kind="success"
              title="Settings saved — viewer will restart shortly."
              hideCloseButton
              lowContrast
              style={{ marginTop: "1rem" }}
            />
          )}
          <Button
            kind="primary"
            size="sm"
            onClick={saveConfig}
            disabled={!isDirty}
            style={{ marginTop: "1rem" }}
          >
            Save Settings
          </Button>
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={() => setShowRegenModal(true)}>
            Regenerate Key
          </Button>
          <Button kind="danger" size="sm" renderIcon={TrashCan} onClick={() => setShowDeleteModal(true)}>
            Delete
          </Button>
        </div>
      </Stack>
    </Tile>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const { error, message, setError, clear, showError, showMessage } = useNotification();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [showAddDeviceModal, setShowAddDeviceModal] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState("");
  const [pendingDevices, setPendingDevices] = useState<PendingDevice[]>([]);
  const [registeringSession, setRegisteringSession] = useState<PendingDevice | null>(null);
  const [registerName, setRegisterName] = useState("");
  const [registerPin, setRegisterPin] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);

  void user;

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await pb.send("/api/spomienka/pending", { method: "GET" });
        setPendingDevices(Array.isArray(res) ? res : []);
      } catch {
        // Silently ignore — backend may not have discovery routes yet
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pb.collection("devices").getList<Device>(1, PAGINATION.DEVICES_PAGE_SIZE, {
        sort: "name",
        requestKey: null,
      });
      setDevices(res.items);
    } catch (err) {
      showError(err, "Failed to load devices");
    } finally {
      setLoading(false);
    }
  };

  const openRegisterModal = (pending: PendingDevice) => {
    setRegisteringSession(pending);
    setRegisterName("");
    setRegisterPin("");
    setRegisterError(null);
  };

  const registerPendingDevice = async () => {
    if (!registeringSession) return;
    if (!registerName.trim()) { setRegisterError("Device name is required"); return; }
    if (!/^\d{6}$/.test(registerPin)) { setRegisterError("PIN must be exactly 6 digits"); return; }
    setRegisterError(null);
    try {
      await pb.send("/api/spomienka/register", {
        method: "POST",
        body: JSON.stringify({ session_id: registeringSession.session_id, name: registerName.trim(), pin: registerPin }),
        headers: { "Content-Type": "application/json" },
      });
      setRegisteringSession(null);
      setPendingDevices((prev) => prev.filter((p) => p.session_id !== registeringSession.session_id));
      showMessage(`Viewer "${registerName.trim()}" registered successfully! It will restart automatically.`);
      await loadDevices();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "Registration failed — check the PIN");
    }
  };

  const createDevice = async () => {
    if (!newDeviceName.trim()) { setError("Device name is required"); return; }
    clear();
    try {
      const apiKey = generateApiKey();
      const device = await pb.collection("devices").create<Device>({
        name: newDeviceName.trim(),
        apiKey,
        config: { interval: 8000, transition: "fade", transitionDuration: 1000, blur: true, shuffle: false, showClock: true },
      });
      setDevices((prev) => [...prev, device]);
      setNewDeviceName("");
      setShowAddDeviceModal(false);
      setNewApiKey(apiKey);
      showMessage(`Device "${device.name}" created successfully.`);
    } catch (err) {
      showError(err, "Failed to create device");
    }
  };

  return (
    <Grid>
      <Column sm={4} md={8} lg={16}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
          <Heading>Settings</Heading>
          <Button kind="primary" onClick={() => setShowAddDeviceModal(true)}>
            Add Device Manually
          </Button>
        </div>

        <Notification error={error} message={message} />

        {newApiKey && (
          <SecureApiKeyDisplay apiKey={newApiKey} onClose={() => setNewApiKey(null)} />
        )}

        {registeringSession && (
          <Modal
            title={`Connect "${registeringSession.hostname}" (${registeringSession.ip})`}
            onConfirm={registerPendingDevice}
            onCancel={() => setRegisteringSession(null)}
            confirmLabel="Connect"
          >
            <Stack gap={5}>
              <p>Enter the 6-digit PIN shown on the viewer screen.</p>
              {registerError && (
                <InlineNotification kind="error" title={registerError} lowContrast hideCloseButton />
              )}
              <TextInput
                id="register-name"
                labelText="Device Name"
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
                placeholder="e.g., Living Room Frame"
                autoFocus
              />
              <TextInput
                id="register-pin"
                labelText="PIN (shown on viewer screen)"
                value={registerPin}
                onChange={(e) => setRegisterPin(e.target.value.replace(/\D/g, "").substring(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                maxLength={6}
              />
            </Stack>
          </Modal>
        )}

        {showAddDeviceModal && (
          <Modal
            title="Add Device"
            onConfirm={createDevice}
            onCancel={() => { setShowAddDeviceModal(false); setNewDeviceName(""); setError(null); }}
            confirmLabel="Add Device"
          >
            <TextInput
              id="new-device-name"
              labelText="Device Name"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              placeholder="e.g., Bedroom Frame"
              autoFocus
            />
          </Modal>
        )}

        {pendingDevices.length > 0 && (
          <div style={{ marginBottom: "2rem" }}>
            <p className="cds--productive-heading-02" style={{ marginBottom: "0.5rem" }}>Discovered Viewers</p>
            <p className="cds--helper-text-01" style={{ marginBottom: "1rem" }}>
              These viewers are waiting to be connected. Enter the PIN shown on each screen.
            </p>
            <StructuredListWrapper>
              <StructuredListBody>
                {pendingDevices.map((p) => (
                  <StructuredListRow key={p.session_id}>
                    <StructuredListCell>
                      <strong>{p.hostname}</strong>
                      <span className="cds--helper-text-01" style={{ marginLeft: "0.5rem" }}>{p.ip}</span>
                    </StructuredListCell>
                    <StructuredListCell>
                      <Button kind="primary" size="sm" renderIcon={LinkIcon} onClick={() => openRegisterModal(p)}>
                        Connect
                      </Button>
                    </StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          </div>
        )}

        {loading ? (
          <InlineLoading description="Loading devices..." />
        ) : devices.length === 0 ? (
          <div style={{ padding: "2rem 0" }}>
            <p className="cds--productive-heading-02" style={{ marginBottom: "0.5rem" }}>No Devices Found</p>
            <p className="cds--body-01">
              Run the viewer app to discover it automatically, then connect it from the Discovered Viewers area.
            </p>
          </div>
        ) : (
          <Grid narrow>
            {devices.map((device) => (
              <Column key={device.id} sm={4} md={4} lg={8} style={{ marginBottom: "1rem" }}>
                <DeviceCard
                  device={device}
                  onRefresh={loadDevices}
                  showMessage={showMessage}
                  showError={showError}
                  onNewApiKey={setNewApiKey}
                />
              </Column>
            ))}
          </Grid>
        )}
      </Column>
    </Grid>
  );
}
