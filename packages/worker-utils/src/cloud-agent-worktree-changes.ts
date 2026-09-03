import { z } from 'zod';

export const WORKTREE_CHANGES_SCHEMA_VERSION = 1;
export const MAX_WORKTREE_CHANGES_FILES = 1_000;
export const MAX_WORKTREE_CHANGES_BYTES = 256 * 1024;

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const baseRefSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(ref => !ref.startsWith('-') && !ref.includes('\0'), 'Invalid comparison ref');

export const worktreeChangesFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        path =>
          !path.includes('\0') &&
          path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
        'Expected a repository-relative path'
      ),
    status: z.enum(['added', 'modified', 'deleted']),
    additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tracked: z.boolean(),
    binary: z.boolean(),
    countsComplete: z.boolean(),
  })
  .strict();

export const worktreeChangesCaptureRequestSchema = z
  .object({
    revision: revisionSchema,
    baseRef: baseRefSchema.optional(),
  })
  .strict();

const captureFields = {
  revision: revisionSchema,
  comparison: z
    .object({
      baseRef: baseRefSchema,
      mergeBase: commitSchema,
      head: commitSchema,
    })
    .strict(),
  files: z.array(worktreeChangesFileSchema).max(MAX_WORKTREE_CHANGES_FILES),
  truncated: z.boolean(),
};

export const worktreeChangesCaptureSchema = z
  .object(captureFields)
  .strict()
  .refine(
    capture =>
      new TextEncoder().encode(JSON.stringify(capture)).byteLength <= MAX_WORKTREE_CHANGES_BYTES,
    'Worktree summary exceeds the size limit'
  );

export const worktreeChangesSnapshotSchema = z
  .object({
    schemaVersion: z.literal(WORKTREE_CHANGES_SCHEMA_VERSION),
    capturedAt: z.string().datetime({ offset: true }),
    ...captureFields,
  })
  .strict()
  .refine(
    snapshot =>
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= MAX_WORKTREE_CHANGES_BYTES,
    'Saved worktree summary exceeds the size limit'
  );

export const getWorktreeChangesOutputSchema = z
  .object({ snapshot: worktreeChangesSnapshotSchema.nullable() })
  .strict();

export const refreshWorktreeChangesOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('refreshed'), snapshot: worktreeChangesSnapshotSchema }).strict(),
  z
    .object({
      status: z.enum(['offline', 'failed']),
      snapshot: worktreeChangesSnapshotSchema.nullable(),
    })
    .strict(),
]);

export type WorktreeChangesFile = z.infer<typeof worktreeChangesFileSchema>;
export type WorktreeChangesCaptureRequest = z.infer<typeof worktreeChangesCaptureRequestSchema>;
export type WorktreeChangesCapture = z.infer<typeof worktreeChangesCaptureSchema>;
export type WorktreeChangesSnapshot = z.infer<typeof worktreeChangesSnapshotSchema>;
export type GetWorktreeChangesOutput = z.infer<typeof getWorktreeChangesOutputSchema>;
export type RefreshWorktreeChangesOutput = z.infer<typeof refreshWorktreeChangesOutputSchema>;
