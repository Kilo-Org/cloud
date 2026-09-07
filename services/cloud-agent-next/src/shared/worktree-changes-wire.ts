import type {
  WorktreeChangesCapture,
  WorktreeChangesCaptureRequest,
  WorktreeChangesFile as PublicWorktreeChangesFile,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { z } from 'zod';

export const MAX_WORKTREE_CHANGES_FILES = 1_000;
export const MAX_WORKTREE_CHANGES_BYTES = 256 * 1024;
export const WORKTREE_CHANGED_EVENT = 'session.worktree.changed';
export const WORKTREE_CHANGES_READY_EVENT = 'cloud.worktree.changes.ready';

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
  .strict() satisfies z.ZodType<PublicWorktreeChangesFile>;

export const sessionGitSummaryPayloadSchema = z
  .object({
    revision: revisionSchema,
    baseRef: baseRefSchema.optional(),
  })
  .strict() satisfies z.ZodType<WorktreeChangesCaptureRequest>;

export const sessionGitSummaryResultSchema = z
  .object({
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
  })
  .strict()
  .refine(
    capture =>
      new TextEncoder().encode(JSON.stringify(capture)).byteLength <= MAX_WORKTREE_CHANGES_BYTES,
    'Worktree summary exceeds the size limit'
  ) satisfies z.ZodType<WorktreeChangesCapture>;

export type WorktreeChangesFile = z.infer<typeof worktreeChangesFileSchema>;
export type SessionGitSummaryPayload = z.infer<typeof sessionGitSummaryPayloadSchema>;
export type SessionGitSummaryResult = z.infer<typeof sessionGitSummaryResultSchema>;
