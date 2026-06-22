interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <p
      className="cds--label"
      style={{ padding: "2rem 0", textAlign: "center", color: "var(--cds-text-secondary)" }}
    >
      {message}
    </p>
  );
}
