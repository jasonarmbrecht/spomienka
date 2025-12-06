import { useState } from "react";
import { pb } from "../pb/client";

export function SettingsPage() {
  const [interval, setInterval] = useState(8000);
  const [transition, setTransition] = useState("fade");
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    // Persist in devices collection or a settings collection; using devices[0] as placeholder.
    await pb.collection("devices").update("default", {
      config: { interval, transition }
    });
    setMessage("Saved (update device record as needed)");
  };

  return (
    <section>
      <h1>Settings</h1>
      <label>
        Interval (ms)
        <input type="number" value={interval} onChange={(e) => setInterval(Number(e.target.value))} />
      </label>
      <label>
        Transition
        <select value={transition} onChange={(e) => setTransition(e.target.value)}>
          <option value="fade">Fade</option>
          <option value="crossfade">Crossfade</option>
          <option value="cut">Cut</option>
        </select>
      </label>
      <button onClick={save}>Save</button>
      {message && <p>{message}</p>}
    </section>
  );
}

