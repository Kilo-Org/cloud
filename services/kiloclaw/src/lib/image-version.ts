import {
  ImageVersionEntrySchema,
  imageVersionKey,
  imageVersionLatestKey,
  IMAGE_VERSION_INDEX_KEY,
} from '../schemas/image-version';
import type { ImageVersionEntry, ImageVariant } from '../schemas/image-version';
import { upsertCatalogVersion } from './catalog-registration';

/**
 * KV key for direct tag-to-entry lookup.
 * Enables O(1) resolution of pinned image tags during provision.
 */
function imageVersionTagKey(imageTag: string): string {
  return `image-version-tag:${imageTag}`;
}

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
 * Register a version in KV and Postgres catalog if not already current.
 *
 * - Checks KV latest pointer first — no-ops if version+tag already match.
 * - KV: writes versioned key + latest pointer.
 * - Postgres: upserts to kiloclaw_image_catalog via Hyperdrive (best-effort).
 * - KV tag index: maintained for enumeration.
 *
 * Called via ctx.waitUntil() on every request; KV check ensures writes
 * only happen on the first request after a deploy with a new version.
 */
export async function registerVersionIfNeeded(
  kv: KVNamespace,
  openclawVersion: string,
  variant: ImageVariant,
  imageTag: string,
  imageDigest: string | null = null,
  hyperdriveConnectionString?: string
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
      return false; // Already current in KV — nothing to do
    }
  }

  const publishedAt = new Date().toISOString();
  const entry: ImageVersionEntry = {
    openclawVersion,
    variant,
    imageTag,
    imageDigest,
    publishedAt,
  };

  // Write to KV: versioned key + latest pointer + tag lookup key
  const serialized = JSON.stringify(entry);
  await Promise.all([
    kv.put(imageVersionKey(openclawVersion, variant), serialized),
    kv.put(imageVersionLatestKey(variant), serialized),
    kv.put(imageVersionTagKey(imageTag), serialized),
  ]);

  // Maintain KV tag index (best-effort)
  await updateTagIndex(kv, imageTag);

  // Upsert to Postgres catalog (best-effort)
  if (hyperdriveConnectionString) {
    try {
      await upsertCatalogVersion(hyperdriveConnectionString, {
        openclawVersion,
        variant,
        imageTag,
        imageDigest,
        publishedAt,
      });
    } catch (e) {
      console.error(
        '[image-version] Failed to write catalog entry to Postgres:',
        e instanceof Error ? e.message : e
      );
    }
  }

  console.log('[image-version] Registered version:', openclawVersion, variant, '→', imageTag);
  return true;
}

// ---------------------------------------------------------------------------
// KV Tag Index
// ---------------------------------------------------------------------------

/**
 * Add a tag to the KV index if not already present.
 */
export async function updateTagIndex(kv: KVNamespace, imageTag: string): Promise<void> {
  try {
    const index = await getOrRebuildIndex(kv);
    if (!index.includes(imageTag)) {
      index.push(imageTag);
      await kv.put(IMAGE_VERSION_INDEX_KEY, JSON.stringify(index));
    }
  } catch (e) {
    console.warn('[image-version] Failed to update tag index:', e instanceof Error ? e.message : e);
  }
}

/**
 * Read the tag index from KV. If it's missing or corrupted, rebuild it
 * by listing all versioned KV keys.
 */
async function getOrRebuildIndex(kv: KVNamespace): Promise<string[]> {
  try {
    const raw = await kv.get(IMAGE_VERSION_INDEX_KEY, 'json');
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) {
      return raw;
    }
  } catch {
    // Fall through to rebuild
  }

  console.warn('[image-version] Tag index missing or corrupted, rebuilding from KV list');
  return rebuildIndex(kv);
}

/**
 * Rebuild the tag index by listing all `image-version:<ver>:<variant>` keys.
 * Excludes `image-version:latest:*` and the index key itself.
 */
