import { useState } from "react";

type SecureApiKeyDisplayProps = {
  apiKey: string;
  onClose: () => void;
};

export function SecureApiKeyDisplay({ apiKey, onClose }: SecureApiKeyDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div style={{
      background: "var(--color-surface)",
      border: "1px solid var(--color-border)",
      borderRadius: "var(--radius)",
      padding: "1rem",
      marginTop: "1rem",
    }}>
      <p style={{ color: "var(--color-warning)", marginBottom: "0.75rem", fontWeight: 500 }}>
        ⚠️ Save this API key now. It will not be shown again.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.75rem" }}>
        <input
          type={revealed ? "text" : "password"}
          value={apiKey}
          readOnly
          style={{
            flex: 1,
            padding: "0.625rem 0.875rem",
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius)",
            color: "var(--color-text)",
            fontFamily: "monospace",
            fontSize: "0.875rem",
          }}
        />
        <button
          onClick={() => setRevealed(!revealed)}
          style={{
            padding: "0.625rem 1rem",
            background: "var(--color-border)",
            border: "none",
            borderRadius: "var(--radius)",
            color: "var(--color-text)",
            cursor: "pointer",
          }}
        >
          {revealed ? "Hide" : "Show"}
        </button>
        <button
          onClick={copyToClipboard}
          style={{
            padding: "0.625rem 1rem",
            background: copied ? "var(--color-success)" : "var(--color-primary)",
            border: "none",
            borderRadius: "var(--radius)",
            color: "white",
            cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <button
        onClick={onClose}
        style={{
          padding: "0.5rem 1rem",
          background: "transparent",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius)",
          color: "var(--color-text)",
          cursor: "pointer",
        }}
      >
        Close
      </button>
    </div>
  );
}

