import { Loading, InlineLoading } from "@carbon/react";

interface LoadingSpinnerProps {
  label?: string;
  inline?: boolean;
}

export function LoadingSpinner({ label = "Loading...", inline = false }: LoadingSpinnerProps) {
  if (inline) {
    return <InlineLoading description={label} />;
  }
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2rem 0" }}>
      <Loading description={label} withOverlay={false} small />
    </div>
  );
}
