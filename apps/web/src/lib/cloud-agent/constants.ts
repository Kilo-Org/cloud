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

export const CLOUD_AGENT_IMAGE_MAX_COUNT = 5;
export const CLOUD_AGENT_IMAGE_MAX_ORIGINAL_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const CLOUD_AGENT_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const CLOUD_AGENT_IMAGE_MAX_DIMENSION_PX = 1536;

export const CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS = 900; // 15 min

/**
 * Maximum prompt length (in characters) accepted by the cloud agent.
 *
 * Mirrors the server-side cap in `services/cloud-agent-next/src/schema.ts`
 * (`Limits.MAX_PROMPT_LENGTH`). Prompts exceeding this would be rejected by
 * the worker, so we enforce the same limit client-side to give users
 * immediate feedback.
 */
export const CLOUD_AGENT_PROMPT_MAX_LENGTH = 100_000;
