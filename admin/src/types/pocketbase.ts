/**
 * PocketBase Record Types
 *
 * These types match the schema defined in backend/pb_schema.json.
 * Keep them in sync when modifying the PocketBase collections.
 */

/**
 * Base record fields present on all PocketBase records
 */
export interface BaseRecord {
  id: string;
  created: string;
  updated: string;
  collectionId: string;
  collectionName: string;
}

/**
 * User roles
 */
export type UserRole = "user" | "admin";

/**
 * User record from the users collection
 */
export interface UserRecord extends BaseRecord {
  email: string;
  name?: string;
  role: UserRole;
  verified: boolean;
  emailVisibility: boolean;
}

/**
 * Media types
 */
export type MediaType = "image" | "video";

/**
 * Media status
 */
export type MediaStatus = "pending" | "published" | "rejected";

/**
 * Processing status for media
 */
export type ProcessingStatus = "pending" | "processing" | "completed" | "failed";

/**
 * Media record from the media collection
 */
export interface MediaRecord extends BaseRecord {
  file: string;
  type: MediaType;
  status: MediaStatus;
  title?: string;
  description?: string;
  location?: string;
  owner: string; // relation to users
  approvedBy?: string; // relation to users
  takenAt?: string;
  width?: number;
  height?: number;
  duration?: number;
  orientation?: string;
  tags?: string[];
  deviceScopes?: string[];
  checksum?: string;
  processingStatus?: ProcessingStatus;
  processingError?: string;
  displayUrl?: string;
  blurUrl?: string;
  thumbUrl?: string;
  videoUrl?: string;
  posterUrl?: string;
}

export type ApprovalStatus = "approved" | "rejected";

/**
 * Device configuration
 */
export interface DeviceConfig {
  interval?: number;
  transition?: "fade" | "crossfade" | "cut";
  transitionDuration?: number;
  blur?: boolean;
  shuffle?: boolean;
  showClock?: boolean;
}

/**
 * Device record from the devices collection
 */
export interface DeviceRecord extends BaseRecord {
  name: string;
  apiKey: string;
  lastSeen?: string;
  config?: DeviceConfig;
}

/**
 * Device inbox record — ephemeral command signals sent to viewer devices.
 */
export interface DeviceInboxRecord extends BaseRecord {
  device_id: string;
  type?: string;
  payload?: Record<string, unknown>;
}
