import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error boundary component that catches JavaScript errors in child components.
 * Displays a fallback UI instead of crashing the entire application.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
            background: "var(--color-bg)",
            color: "var(--color-text)",
          }}
        >
          <h1 style={{ marginBottom: "1rem", color: "var(--color-error)" }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: "1rem", color: "var(--color-text-muted)" }}>
            An unexpected error occurred. Please try refreshing the page.
          </p>
          {this.state.error && (
            <details
              style={{
                marginBottom: "1.5rem",
                padding: "1rem",
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                maxWidth: "600px",
                width: "100%",
              }}
            >
              <summary
                style={{ cursor: "pointer", color: "var(--color-text-muted)" }}
              >
                Error Details
              </summary>
              <pre
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.8125rem",
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {this.state.error.message}
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>
          )}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={this.handleReset}
              style={{
                background: "var(--color-primary)",
                color: "white",
                border: "none",
                padding: "0.625rem 1.25rem",
                borderRadius: "var(--radius)",
                cursor: "pointer",
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "var(--color-surface)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border)",
                padding: "0.625rem 1.25rem",
                borderRadius: "var(--radius)",
                cursor: "pointer",
              }}
            >
              Refresh Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

