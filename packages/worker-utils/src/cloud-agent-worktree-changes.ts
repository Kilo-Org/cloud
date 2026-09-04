import { z } from 'zod';

export const WORKTREE_CHANGES_SCHEMA_VERSION = 1;
export const MAX_WORKTREE_CHANGES_FILES = 1_000;
export const MAX_WORKTREE_CHANGES_BYTES = 256 * 1024;
export const WORKTREE_FILE_SCHEMA_VERSION = 1;
export const MAX_WORKTREE_FILE_BYTES = 512 * 1024;
export const MAX_WORKTREE_SNAPSHOT_BYTES = 10 * 1024 * 1024;
export const MAX_WORKTREE_PATCH_LINES = 10_000;
export const MAX_WORKTREE_CONTENT_BYTES = 100 * 1024;
export const MAX_WORKTREE_CONTENT_LINES = 10_000;

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

export const worktreeFileOmissionReasonSchema = z.enum([
  'binary',
  'unsupported',
  'invalid_utf8',
  'too_large',
  'line_limit',
  'budget_exhausted',
  'inconsistent',
  'capture_failed',
]);

export const worktreeFileRecordSchema = z
  .object({
    schemaVersion: z.literal(WORKTREE_FILE_SCHEMA_VERSION),
    revision: revisionSchema,
    path: worktreeChangesFileSchema.shape.path,
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
  );

export const worktreeSnapshotCaptureSchema = z
  .object({
    summary: worktreeChangesCaptureSchema,
    files: z.array(worktreeFileRecordSchema).max(MAX_WORKTREE_CHANGES_FILES),
  })
  .strict()
  .refine(({ summary, files }) => {
    if (files.length !== summary.files.length) return false;
    const listedFiles = new Map(summary.files.map(file => [file.path, file]));
    if (listedFiles.size !== summary.files.length) return false;
    const paths = new Set<string>();
    return files.every(file => {
      const listed = listedFiles.get(file.path);
      if (!listed || paths.has(file.path) || file.revision !== summary.revision) return false;
      paths.add(file.path);
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
  );

export const worktreeFileQuerySchema = z
  .object({
    path: worktreeChangesFileSchema.shape.path,
    expectedRevision: revisionSchema,
  })
  .strict();

export const getWorktreeFileOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.enum(['available', 'omitted']),
      file: worktreeFileRecordSchema,
      capturedAt: z.string().datetime({ offset: true }),
      comparison: captureFields.comparison,
    })
    .strict()
    .refine(
      result => result.status === result.file.diff.status,
      'Worktree file result status does not match the diff'
    ),
  z.object({ status: z.literal('not_captured') }).strict(),
  z.object({ status: z.literal('no_longer_listed'), currentRevision: revisionSchema }).strict(),
  z.object({ status: z.literal('stale'), currentRevision: revisionSchema }).strict(),
]);

export type WorktreeChangesFile = z.infer<typeof worktreeChangesFileSchema>;
export type WorktreeChangesCaptureRequest = z.infer<typeof worktreeChangesCaptureRequestSchema>;
export type WorktreeChangesCapture = z.infer<typeof worktreeChangesCaptureSchema>;
export type WorktreeChangesSnapshot = z.infer<typeof worktreeChangesSnapshotSchema>;
export type GetWorktreeChangesOutput = z.infer<typeof getWorktreeChangesOutputSchema>;
export type RefreshWorktreeChangesOutput = z.infer<typeof refreshWorktreeChangesOutputSchema>;
export type WorktreeFileOmissionReason = z.infer<typeof worktreeFileOmissionReasonSchema>;
export type WorktreeFileRecord = z.infer<typeof worktreeFileRecordSchema>;
export type WorktreeSnapshotCapture = z.infer<typeof worktreeSnapshotCaptureSchema>;
export type WorktreeFileQuery = z.infer<typeof worktreeFileQuerySchema>;
export type GetWorktreeFileOutput = z.infer<typeof getWorktreeFileOutputSchema>;
