import { Tile, CodeSnippet, Button } from "@carbon/react";
import { InlineNotification } from "@carbon/react";

type SecureApiKeyDisplayProps = {
  apiKey: string;
  onClose: () => void;
};

export function SecureApiKeyDisplay({ apiKey, onClose }: SecureApiKeyDisplayProps) {
  return (
    <Tile style={{ marginBottom: "1rem" }}>
      <InlineNotification
        kind="warning"
        title="Save this API key now — it will not be shown again."
        hideCloseButton
        lowContrast
        style={{ marginBottom: "1rem" }}
      />
      <p style={{ marginBottom: "0.5rem", color: "var(--cds-text-secondary)", fontSize: "0.875rem" }}>
        API Key
      </p>
      <CodeSnippet type="single" feedback="Copied!" style={{ marginBottom: "1rem" }}>
        {apiKey}
      </CodeSnippet>
      <Button kind="secondary" size="sm" onClick={onClose}>
        Close
      </Button>
    </Tile>
  );
}
