interface NotificationProps {
  error: string | null;
  message: string | null;
}

export function Notification({ error, message }: NotificationProps) {
  return (
    <>
      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}
    </>
  );
}
