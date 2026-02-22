import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
} from '../schemas/image-version';
import type { ImageVersionEntry } from '../schemas/image-version';

/**
 * Read `image-version:latest:<variant>` from KV.
 * Returns the full parsed ImageVersionEntry or null (single KV read).
 * Callers destructure what they need.
 */
export async function resolveLatestVersion(
  kv: KVNamespace,
  variant: string
): Promise<ImageVersionEntry | null> {
  const raw = await kv.get(imageVersionLatestKey(variant), 'json');
  if (!raw) return null;

  const parsed = ImageVersionEntrySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[image-version] Invalid latest entry in KV:', parsed.error.flatten());
    return null;
  }

  return parsed.data;
}

/**
 * Look up the image tag for a specific OpenClaw version + variant from KV.
 * Returns the image tag, or null if the version is not registered.
 */
export async function lookupImageTag(
  kv: KVNamespace,
  version: string,
  variant: string
): Promise<string | null> {
  const raw = await kv.get(imageVersionKey(version, variant), 'json');
  if (!raw) return null;

  const parsed = ImageVersionEntrySchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      '[image-version] Invalid version entry in KV for',
      version,
      variant,
      parsed.error.flatten()
    );
    return null;
  }

  return parsed.data.imageTag;
}

/**
 * Register a version in KV if the latest entry doesn't already match.
 * Writes both the versioned key and the latest pointer. Idempotent —
 * safe to call on every request (no-ops if already current).
 *
 * imageDigest is optional — the worker knows its tag but not its digest.
 */
export async function registerVersionIfNeeded(
  kv: KVNamespace,
  openclawVersion: string,
  variant: string,
  imageTag: string,
  imageDigest: string | null = null
): Promise<boolean> {
  // Check if latest already matches — avoid unnecessary writes
  const existing = await kv.get(imageVersionLatestKey(variant), 'json');
  if (existing) {
    const parsed = ImageVersionEntrySchema.safeParse(existing);
    if (
      parsed.success &&
      parsed.data.openclawVersion === openclawVersion &&
      parsed.data.imageTag === imageTag
    ) {
      return false; // already current
    }
  }

  const entry: ImageVersionEntry = {
    openclawVersion,
    variant,
    imageTag,
    imageDigest,
    publishedAt: new Date().toISOString(),
  };

  const serialized = JSON.stringify(entry);
  await Promise.all([
    kv.put(imageVersionKey(openclawVersion, variant), serialized),
    kv.put(imageVersionLatestKey(variant), serialized),
  ]);

  console.log('[image-version] Registered version:', openclawVersion, variant, '→', imageTag);
  return true;
}
