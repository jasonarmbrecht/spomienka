import { useEffect, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";

type Device = {
  id: string;
  name: string;
  apiKey: string;
  config?: {
    interval?: number;
    transition?: string;
  };
};

function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export function SettingsPage() {
  const { user } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage(`Device "${device.name}" created. API Key: ${apiKey}`);
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
