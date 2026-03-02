/**
 * Writes image version entries to the Postgres catalog via Hyperdrive.
 * Best-effort — failures are logged but do not block KV registration.
 */

import { getWorkerDb } from '@kilocode/db/client';
import { kiloclaw_image_catalog, sql, ne } from '@kilocode/db';
import { isValidImageTag } from './image-tag-validation';

const OPENCLAW_VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}$/;
const VARIANT_RE = /^[a-z0-9-]{1,64}$/;

export interface CatalogVersionEntry {
  openclawVersion: string;
  variant: string;
  imageTag: string;
  imageDigest: string | null;
  publishedAt: string;
}

/**
 * Validate a catalog entry before writing to Postgres.
 * Returns an error message if invalid, null if valid.
 */
function validateEntry(entry: CatalogVersionEntry): string | null {
  if (!isValidImageTag(entry.imageTag)) {
    return `Invalid image tag: ${entry.imageTag}`;
  }
  if (!OPENCLAW_VERSION_RE.test(entry.openclawVersion)) {
    return `Invalid openclaw version format: ${entry.openclawVersion}`;
  }
  if (!VARIANT_RE.test(entry.variant)) {
    return `Invalid variant format: ${entry.variant}`;
  }
  const published = new Date(entry.publishedAt);
  if (isNaN(published.getTime())) {
    return `Invalid publishedAt timestamp: ${entry.publishedAt}`;
  }
  const now = Date.now();
  if (published.getTime() > now + 60_000) {
    return `publishedAt is in the future: ${entry.publishedAt}`;
  }
  if (published.getTime() < now - 365 * 86_400_000) {
    return `publishedAt is older than 1 year: ${entry.publishedAt}`;
  }
  return null;
}

/**
 * Upsert a version entry into the Postgres catalog.
 * Uses ON CONFLICT to update existing entries but never re-enables
 * admin-disabled versions.
 */
export async function upsertCatalogVersion(
  connectionString: string,
  entry: CatalogVersionEntry
): Promise<void> {
  const validationError = validateEntry(entry);
  if (validationError) {
    console.warn('[catalog-registration] Skipping invalid entry:', validationError);
    return;
  }

  const db = getWorkerDb(connectionString);
  await db
    .insert(kiloclaw_image_catalog)
    .values({
      openclaw_version: entry.openclawVersion,
      variant: entry.variant,
      image_tag: entry.imageTag,
      image_digest: entry.imageDigest,
      status: 'available',
      published_at: entry.publishedAt,
    })
    .onConflictDoUpdate({
      target: kiloclaw_image_catalog.image_tag,
      set: {
        openclaw_version: sql`EXCLUDED.openclaw_version`,
        variant: sql`EXCLUDED.variant`,
        image_digest: sql`EXCLUDED.image_digest`,
        published_at: sql`EXCLUDED.published_at`,
        synced_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      },
      // Never re-enable admin-disabled versions
      setWhere: ne(kiloclaw_image_catalog.status, 'disabled'),
    });
}
