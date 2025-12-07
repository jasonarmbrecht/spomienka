import { useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";
import { SecureApiKeyDisplay } from "../components/SecureApiKeyDisplay";

type Device = {
  id: string;
  name: string;
  apiKey: string;
  lastSeen?: string;
  config?: {
    interval?: number;
    transition?: string;
  };
};

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // 128 bits
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function SettingsPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editDeviceName, setEditDeviceName] = useState("");
  const [deviceToDelete, setDeviceToDelete] = useState<string | null>(null);

  // Form state
  const [newDeviceName, setNewDeviceName] = useState("");
  const [interval, setInterval] = useState(8000);
  const [transition, setTransition] = useState("fade");

  // Load devices on mount
  useEffect(() => {
    loadDevices();
  }, []);

  // Load config when device is selected
  useEffect(() => {
    if (selectedDeviceId) {
      const device = devices.find((d) => d.id === selectedDeviceId);
      if (device?.config) {
        setInterval(device.config.interval ?? 8000);
        setTransition(device.config.transition ?? "fade");
      }
    }
  }, [selectedDeviceId, devices]);

  const loadDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await pb.collection("devices").getList<Device>(1, 100, {
        sort: "name",
      });
      setDevices(res.items);
      // Auto-select first device if available
      if (res.items.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(res.items[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    } finally {
      setLoading(false);
    }
  };

  const createDevice = async () => {
    if (!newDeviceName.trim()) {
      setError("Device name is required");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const apiKey = generateApiKey();
      const device = await pb.collection("devices").create<Device>({
        name: newDeviceName.trim(),
        apiKey,
        config: { interval, transition },
      });
      setDevices([...devices, device]);
      setSelectedDeviceId(device.id);
      setNewDeviceName("");
      setNewApiKey(apiKey);
      setMessage(`Device "${device.name}" created successfully.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create device");
    }
  };

  const saveConfig = async () => {
    if (!selectedDeviceId) {
      setError("No device selected");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await pb.collection("devices").update(selectedDeviceId, {
        config: { interval, transition },
      });
      // Update local state
      setDevices(
        devices.map((d) =>
          d.id === selectedDeviceId ? { ...d, config: { interval, transition } } : d
        )
      );
      setMessage("Settings saved successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
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
      await pb.collection("devices").update(deviceId, {
        name: editDeviceName.trim(),
      });
      await loadDevices();
      setEditingDeviceId(null);
      setEditDeviceName("");
      setMessage("Device name updated successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update device name");
    }
  };

  const regenerateApiKey = async (deviceId: string) => {
    if (!confirm("Are you sure you want to regenerate the API key? The old key will no longer work.")) {
      return;
    }
    setError(null);
    try {
      const newKey = generateApiKey();
      await pb.collection("devices").update(deviceId, {
        apiKey: newKey,
      });
      await loadDevices();
      // Find the device and show the new key
      const device = devices.find((d) => d.id === deviceId);
      if (device) {
        setNewApiKey(newKey);
        setMessage("API key regenerated successfully");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate API key");
    }
  };

  const deleteDevice = async (deviceId: string) => {
    if (!confirm("Are you sure you want to delete this device? This action cannot be undone.")) {
      return;
    }
    setError(null);
    try {
      await pb.collection("devices").delete(deviceId);
      await loadDevices();
      if (selectedDeviceId === deviceId) {
        setSelectedDeviceId(null);
      }
      setDeviceToDelete(null);
      setMessage("Device deleted successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete device");
    }
  };

  if (loading) {
    return (
      <section>
        <h1>Settings</h1>
        <p>Loading devices...</p>
      </section>
    );
  }

  return (
    <section>
      <h1>Settings</h1>

      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
      {newApiKey && (
        <SecureApiKeyDisplay
          apiKey={newApiKey}
          onClose={() => setNewApiKey(null)}
        />
      )}

      {devices.length === 0 ? (
        <div className="create-device">
          <h2>No Devices Found</h2>
          <p>Create your first device to configure settings.</p>
          <label>
            Device Name
            <input
              type="text"
              value={newDeviceName}
              onChange={(e) => setNewDeviceName(e.target.value)}
              placeholder="e.g., Living Room Frame"
            />
          </label>
          <button onClick={createDevice}>Create Device</button>
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

          <div className="device-list" style={{ marginBottom: "1.5rem" }}>
            <h2>Devices</h2>
            <ul>
              {devices.map((device) => (
                <li key={device.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.75rem" }}>
                  <div style={{ flex: 1 }}>
                    {editingDeviceId === device.id ? (
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <input
                          type="text"
                          value={editDeviceName}
                          onChange={(e) => setEditDeviceName(e.target.value)}
                          style={{ flex: 1, maxWidth: "300px" }}
                        />
                        <button onClick={() => saveEditDevice(device.id)} style={{ padding: "0.375rem 0.75rem" }}>
                          Save
                        </button>
                        <button onClick={cancelEditDevice} style={{ padding: "0.375rem 0.75rem", background: "var(--color-border)" }}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <strong>{device.name}</strong>
                        {device.lastSeen && (
                          <span style={{ color: "var(--color-text-muted)", marginLeft: "0.5rem", fontSize: "0.875rem" }}>
                            Last seen: {new Date(device.lastSeen).toLocaleString()}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {editingDeviceId !== device.id && (
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        onClick={() => startEditDevice(device)}
                        style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem" }}
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => regenerateApiKey(device.id)}
                        style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem", background: "var(--color-warning)" }}
                      >
                        Regenerate Key
                      </button>
                      <button
                        onClick={() => setDeviceToDelete(device.id)}
                        style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem", background: "var(--color-error)" }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {deviceToDelete && (
            <div style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}>
              <div style={{
                background: "var(--color-surface)",
                padding: "1.5rem",
                borderRadius: "var(--radius)",
                border: "1px solid var(--color-border)",
                maxWidth: "400px",
              }}>
                <h3 style={{ marginBottom: "1rem" }}>Confirm Deletion</h3>
                <p style={{ marginBottom: "1rem" }}>
                  Are you sure you want to delete this device? This action cannot be undone.
                </p>
                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                  <button onClick={() => setDeviceToDelete(null)}>Cancel</button>
                  <button
                    onClick={() => deleteDevice(deviceToDelete)}
                    style={{ background: "var(--color-error)" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="device-config">
            <h2>Device Configuration</h2>
            <label>
              Interval (ms)
              <input
                type="number"
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
                min={1000}
                step={1000}
              />
            </label>
            <label>
              Transition
              <select value={transition} onChange={(e) => setTransition(e.target.value)}>
                <option value="fade">Fade</option>
                <option value="crossfade">Crossfade</option>
                <option value="cut">Cut</option>
              </select>
            </label>
            <button onClick={saveConfig}>Save Settings</button>
          </div>

          <div className="add-device">
            <h3>Add Another Device</h3>
            <label>
              Device Name
              <input
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="e.g., Bedroom Frame"
              />
            </label>
            <button onClick={createDevice}>Add Device</button>
          </div>
        </>
      )}
    </section>
  );
}
