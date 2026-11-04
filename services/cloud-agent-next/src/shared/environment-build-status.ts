import { z } from 'zod';

/**
 * Public environment build contracts (plan "Build admission and execution"),
 * shared by the Worker's tRPC handlers and the web client. They return status
 * and metadata only: no snapshot handle, no secret, no command text and no log
 * of credentials ever crosses this boundary.
 */

export const ENVIRONMENT_BUILD_PUBLIC_STATES = [
  'queued',
  'preparing',
  'capturing',
  'publishing',
  'stopping',
  'succeeded',
  'failed',
  'canceled',
  'obsolete',
] as const;

export const environmentBuildSummarySchema = z
  .object({
    buildId: z.string().uuid(),
    revision: z.number().int().positive(),
    trigger: z.enum(['manual', 'session']),
    state: z.enum(ENVIRONMENT_BUILD_PUBLIC_STATES),
    /** The terminal state a stopping build enters once cleanup is confirmed. */
    outcome: z.enum(['succeeded', 'failed', 'canceled', 'obsolete']).nullable(),
    step: z.enum(['clone', 'setup', 'cleanup']).nullable(),
    failureReason: z.string().nullable(),
    failureDetail: z.string().nullable(),
    sourceCommit: z.string().nullable(),
    sourceBranch: z.string().nullable(),
    setupDurationMs: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int(),
    finishedAt: z.number().int().nullable(),
    cleanup: z.enum(['not_started', 'pending', 'confirmed', 'failing']),
    logTruncated: z.boolean(),
  })
  .strict();
export type EnvironmentBuildSummary = z.infer<typeof environmentBuildSummarySchema>;

export const environmentSnapshotSummarySchema = z
  .object({
    buildId: z.string().uuid(),
    revision: z.number().int().positive(),
    /** A V2 snapshot leaves the singleton commit and branch null. */
    sourceCommit: z.string().nullable(),
    sourceBranch: z.string().nullable(),
    /** The commit each repository of a V2 snapshot was built at; absent for V1. */
    repositories: z
      .array(z.object({ repoFullName: z.string(), commit: z.string() }).strict())
      .optional(),
    capturedAt: z.number().int(),
    size: z.number().nonnegative().nullable(),
    setupDurationMs: z.number().int().nonnegative(),
    /** `revision`: a newer configuration exists; `age`: older than the refresh age. */
    /** `image`: built for another sandbox image or runtime ABI, so sessions start without it. */
    stale: z.enum(['revision', 'age', 'image']).nullable(),
    expiresAt: z.number().int(),
  })
  .strict();
export type EnvironmentSnapshotSummary = z.infer<typeof environmentSnapshotSummarySchema>;

export const environmentBuildStatusSchema = z
  .object({
    environmentId: z.string().uuid(),
    /** False when the environment's provider cannot build snapshots. */
    supported: z.boolean(),
    unsupportedReason: z.string().nullable(),
    configurationRevision: z.number().int().positive(),
    activeBuild: environmentBuildSummarySchema.nullable(),
    latestBuild: environmentBuildSummarySchema.nullable(),
    published: environmentSnapshotSummarySchema.nullable(),
    automaticBackoff: z
      .object({
        revision: z.number().int().positive(),
        failures: z.number().int().nonnegative(),
        nextAttemptAt: z.number().int(),
      })
      .strict()
      .nullable(),
    /** A fresh session start that takes longer than this times out. */
    sessionPreparationBudgetMs: z.number().int().positive(),
  })
  .strict();
export type EnvironmentBuildStatus = z.infer<typeof environmentBuildStatusSchema>;

export const environmentBuildLogsSchema = z
  .object({
    buildId: z.string().uuid(),
    lines: z.array(z.object({ seq: z.number().int(), text: z.string() }).strict()),
    /** Pass back to read the following lines. */
    nextCursor: z.number().int().nonnegative(),
    truncated: z.boolean(),
    /** The build is terminal: no more lines will arrive. */
    complete: z.boolean(),
  })
  .strict();
export type EnvironmentBuildLogs = z.infer<typeof environmentBuildLogsSchema>;

export const environmentBuildRequestResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      buildId: z.string().uuid(),
      /** False when the same request id or revision returned an existing build. */
      created: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('conflict'),
      reason: z.enum(['build_in_progress', 'revision_changed', 'cleanup_pending']),
      buildId: z.string().uuid().nullable(),
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      reason: z.enum([
        'not_found',
        'unsupported_provider',
        'billing_blocked',
        'container_limit_reached',
        'repository_unauthorized',
      ]),
    })
    .strict(),
]);
export type EnvironmentBuildRequestResult = z.infer<typeof environmentBuildRequestResultSchema>;

export const environmentBuildCancelResultSchema = z
  .object({ status: z.enum(['canceling', 'canceled', 'not_active']) })
  .strict();
export type EnvironmentBuildCancelResult = z.infer<typeof environmentBuildCancelResultSchema>;
