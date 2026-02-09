/**
 * Configuration constants for KiloClaw
 */

/** Port that the OpenClaw gateway listens on inside the container */
export const OPENCLAW_PORT = 18789;

/** Maximum time to wait for the gateway to start (3 minutes) */
export const STARTUP_TIMEOUT_MS = 180_000;

/** Mount path for R2 persistent storage inside the container */
export const R2_MOUNT_PATH = '/data/openclaw';

/**
 * R2 bucket name for persistent storage.
 * Can be overridden via R2_BUCKET_NAME env var for test isolation.
 */
export function getR2BucketName(env?: { R2_BUCKET_NAME?: string }): string {
  return env?.R2_BUCKET_NAME || 'kiloclaw-data';
}
