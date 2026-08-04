export type DeviceStatus = { label: string; color: string; detail: string };

export function getDeviceStatus(lastSeen?: string): DeviceStatus {
  if (!lastSeen) return { label: "Never seen", color: "var(--cds-text-disabled)", detail: "" };
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffMin = diffMs / 60_000;

  let label: string;
  let color: string;
  if (diffMin < 3) {
    label = "Online";
    color = "var(--cds-support-success)";
  } else if (diffMin < 60) {
    label = "Recently online";
    color = "var(--cds-support-warning)";
  } else {
    label = "Offline";
    color = "var(--cds-support-error)";
  }

  let detail: string;
  if (diffMin < 1) {
    detail = "just now";
  } else if (diffMin < 60) {
    detail = `${Math.floor(diffMin)}m ago`;
  } else if (diffMin < 60 * 24) {
    detail = `${Math.floor(diffMin / 60)}h ago`;
  } else {
    detail = new Date(lastSeen).toLocaleDateString();
  }

  return { label, color, detail };
}

export function isDeviceOnline(lastSeen?: string): boolean {
  if (!lastSeen) return false;
  return Date.now() - new Date(lastSeen).getTime() < 3 * 60 * 1000;
}

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

const MIN_PASSWORD_LENGTH = 8;

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[a-zA-Z]/.test(password)) {
    return "Password must contain at least one letter";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number";
  }
  return null;
}
