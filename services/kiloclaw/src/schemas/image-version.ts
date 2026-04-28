import { z } from 'zod';

/**
 * Supported image variants. Day 1 ships with "default" only.
 * Adding a new variant requires a code change + deploy (extend the enum).
 */
export const ImageVariantSchema = z.enum(['default']);
export type ImageVariant = z.infer<typeof ImageVariantSchema>;

/**
 * KV value for `image-version:<openclawVersion>:<variant>` keys
 * and `image-version:latest:<variant>` keys (both store the full entry).
 */
export const ImageVersionEntrySchema = z.object({
  openclawVersion: z.string(),
  variant: ImageVariantSchema,
  imageTag: z.string(),
  imageDigest: z.string().nullable(),
  publishedAt: z.string(),
  // 0 = not exposed. 0 < x < 100 = staged candidate; instance is offered the
  // upgrade when its SHA-256 bucket of `${imageTag}:instance:${instanceId}`
  // falls below x. 100 = candidate fully rolled out (everyone qualifies).
  // INDEPENDENT of `isLatest` — promoting to :latest is its own action.
  rolloutPercent: z.number().int().min(0).max(100).default(0),
  // True if this image is the current production `:latest` for its variant.
  // Ops marks it explicitly via the admin Versions page. New instances and
  // unpinned upgrades fall back to this image when they don't qualify for a
  // candidate.
  isLatest: z.boolean().default(false),
});

export type ImageVersionEntry = z.infer<typeof ImageVersionEntrySchema>;

// KV key helpers — variant is encoded in the key so each lookup is a single read.
// "latest" is reserved for the latest pointer key and cannot be used as a version.

export function imageVersionKey(version: string, variant: string): string {
  if (version === 'latest') {
    throw new Error('Cannot use "latest" as a version — it is reserved for the latest pointer key');
  }
  return `image-version:${version}:${variant}`;
}

export function imageVersionLatestKey(variant: string): string {
  return `image-version:latest:${variant}`;
}

/**
 * KV key for direct tag-to-entry lookup. Enables O(1) resolution of pinned
 * image tags during provision and lookups by tag during rollout selection.
 */
export function imageVersionTagKey(imageTag: string): string {
  return `image-version-tag:${imageTag}`;
}

/**
 * KV key for the tag index — a JSON array of image_tag strings.
 * Used by updateTagIndex() to maintain a fast lookup of registered tags.
 */
export const IMAGE_VERSION_INDEX_KEY = 'image-version-index';
