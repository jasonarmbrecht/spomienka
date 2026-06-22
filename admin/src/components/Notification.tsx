import { InlineNotification, ToastNotification } from "@carbon/react";

interface NotificationProps {
  error: string | null;
  message: string | null;
}

export function Notification({ error, message }: NotificationProps) {
  return (
    <>
      {error && (
        <InlineNotification
          kind="error"
          title={error}
          lowContrast
          hideCloseButton
        />
      )}
      {message && (
        <ToastNotification
          kind="success"
          title={message}
          timeout={5000}
          style={{ position: "fixed", top: "4rem", right: "1rem", zIndex: 9000 }}
        />
      )}
    </>
  );
}
