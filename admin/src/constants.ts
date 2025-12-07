/**
 * Application Constants
 *
 * Centralized constants used across the application.
 * These should match the backend configuration in pb_schema.json.
 */

/**
 * Maximum file size for uploads in bytes (50MB)
 * Matches the maxSize in backend/pb_schema.json for the media collection
 */
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Maximum file size for uploads formatted as a string
 */
export const MAX_FILE_SIZE_DISPLAY = "50MB";

/**
 * Allowed image MIME types for upload
 */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/**
 * Allowed video MIME types for upload
 */
export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/x-msvideo",
] as const;

/**
 * All allowed media types
 */
export const ALLOWED_MEDIA_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES,
] as const;

/**
 * Default pagination settings
 */
export const PAGINATION = {
  /** Default page size */
  DEFAULT_PAGE_SIZE: 50,
  /** Maximum page size */
  MAX_PAGE_SIZE: 100,
  /** Page size for devices list */
  DEVICES_PAGE_SIZE: 100,
  /** Page size for users list */
  USERS_PAGE_SIZE: 100,
} as const;

/**
 * Default device configuration values
 */
export const DEFAULT_DEVICE_CONFIG = {
  /** Default slide interval in milliseconds */
  INTERVAL_MS: 8000,
  /** Default transition type */
  TRANSITION: "fade" as const,
  /** Minimum interval in milliseconds */
  MIN_INTERVAL_MS: 1000,
  /** Maximum interval in milliseconds */
  MAX_INTERVAL_MS: 300000, // 5 minutes
} as const;

/**
 * Available transition types
 */
export const TRANSITION_TYPES = ["fade", "crossfade", "cut"] as const;
export type TransitionType = typeof TRANSITION_TYPES[number];

/**
 * Password validation requirements
 */
export const PASSWORD_REQUIREMENTS = {
  /** Minimum password length */
  MIN_LENGTH: 8,
  /** Require at least one letter */
  REQUIRE_LETTER: true,
  /** Require at least one number */
  REQUIRE_NUMBER: true,
} as const;

/**
 * API endpoints (relative to PocketBase URL)
 */
export const API_ENDPOINTS = {
  AUTH: "/api/collections/users/auth-with-password",
  MEDIA: "/api/collections/media/records",
  APPROVALS: "/api/collections/approvals/records",
  DEVICES: "/api/collections/devices/records",
  USERS: "/api/collections/users/records",
  FILES: "/api/files",
} as const;

/**
 * Local storage keys
 */
export const STORAGE_KEYS = {
  AUTH_TOKEN: "pocketbase_auth",
} as const;

/**
 * UI timing constants
 */
export const UI_TIMING = {
  /** Success message display duration in milliseconds */
  SUCCESS_MESSAGE_DURATION: 3000,
  /** Upload progress cleanup delay in milliseconds */
  UPLOAD_CLEANUP_DELAY: 2000,
  /** Debounce delay for search inputs in milliseconds */
  SEARCH_DEBOUNCE: 300,
} as const;

