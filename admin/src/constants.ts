export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export const MAX_FILE_SIZE_DISPLAY = "50MB";

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/x-msvideo",
] as const;

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
  DEVICES_PAGE_SIZE: 100,
  USERS_PAGE_SIZE: 100,
} as const;

