import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
} from '../schemas/image-version';
import type { ImageVersionEntry, ImageVariant } from '../schemas/image-version';

/**
 * Read `image-version:latest:<variant>` from KV.
 * Returns the full parsed ImageVersionEntry or null (single KV read).
 * Callers destructure what they need.
 */
export async function resolveLatestVersion(
  kv: KVNamespace,
  variant: ImageVariant
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
 * Register a version in KV if the latest entry doesn't already match.
 * Writes both the versioned key and the latest pointer. Idempotent —
 * safe to call on every request (no-ops if already current).
 *
 * imageDigest is optional — the worker knows its tag but not its digest.
 */
export async function registerVersionIfNeeded(
  kv: KVNamespace,
  openclawVersion: string,
  variant: ImageVariant,
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
