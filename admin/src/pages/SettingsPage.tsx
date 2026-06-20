import { useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { SecureApiKeyDisplay } from "../components/SecureApiKeyDisplay";
import { Modal } from "../components/Modal";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { Notification } from "../components/Notification";
import { PAGINATION } from "../constants";
import { generateApiKey } from "../utils";
import { useNotification } from "../hooks/useNotification";

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

  const isDirty =
    (cfg.interval ?? 8000) !== slideInterval ||
    (cfg.transition ?? "fade") !== transition ||
    (cfg.transitionDuration ?? 1000) !== transitionDuration ||
    (cfg.blur ?? true) !== blur ||
    (cfg.shuffle ?? false) !== shuffle ||
    (cfg.showClock ?? true) !== showClock;

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(device.name);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRegenModal, setShowRegenModal] = useState(false);

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
    <div className="device-card">
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

      <div className="device-card-header">
        {editing ? (
          <div className="device-action-row">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveEditName(); if (e.key === "Escape") setEditing(false); }}
              autoFocus
            />
            <button onClick={saveEditName} className="btn btn-sm">Save</button>
            <button onClick={() => { setEditing(false); setEditName(device.name); }} className="btn btn-secondary btn-sm">Cancel</button>
          </div>
        ) : (
          <div className="device-card-title-row">
            <h2 className="device-card-name">{device.name}</h2>
            <button onClick={() => { setEditing(true); setEditName(device.name); }} className="btn btn-secondary btn-sm">
              Rename
            </button>
          </div>
        )}
        {device.lastSeen && (
          <p className="device-card-lastseen">Last seen: {new Date(device.lastSeen).toLocaleString()}</p>
        )}
      </div>

      <div className="device-card-body">
        <h3>Slideshow Settings</h3>
        <label>
          Display Duration (ms)
          <input
            type="number"
            value={slideInterval}
            onChange={(e) => { setSlideInterval(Number(e.target.value)); setSaveSuccess(false); }}
            min={1000}
            step={1000}
          />
        </label>
        <label>
          Transition Effect
          <select value={transition} onChange={(e) => { setTransition(e.target.value); setSaveSuccess(false); }}>
            <option value="fade">Fade</option>
            <option value="crossfade">Crossfade</option>
            <option value="cut">Cut</option>
          </select>
        </label>
        <label>
          Transition Duration (ms)
          <input
            type="number"
            value={transitionDuration}
            onChange={(e) => { setTransitionDuration(Number(e.target.value)); setSaveSuccess(false); }}
            min={100}
            step={100}
          />
        </label>
        <label className="label-checkbox">
          <input type="checkbox" checked={blur} onChange={(e) => { setBlur(e.target.checked); setSaveSuccess(false); }} />
          Background Blur
        </label>
        <label className="label-checkbox">
          <input type="checkbox" checked={shuffle} onChange={(e) => { setShuffle(e.target.checked); setSaveSuccess(false); }} />
          Shuffle Playlist
        </label>
        <label className="label-checkbox">
          <input type="checkbox" checked={showClock} onChange={(e) => { setShowClock(e.target.checked); setSaveSuccess(false); }} />
          Clock
        </label>
        {saveSuccess && <p className="save-success-msg">Settings saved — viewer will restart shortly.</p>}
        <button onClick={saveConfig} className="btn" disabled={!isDirty}>Save Settings</button>
      </div>

      <div className="device-card-footer">
        <button onClick={() => setShowRegenModal(true)} className="btn btn-warning btn-sm">
          Regenerate Key
        </button>
        <button onClick={() => setShowDeleteModal(true)} className="btn btn-danger btn-sm">
          Delete
        </button>
      </div>
    </div>
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

  const loadDevices = async (_preferredId?: string) => {
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

  void user;

  if (loading) {
    return (
      <section>
        <h1>Settings</h1>
        <LoadingSpinner label="Loading devices..." />
      </section>
    );
  }

  return (
    <section>
      <div className="section-header">
        <h1>Settings</h1>
        <button onClick={() => setShowAddDeviceModal(true)}>
          Add Device Manually
        </button>
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
          <p style={{ marginBottom: "1rem" }}>Enter the 6-digit PIN shown on the viewer screen.</p>
          {registerError && <p className="error" style={{ marginBottom: "0.75rem" }}>{registerError}</p>}
          <label style={{ display: "block", marginBottom: "0.75rem" }}>
            Device Name
            <input
              type="text"
              value={registerName}
              onChange={(e) => setRegisterName(e.target.value)}
              placeholder="e.g., Living Room Frame"
              autoFocus
            />
          </label>
          <label style={{ display: "block" }}>
            PIN (shown on viewer screen)
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={registerPin}
              onChange={(e) => setRegisterPin(e.target.value.replace(/\D/g, "").substring(0, 6))}
              placeholder="123456"
              style={{ fontFamily: "monospace", fontSize: "1.5rem", letterSpacing: "0.25em", maxWidth: "160px" }}
            />
          </label>
        </Modal>
      )}

      {showAddDeviceModal && (
        <Modal
          title="Add Device"
          onConfirm={createDevice}
          onCancel={() => { setShowAddDeviceModal(false); setNewDeviceName(""); setError(null); }}
          confirmLabel="Add Device"
        >
          <label>
            Device Name
            <input
              type="text"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              placeholder="e.g., Bedroom Frame"
              autoFocus
            />
          </label>
        </Modal>
      )}

      {pendingDevices.length > 0 && (
        <div className="discovered-viewers">
          <h2>Discovered Viewers</h2>
          <p style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
            These viewers are waiting to be connected. Enter the PIN shown on each screen.
          </p>
          <ul>
            {pendingDevices.map((p) => (
              <li key={p.session_id}>
                <div style={{ flex: 1 }}>
                  <strong>{p.hostname}</strong>
                  <span style={{ color: "var(--color-text-muted)", marginLeft: "0.5rem", fontSize: "0.875rem" }}>{p.ip}</span>
                </div>
                <div>
                  <button onClick={() => openRegisterModal(p)} className="btn btn-sm">Connect</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {devices.length === 0 ? (
        <div className="create-device">
          <h2>No Devices Found</h2>
          <p>Run the viewer app to discover it automatically, then connect it from the Discovered Viewers area.</p>
        </div>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              onRefresh={loadDevices}
              showMessage={showMessage}
              showError={showError}
              onNewApiKey={setNewApiKey}
            />
          ))}
        </div>
      )}
    </section>
  );
}
