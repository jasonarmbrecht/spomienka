import { useState } from "react";

export function useNotification() {
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const clear = () => {
    setError(null);
    setMessage(null);
  };

  const showError = (err: unknown, fallback: string) =>
    setError(err instanceof Error ? err.message : fallback);

  const showMessage = (msg: string) => setMessage(msg);

  return { error, message, setError, setMessage, clear, showError, showMessage };
}
