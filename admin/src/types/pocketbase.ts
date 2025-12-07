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

/**
 * Approval status
 */
export type ApprovalStatus = "approved" | "rejected";

/**
 * Approval record from the approvals collection
 */
export interface ApprovalRecord extends BaseRecord {
  media: string; // relation to media
  reviewer: string; // relation to users
  status: ApprovalStatus;
  notes?: string;
  reviewedAt?: string;
}

/**
 * Device configuration
 */
export interface DeviceConfig {
  interval?: number;
  transition?: "fade" | "crossfade" | "cut";
  shuffle?: boolean;
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
 * Plugin manifest structure
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  entrypoint: string;
  configSchema?: Record<string, unknown>;
}

/**
 * Plugin record from the plugins collection
 */
export interface PluginRecord extends BaseRecord {
  manifest: PluginManifest;
  checksum?: string;
  enabled: boolean;
}

/**
 * Type guard to check if a record is a media record
 */
export function isMediaRecord(record: BaseRecord): record is MediaRecord {
  return record.collectionName === "media";
}

/**
 * Type guard to check if a record is a user record
 */
export function isUserRecord(record: BaseRecord): record is UserRecord {
  return record.collectionName === "users";
}

/**
 * Type guard to check if a record is a device record
 */
export function isDeviceRecord(record: BaseRecord): record is DeviceRecord {
  return record.collectionName === "devices";
}

