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
