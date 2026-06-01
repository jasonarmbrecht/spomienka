interface LoadingSpinnerProps {
  label?: string;
}

export function LoadingSpinner({ label = "Loading..." }: LoadingSpinnerProps) {
  return (
    <div className="loading-spinner-wrap" role="status" aria-label={label}>
      <div className="loading-spinner" />
      <span>{label}</span>
    </div>
  );
}