async function rebuildIndex(kv: KVNamespace): Promise<string[]> {
  const tags: string[] = [];
  let cursor: string | undefined;

  // KV list is paginated (1000 keys per page)
  do {
    const result = await kv.list({ prefix: 'image-version:', cursor });
    for (const key of result.keys) {
      if (key.name.startsWith('image-version:latest:') || key.name === IMAGE_VERSION_INDEX_KEY) {
        continue;
      }
      const raw = await kv.get(key.name, 'json');
      const parsed = ImageVersionEntrySchema.safeParse(raw);
      if (parsed.success && !tags.includes(parsed.data.imageTag)) {
        tags.push(parsed.data.imageTag);
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  await kv.put(IMAGE_VERSION_INDEX_KEY, JSON.stringify(tags));
  console.log('[image-version] Rebuilt tag index with', tags.length, 'entries');
  return tags;
}

// ---------------------------------------------------------------------------
// Resolve a specific version by image tag (for pinned users)
// ---------------------------------------------------------------------------

/**
 * Find a version entry in KV by its image tag.
 * Uses direct tag-to-entry lookup key for O(1) resolution.
 * Falls back to scanning versioned keys if the tag lookup key is missing
 * (for backward compatibility or cache misses), then backfills the lookup key.
 * Returns null if no entry matches the given tag.
 */
export async function resolveVersionByTag(
  kv: KVNamespace,
  imageTag: string
): Promise<ImageVersionEntry | null> {
  // Fast path: direct tag lookup
  const raw = await kv.get(imageVersionTagKey(imageTag), 'json');
  if (raw) {
    const parsed = ImageVersionEntrySchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    console.warn('[image-version] Invalid tag entry in KV:', imageTag, parsed.error.flatten());
  }

  // Fallback: scan versioned keys (for backward compatibility or cache misses).
  // Capped at 5 pages (5000 keys) to prevent unbounded iteration.
  console.warn('[image-version] Tag lookup key missing, falling back to scan for:', imageTag);
  let cursor: string | undefined;
  let pages = 0;
  const MAX_SCAN_PAGES = 5;
  do {
    const result = await kv.list({ prefix: 'image-version:', cursor });
    pages++;
    for (const key of result.keys) {
      if (
        key.name.startsWith('image-version:latest:') ||
        key.name.startsWith('image-version-tag:') ||
        key.name === IMAGE_VERSION_INDEX_KEY
      ) {
        continue;
      }
      const raw = await kv.get(key.name, 'json');
      const parsed = ImageVersionEntrySchema.safeParse(raw);
      if (parsed.success && parsed.data.imageTag === imageTag) {
        // Backfill the tag lookup key for future requests (fire-and-forget)
        kv.put(imageVersionTagKey(imageTag), JSON.stringify(parsed.data)).catch(err =>
          console.warn(
            '[image-version] Failed to backfill tag lookup key:',
            err instanceof Error ? err.message : err
          )
        );
        return parsed.data;
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor && pages < MAX_SCAN_PAGES);

  if (cursor) {
    console.warn('[image-version] Scan aborted after', MAX_SCAN_PAGES, 'pages for tag:', imageTag);
  }

  return null;
}

// ---------------------------------------------------------------------------
// List all versions (for admin tooling / triggerSync)
// ---------------------------------------------------------------------------

/**
 * List all registered image versions by scanning KV keys with prefix `image-version:`.
 * Paginates through all keys and parses each entry.
 */
export async function listAllVersions(kv: KVNamespace): Promise<ImageVersionEntry[]> {
  const versions: ImageVersionEntry[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix: 'image-version:', cursor });
    for (const key of result.keys) {
      // Skip latest pointers, tag lookups, and the index key
      if (
        key.name.startsWith('image-version:latest:') ||
        key.name.startsWith('image-version-tag:') ||
        key.name === IMAGE_VERSION_INDEX_KEY
      ) {
        continue;
      }
      const raw = await kv.get(key.name, 'json');
      const parsed = ImageVersionEntrySchema.safeParse(raw);
      if (parsed.success) {
        versions.push(parsed.data);
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return versions;
}
