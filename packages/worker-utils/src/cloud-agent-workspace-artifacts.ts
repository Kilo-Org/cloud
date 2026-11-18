import { z } from 'zod';

export const WORKSPACE_ARTIFACT_MAX_FILES = 1_000;
export const WORKSPACE_ARTIFACT_MAX_PATH_BYTES = 1_024;

export const workspaceArtifactRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const workspaceArtifactRelativePathSchema = z
  .string()
  .min(1)
  .refine(path => new TextEncoder().encode(path).byteLength <= WORKSPACE_ARTIFACT_MAX_PATH_BYTES, {
    message: 'Workspace artifact path exceeds the size limit',
  });

export const workspaceArtifactEntrySchema = z
  .object({
    relativePath: workspaceArtifactRelativePathSchema,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentType: z.string().min(1),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const workspaceArtifactSessionInputSchema = z
  .object({ cloudAgentSessionId: z.string().min(1) })
  .strict();

export const workspaceArtifactDownloadInputSchema = z
  .object({
    cloudAgentSessionId: z.string().min(1),
    relativePath: workspaceArtifactRelativePathSchema,
  })
  .strict();

export const workspaceArtifactDeleteInputSchema = z
  .object({
    cloudAgentSessionId: z.string().min(1),
    relativePath: workspaceArtifactRelativePathSchema,
    expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const listWorkspaceArtifactsOutputSchema = z
  .object({
    revision: workspaceArtifactRevisionSchema,
    entries: z.array(workspaceArtifactEntrySchema).max(WORKSPACE_ARTIFACT_MAX_FILES),
  })
  .strict();

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https, or http to a loopback host for the local storage emulator. */
function isSafeDownloadUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export const getWorkspaceArtifactDownloadUrlOutputSchema = z
  .object({
    // The client navigates to this URL, so a script or data scheme must never pass.
    url: z.string().url().refine(isSafeDownloadUrl, {
      message: 'Workspace artifact download URL must use https',
    }),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const deleteWorkspaceArtifactOutputSchema = z
  .object({
    status: z.enum(['deleted', 'absent', 'hash_mismatch']),
    revision: workspaceArtifactRevisionSchema,
  })
  .strict();

export type WorkspaceArtifactEntry = z.infer<typeof workspaceArtifactEntrySchema>;
export type ListWorkspaceArtifactsOutput = z.infer<typeof listWorkspaceArtifactsOutputSchema>;
export type GetWorkspaceArtifactDownloadUrlOutput = z.infer<
  typeof getWorkspaceArtifactDownloadUrlOutputSchema
>;
export type DeleteWorkspaceArtifactOutput = z.infer<typeof deleteWorkspaceArtifactOutputSchema>;
