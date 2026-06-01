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

export function SettingsPage() {
  const { user } = useAuth();
  const { error, message, setError, clear, showError, showMessage } = useNotification();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editDeviceName, setEditDeviceName] = useState("");
  const [deviceToDelete, setDeviceToDelete] = useState<string | null>(null);
  const [deviceToRegenKey, setDeviceToRegenKey] = useState<string | null>(null);
  const [showAddDeviceModal, setShowAddDeviceModal] = useState(false);

  const [pendingDevices, setPendingDevices] = useState<PendingDevice[]>([]);
  const [registeringSession, setRegisteringSession] = useState<PendingDevice | null>(null);
  const [registerName, setRegisterName] = useState("");
  const [registerPin, setRegisterPin] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);

  const [newDeviceName, setNewDeviceName] = useState("");
  const [slideInterval, setSlideInterval] = useState(8000);
  const [transition, setTransition] = useState("fade");
  const [transitionDuration, setTransitionDuration] = useState(1000);
  const [blur, setBlur] = useState(true);
  const [shuffle, setShuffle] = useState(false);
  const [showClock, setShowClock] = useState(true);

  useEffect(() => {
    loadDevices();
  }, []);

  // Poll for unregistered viewers every 5 seconds
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

  useEffect(() => {
    if (selectedDeviceId) {
      const device = devices.find((d) => d.id === selectedDeviceId);
      if (device?.config) {
        setSlideInterval(device.config.interval ?? 8000);
        setTransition(device.config.transition ?? "fade");
        setTransitionDuration(device.config.transitionDuration ?? 1000);
        setBlur(device.config.blur ?? true);
        setShuffle(device.config.shuffle ?? false);
        setShowClock(device.config.showClock ?? true);
      }
    }
  }, [selectedDeviceId, devices]);

  const loadDevices = async (preferredSelectedId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await pb.collection("devices").getList<Device>(1, PAGINATION.DEVICES_PAGE_SIZE, {
        sort: "name",
        requestKey: null,
      });
      setDevices(res.items);
      if (res.items.length === 0) {
        setSelectedDeviceId(null);
        return;
      }

      const nextSelectedId = preferredSelectedId ?? selectedDeviceId;
      if (!nextSelectedId || !res.items.some((d) => d.id === nextSelectedId)) {
        setSelectedDeviceId(res.items[0].id);
      }
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
    if (!registerName.trim()) {
      setRegisterError("Device name is required");
      return;
    }
    if (!/^\d{6}$/.test(registerPin)) {
      setRegisterError("PIN must be exactly 6 digits");
      return;
    }
    setRegisterError(null);
    try {
      await pb.send("/api/spomienka/register", {
        method: "POST",
        body: JSON.stringify({
          session_id: registeringSession.session_id,
          name: registerName.trim(),
          pin: registerPin,
        }),
        headers: { "Content-Type": "application/json" },
      });
      setRegisteringSession(null);
      setPendingDevices((prev) =>
        prev.filter((p) => p.session_id !== registeringSession.session_id)
      );
      showMessage(`Viewer "${registerName.trim()}" registered successfully! It will restart automatically.`);
      await loadDevices();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "Registration failed — check the PIN");
    }
  };

  const createDevice = async () => {
    if (!newDeviceName.trim()) {
      setError("Device name is required");
      return;
    }
    clear();
    try {
      const apiKey = generateApiKey();
      const device = await pb.collection("devices").create<Device>({
        name: newDeviceName.trim(),
        apiKey,
        config: {
          interval: slideInterval,
          transition,
          transitionDuration,
          blur,
          shuffle,
          showClock,
        },
      });
      setDevices([...devices, device]);
      setSelectedDeviceId(device.id);
      setNewDeviceName("");
      setShowAddDeviceModal(false);
      setNewApiKey(apiKey);
      showMessage(`Device "${device.name}" created successfully.`);
    } catch (err) {
      showError(err, "Failed to create device");
    }
  };

  const saveConfig = async () => {
    if (!selectedDeviceId) {
      setError("No device selected");
      return;
    }
    clear();
    try {
      const newConfig = {
        interval: slideInterval,
        transition,
        transitionDuration,
        blur,
        shuffle,
        showClock,
      };
      await pb.collection("devices").update(selectedDeviceId, { config: newConfig });
      setDevices(
        devices.map((d) =>
          d.id === selectedDeviceId ? { ...d, config: newConfig } : d
        )
      );
      showMessage("Settings saved successfully");
    } catch (err) {
      showError(err, "Failed to save settings");
    }
  };

  const startEditDevice = (device: Device) => {
    setEditingDeviceId(device.id);
    setEditDeviceName(device.name);
  };

  const cancelEditDevice = () => {
    setEditingDeviceId(null);
    setEditDeviceName("");
  };

  const saveEditDevice = async (deviceId: string) => {
    if (!editDeviceName.trim()) {
      setError("Device name is required");
      return;
    }
    setError(null);
    try {
      await pb.collection("devices").update(deviceId, { name: editDeviceName.trim() });
      await loadDevices(deviceId);
      setEditingDeviceId(null);
      setEditDeviceName("");
      showMessage("Device name updated successfully");
    } catch (err) {
      showError(err, "Failed to update device name");
    }
  };

  const regenerateApiKey = async (deviceId: string) => {
    setError(null);
    try {
      const newKey = generateApiKey();
      await pb.collection("devices").update(deviceId, { apiKey: newKey });
      await loadDevices(deviceId);
      setDeviceToRegenKey(null);
      setNewApiKey(newKey);
      showMessage("API key regenerated successfully");
    } catch (err) {
      showError(err, "Failed to regenerate API key");
    }
  };

  const deleteDevice = async (deviceId: string) => {
    setError(null);
    try {
      await pb.collection("devices").delete(deviceId);
      await loadDevices();
      setDeviceToDelete(null);
      showMessage("Device deleted successfully");
    } catch (err) {
      showError(err, "Failed to delete device");
    }
  };

  if (loading) {
    return (
      <section>
        <h1>Settings</h1>
        <LoadingSpinner label="Loading devices..." />
      </section>
    );
  }

  // suppress unused var warning for user — auth context available but not directly used here
  void user;
  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) ?? null;

  return (
    <section>
      <div className="section-header">
        <h1>Settings</h1>
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
          <p style={{ marginBottom: "1rem" }}>
            Enter the 6-digit PIN shown on the viewer screen.
          </p>
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
          onCancel={() => {
            setShowAddDeviceModal(false);
            setNewDeviceName("");
            setError(null);
          }}
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
                  <span style={{ color: "var(--color-text-muted)", marginLeft: "0.5rem", fontSize: "0.875rem" }}>
                    {p.ip}
                  </span>
                </div>
                <div>
                  <button onClick={() => openRegisterModal(p)} className="btn btn-sm">
                    Connect
                  </button>
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
          <details className="advanced-device-actions">
            <summary>Advanced</summary>
            <p>Manually create a device record and API key when automatic discovery is not available.</p>
            <button onClick={() => setShowAddDeviceModal(true)} className="btn btn-secondary btn-sm">
              Add Device Manually
            </button>
          </details>
        </div>
      ) : (
        <>
          <div className="device-selector">
            <label>
              Select Device
              <select
                value={selectedDeviceId ?? ""}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
              >
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {deviceToRegenKey && (
            <Modal
              title="Regenerate API Key"
              onConfirm={() => regenerateApiKey(deviceToRegenKey)}
              onCancel={() => setDeviceToRegenKey(null)}
              confirmLabel="Regenerate"
              confirmDestructive
            >
              <p>The old API key will stop working immediately. The device will need to be reconfigured with the new key.</p>
            </Modal>
          )}

          {deviceToDelete && (
            <Modal
              title="Confirm Deletion"
              onConfirm={() => deleteDevice(deviceToDelete)}
              onCancel={() => setDeviceToDelete(null)}
              confirmLabel="Delete"
              confirmDestructive
            >
              <p>Are you sure you want to delete this device? This action cannot be undone.</p>
            </Modal>
          )}

          <div className="device-config">
            <h2>Slideshow Settings</h2>
            <label>
              Display Duration (ms)
              <input
                type="number"
                value={slideInterval}
                onChange={(e) => setSlideInterval(Number(e.target.value))}
                min={1000}
                step={1000}
              />
            </label>
            <label>
              Transition Effect
              <select value={transition} onChange={(e) => setTransition(e.target.value)}>
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
                onChange={(e) => setTransitionDuration(Number(e.target.value))}
                min={100}
                step={100}
              />
            </label>
            <label className="label-checkbox">
              <input
                type="checkbox"
                checked={blur}
                onChange={(e) => setBlur(e.target.checked)}
              />
              Background Blur
            </label>
            <label className="label-checkbox">
              <input
                type="checkbox"
                checked={shuffle}
                onChange={(e) => setShuffle(e.target.checked)}
              />
              Shuffle Playlist
            </label>
            <label className="label-checkbox">
              <input
                type="checkbox"
                checked={showClock}
                onChange={(e) => setShowClock(e.target.checked)}
              />
              Clock
            </label>
            <button onClick={saveConfig}>Save Settings</button>
          </div>

          {selectedDevice && (
            <div className="device-actions">
              <h2>Device Actions</h2>
              {selectedDevice.lastSeen && (
                <p>Last seen: {new Date(selectedDevice.lastSeen).toLocaleString()}</p>
              )}

              {editingDeviceId === selectedDevice.id ? (
                <div className="device-action-row">
                  <input
                    type="text"
                    value={editDeviceName}
                    onChange={(e) => setEditDeviceName(e.target.value)}
                  />
                  <button onClick={() => saveEditDevice(selectedDevice.id)} className="btn btn-sm">
                    Save
                  </button>
                  <button onClick={cancelEditDevice} className="btn btn-secondary btn-sm">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="device-action-row">
                  <button onClick={() => startEditDevice(selectedDevice)} className="btn btn-sm">
                    Rename
                  </button>
                  <button
                    onClick={() => setDeviceToRegenKey(selectedDevice.id)}
                    className="btn btn-warning btn-sm"
                  >
                    Regenerate Key
                  </button>
                  <button
                    onClick={() => setDeviceToDelete(selectedDevice.id)}
                    className="btn btn-danger btn-sm"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}

          <details className="advanced-device-actions">
            <summary>Advanced</summary>
            <p>Manually create a device record and API key when automatic discovery is not available.</p>
            <button onClick={() => setShowAddDeviceModal(true)} className="btn btn-secondary btn-sm">
              Add Device Manually
            </button>
          </details>
        </>
      )}
    </section>
  );
}
