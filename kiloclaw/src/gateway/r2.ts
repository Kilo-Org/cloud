import type { Sandbox } from '@cloudflare/sandbox';
import type { KiloClawEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

/**
 * Derive a deterministic, URL-safe R2 prefix from a userId.
 *
 * Uses SHA-256 hash (base64url, no padding) to avoid issues with special
 * characters in userIds (e.g. @, /, :). The hash is non-reversible -- the
 * KiloClawInstance DO stores the original userId for admin lookup.
 *
 * The prefix starts with '/' as required by the sandbox SDK's mountBucket.
 *
 * Example: "user_abc123" -> "/users/2Kf8a..." (44 chars)
 */
export async function userR2Prefix(userId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `/users/${b64}`;
}

/**
 * Mount R2 bucket for persistent storage with per-user prefix isolation.
 *
 * Always mounts with a per-user prefix derived from userId. The SDK handles
 * idempotency -- if already mounted with the same config, it's a no-op.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @param userId - User ID for per-user prefix derivation
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(
  sandbox: Sandbox,
  env: KiloClawEnv,
  userId: string
): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      'R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)'
    );
    return false;
  }

  const bucketName = getR2BucketName(env);
  const prefix = await userR2Prefix(userId);

  try {
    console.log('Mounting R2 bucket', bucketName, 'at', R2_MOUNT_PATH, 'prefix:', prefix);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      prefix,
    });
    console.log('R2 bucket mounted successfully');
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.log('R2 mount error:', errorMessage);

    // Don't fail if mounting fails - gateway can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}
