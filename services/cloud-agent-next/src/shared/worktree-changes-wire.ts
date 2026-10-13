import type {
  WorktreeChangesCapture,
  WorktreeChangesCaptureRequest,
  WorktreeChangesFile as PublicWorktreeChangesFile,
  WorktreeFileOmissionReason as PublicWorktreeFileOmissionReason,
  WorktreeFileRecord as PublicWorktreeFileRecord,
  WorktreeSnapshotCapture as PublicWorktreeSnapshotCapture,
  WorktreeRecovery as PublicWorktreeRecovery,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { z } from 'zod';

export const MAX_WORKTREE_CHANGES_FILES = 1_000;
export const MAX_WORKTREE_CHANGES_BYTES = 256 * 1024;
export const WORKTREE_CHANGED_EVENT = 'session.worktree.changed';
export const WORKTREE_CHANGES_READY_EVENT = 'cloud.worktree.changes.ready';
export const WORKTREE_FILE_SCHEMA_VERSION = 1;
export const MAX_WORKTREE_FILE_BYTES = 512 * 1024;
export const MAX_WORKTREE_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_WORKTREE_PATCH_LINES = 10_000;
export const MAX_WORKTREE_CONTENT_BYTES = 100 * 1024;
export const MAX_WORKTREE_CONTENT_LINES = 10_000;

const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    path =>
      !path.includes('\0') &&
      path.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
    'Expected a repository-relative path'
  );

export const worktreeRecoverySchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: repositoryRelativePathSchema,
            status: z.enum(['added', 'modified', 'deleted']),
            patch: z.string().optional(),
          })
          .strict()
      )
      .max(MAX_WORKTREE_CHANGES_FILES),
  })
  .strict()
  .refine(
    value => new Set(value.files.map(file => file.path)).size === value.files.length,
    'Recovery paths must be unique'
  )
  .refine(
    value =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_WORKTREE_CHANGES_BYTES
  ) satisfies z.ZodType<PublicWorktreeRecovery>;

export type WorktreeRecovery = z.infer<typeof worktreeRecoverySchema>;

function hasAtMostLines(text: string, limit: number): boolean {
  let lines = text.length > 0 && !text.endsWith('\n') ? 1 : 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines += 1;
    if (lines > limit) return false;
  }
  return lines <= limit;
}

const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const baseRefSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(ref => !ref.startsWith('-') && !ref.includes('\0'), 'Invalid comparison ref');

const worktreeChangesScopeSchema = z.enum(['uncommitted', 'against-base-branch']);

export function worktreeFileIdentity(file: {
  path: string;
  scope?: z.infer<typeof worktreeChangesScopeSchema>;
}): string {
  return file.scope === undefined ? file.path : `${file.scope}\0${file.path}`;
}

export const worktreeChangesFileSchema = z
  .object({
    path: repositoryRelativePathSchema,
    status: z.enum(['added', 'modified', 'deleted']),
    scope: worktreeChangesScopeSchema.optional(),
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
    capture => new Set(capture.files.map(worktreeFileIdentity)).size === capture.files.length,
    'Worktree summary identities must be unique'
  )
  .refine(
    capture =>
      new TextEncoder().encode(JSON.stringify(capture)).byteLength <= MAX_WORKTREE_CHANGES_BYTES,
    'Worktree summary exceeds the size limit'
  ) satisfies z.ZodType<WorktreeChangesCapture>;

export const worktreeFileOmissionReasonSchema = z.enum([
  'binary',
  'unsupported',
  'invalid_utf8',
  'too_large',
  'line_limit',
  'budget_exhausted',
  'inconsistent',
  'capture_failed',
]) satisfies z.ZodType<PublicWorktreeFileOmissionReason>;

export const worktreeFileRecordSchema = z
  .object({
    schemaVersion: z.literal(WORKTREE_FILE_SCHEMA_VERSION),
    revision: revisionSchema,
    path: worktreeChangesFileSchema.shape.path,
    scope: worktreeChangesScopeSchema.optional(),
    diff: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('available'),
          patch: z
            .string()
            .min(1)
            .refine(
              patch => hasAtMostLines(patch, MAX_WORKTREE_PATCH_LINES),
              'Worktree patch exceeds the line limit'
            ),
        })
        .strict(),
      z.object({ status: z.literal('omitted'), reason: worktreeFileOmissionReasonSchema }).strict(),
    ]),
    content: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('available'),
          source: z.enum(['current', 'deleted-original']),
          text: z
            .string()
            .refine(
              text => new TextEncoder().encode(text).byteLength < MAX_WORKTREE_CONTENT_BYTES,
              'Worktree content exceeds the size limit'
            )
            .refine(
              text => hasAtMostLines(text, MAX_WORKTREE_CONTENT_LINES),
              'Worktree content exceeds the line limit'
            ),
        })
        .strict(),
      z
        .object({ status: z.literal('unavailable'), reason: worktreeFileOmissionReasonSchema })
        .strict(),
    ]),
  })
  .strict()
  .refine(
    file => new TextEncoder().encode(JSON.stringify(file)).byteLength <= MAX_WORKTREE_FILE_BYTES,
    'Worktree file record exceeds the size limit'
  ) satisfies z.ZodType<PublicWorktreeFileRecord>;

export const worktreeSnapshotCaptureSchema = z
  .object({
    summary: sessionGitSummaryResultSchema,
    files: z.array(worktreeFileRecordSchema).max(MAX_WORKTREE_CHANGES_FILES),
    recovery: worktreeRecoverySchema.optional(),
  })
  .strict()
  .refine(({ summary, files }) => {
    if (files.length !== summary.files.length) return false;
    const listedFiles = new Map(summary.files.map(file => [worktreeFileIdentity(file), file]));
    if (listedFiles.size !== summary.files.length) return false;
    const paths = new Set<string>();
    return files.every(file => {
      const identity = worktreeFileIdentity(file);
      const listed = listedFiles.get(identity);
      if (!listed || paths.has(identity) || file.revision !== summary.revision) return false;
      paths.add(identity);
      return (
        file.content.status === 'unavailable' ||
        file.content.source === (listed.status === 'deleted' ? 'deleted-original' : 'current')
      );
    });
  }, 'Worktree file records do not match the summary')
  .refine(
    capture =>
      new TextEncoder().encode(JSON.stringify(capture)).byteLength <= MAX_WORKTREE_SNAPSHOT_BYTES,
    'Worktree snapshot exceeds the size limit'
  ) satisfies z.ZodType<PublicWorktreeSnapshotCapture>;

export const sessionGitSnapshotPayloadSchema = sessionGitSummaryPayloadSchema;
export const sessionGitSnapshotResultSchema = worktreeSnapshotCaptureSchema;

export type WorktreeChangesFile = z.infer<typeof worktreeChangesFileSchema>;
export type SessionGitSummaryPayload = z.infer<typeof sessionGitSummaryPayloadSchema>;
export type SessionGitSummaryResult = z.infer<typeof sessionGitSummaryResultSchema>;
export type WorktreeFileOmissionReason = z.infer<typeof worktreeFileOmissionReasonSchema>;
export type WorktreeFileRecord = z.infer<typeof worktreeFileRecordSchema>;
export type WorktreeSnapshotCapture = z.infer<typeof worktreeSnapshotCaptureSchema>;
export type SessionGitSnapshotPayload = z.infer<typeof sessionGitSnapshotPayloadSchema>;
export type SessionGitSnapshotResult = z.infer<typeof sessionGitSnapshotResultSchema>;
