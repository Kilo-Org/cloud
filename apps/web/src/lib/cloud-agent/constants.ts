/**
 * Image upload constraints for Cloud Agent messages
 */
export const CLOUD_AGENT_IMAGE_ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type CloudAgentImageAllowedType = (typeof CLOUD_AGENT_IMAGE_ALLOWED_TYPES)[number];

export const CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION: Record<CloudAgentImageAllowedType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min
