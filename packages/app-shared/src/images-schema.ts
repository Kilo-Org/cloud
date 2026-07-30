/**
 * Generic schema and type for image attachments.
 *
 * This file is intentionally isolated to avoid circular dependencies.
 * It can be imported from both cloud-agent and app-builder modules.
 *
 * R2 path structure: {bucket}/{userId}/{path}/{filename}
 * - userId is derived from the authenticated user context
 * - path is app-specific (e.g., "app-builder/msg-uuid", "cloud-agent/session123")
 * - files are either specified explicitly or all files at the path are downloaded
 */
import * as z from 'zod';

/**
 * Generic images schema for attaching images to prompts.
 */
export const imagesSchema = z
  .object({
    /**
     * App-specific path within the user's namespace.
     * Examples: "app-builder/msg-uuid-123", "cloud-agent/session-456"
     */
    path: z.string().min(1).max(500),
    /**
     * Ordered list of filenames to download.
     */
    files: z.array(z.string().max(255)).min(1),
  })
  .optional();

/**
 * Image attachments with path and optional ordered list of filenames.
 * Derived from imagesSchema zod validator.
 */
export type Images = NonNullable<z.infer<typeof imagesSchema>>;
