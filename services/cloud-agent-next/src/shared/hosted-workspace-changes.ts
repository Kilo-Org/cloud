import { cloudAgentWorktreeIdSchema } from '@kilocode/session-ingest-contracts';
import {
  MAX_WORKTREE_CHANGES_FILES,
  worktreeChangesCapturedAtSchema,
  worktreeChangesComparisonSchema,
  worktreeChangesFileSchema,
  worktreeChangesRevisionSchema,
  worktreeChangesScopeSchema,
  worktreeFileOmissionReasonSchema,
  worktreeFileRecordSchema,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { z } from 'zod';

const workspaceScopedInputFields = {
  workspaceId: cloudAgentWorktreeIdSchema,
  kilocodeOrganizationId: z.uuid().optional(),
};

const workspacePathSchema = worktreeChangesFileSchema.shape.path;

/**
 * The GitHub authority rule for the linked-PR leg. A workspace read never
 * accepts caller-supplied owner/repo/number, and it never spends a connected
 * user's credential: the owner's installation must be able to read the PR.
 * `credential_required` is the distinct answer when only a connected-user
 * credential would work.
 */
export const hostedWorkspacePullRequestReasonSchema = z.enum([
  'no_pull_request',
  'pull_request_not_found',
  'head_ref_mismatch',
  'repository_mismatch',
  'installation_unavailable',
  'connected_user_required',
  'github_access_denied',
  'github_rate_limited',
  'github_unavailable',
  'unsupported_repository',
]);

export const hostedWorkspacePullRequestFileOmissionReasonSchema = z.enum(['provider_omitted']);

export const hostedWorkspaceChangeAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available') }).strict(),
  z.object({ status: z.literal('omitted'), reason: worktreeFileOmissionReasonSchema }).strict(),
]);

export const hostedWorkspaceContentAvailabilitySchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('available'), source: z.enum(['current', 'deleted-original']) })
    .strict(),
  z.object({ status: z.literal('unavailable'), reason: worktreeFileOmissionReasonSchema }).strict(),
]);

export const hostedWorkspaceChangeStateSchema = z
  .object({
    path: workspacePathSchema,
    scope: worktreeChangesScopeSchema.optional(),
    revision: worktreeChangesRevisionSchema,
    diff: hostedWorkspaceChangeAvailabilitySchema,
    content: hostedWorkspaceContentAvailabilitySchema,
  })
  .strict();

export const hostedWorkspaceChangeRepositoryIdentitySchema = z
  .object({
    path: z.string().max(4096),
    repoFullName: z.string().min(1).max(500),
  })
  .strict();

export const hostedWorkspaceChangeFileSchema = z
  .object({
    path: workspacePathSchema,
    status: worktreeChangesFileSchema.shape.status,
    scope: worktreeChangesScopeSchema.optional(),
    additions: worktreeChangesFileSchema.shape.additions,
    deletions: worktreeChangesFileSchema.shape.deletions,
    tracked: z.boolean(),
    binary: z.boolean(),
    countsComplete: z.boolean(),
    revision: worktreeChangesRevisionSchema,
    repository: hostedWorkspaceChangeRepositoryIdentitySchema.nullable(),
    diff: hostedWorkspaceChangeAvailabilitySchema,
    content: hostedWorkspaceContentAvailabilitySchema,
  })
  .strict();

export const hostedWorkspaceChangeComparisonSchema = z
  .object({
    repository: hostedWorkspaceChangeRepositoryIdentitySchema.nullable(),
    comparison: worktreeChangesComparisonSchema,
    truncated: z.boolean(),
    files: z.array(hostedWorkspaceChangeFileSchema).max(MAX_WORKTREE_CHANGES_FILES),
  })
  .strict();

export const getHostedWorkspaceChangesInput = z.object(workspaceScopedInputFields).strict();

/**
 * A flat envelope so a caller can branch on `status` without a shape change:
 * `captured` carries the revision, capture time and per-repository
 * comparisons; `not_captured` and `inconsistent` carry none. `inconsistent` is
 * the fail-closed answer for a saved multi-repository snapshot whose file
 * cannot be attributed to exactly one repository.
 */
export const getHostedWorkspaceChangesOutput = z
  .object({
    status: z.enum(['captured', 'not_captured', 'inconsistent']),
    workspaceId: cloudAgentWorktreeIdSchema,
    revision: worktreeChangesRevisionSchema.nullable(),
    capturedAt: worktreeChangesCapturedAtSchema.nullable(),
    truncated: z.boolean(),
    comparisons: z.array(hostedWorkspaceChangeComparisonSchema).nullable(),
  })
  .strict()
  .refine(
    result =>
      result.status === 'captured'
        ? result.revision !== null &&
          result.capturedAt !== null &&
          result.comparisons !== null &&
          result.comparisons.length > 0
        : result.revision === null &&
          result.capturedAt === null &&
          result.comparisons === null &&
          !result.truncated,
    'Workspace changes result does not match its status'
  );

/**
 * `refreshed` carries the new saved snapshot. `offline` and `failed` keep the
 * previous saved snapshot when there is one, matching the session-scoped
 * refresh contract; a refresh never discards a durable snapshot, allocates
 * compute or opens a billing interval.
 */
export const refreshHostedWorkspaceChangesOutput = z
  .object({
    status: z.enum(['refreshed', 'offline', 'failed']),
    changes: getHostedWorkspaceChangesOutput,
  })
  .strict();

export const getHostedWorkspaceChangeFileInput = z
  .object({
    ...workspaceScopedInputFields,
    path: workspacePathSchema,
    scope: worktreeChangesScopeSchema.optional(),
    expectedRevision: worktreeChangesRevisionSchema,
  })
  .strict();

export const getHostedWorkspaceChangeFileOutput = z
  .object({
    status: z.enum(['available', 'omitted', 'not_captured', 'no_longer_listed', 'stale']),
    file: worktreeFileRecordSchema.nullable(),
    capturedAt: worktreeChangesCapturedAtSchema.nullable(),
    comparison: worktreeChangesComparisonSchema.nullable(),
    currentRevision: worktreeChangesRevisionSchema.nullable(),
  })
  .strict()
  .refine(
    result =>
      result.status === 'available' || result.status === 'omitted'
        ? result.file !== null &&
          result.file.diff.status === result.status &&
          result.capturedAt !== null &&
          result.comparison !== null
        : result.file === null && result.capturedAt === null && result.comparison === null,
    'Worktree file result does not match its status'
  )
  .refine(
    result =>
      result.status === 'no_longer_listed' || result.status === 'stale'
        ? result.currentRevision !== null
        : result.currentRevision === null,
    'Only a stale or delisted result names the current revision'
  );

const pullRequestHeadShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const getHostedWorkspacePullRequestInput = z.object(workspaceScopedInputFields).strict();

export const hostedWorkspacePullRequestFileEntrySchema = z
  .object({
    path: z.string().min(1).max(4096),
    previousPath: z.string().min(1).max(4096).nullable(),
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patchAvailable: z.boolean(),
  })
  .strict();

export const hostedWorkspacePullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url().max(2048),
    state: z.enum(['open', 'closed']),
    draft: z.boolean(),
    headSha: pullRequestHeadShaSchema,
    baseRef: z.string().min(1).max(1024),
    repository: hostedWorkspaceChangeRepositoryIdentitySchema,
    cacheStale: z.boolean(),
  })
  .strict();

export const getHostedWorkspacePullRequestOutput = z
  .object({
    status: z.enum([
      'linked',
      'not_linked',
      'unverified',
      'credential_required',
      'unavailable',
      'not_github',
    ]),
    workspaceId: cloudAgentWorktreeIdSchema,
    reason: hostedWorkspacePullRequestReasonSchema.nullable(),
    pullRequest: hostedWorkspacePullRequestSchema.nullable(),
    truncated: z.boolean(),
    files: z.array(hostedWorkspacePullRequestFileEntrySchema),
  })
  .strict()
  .refine(
    result => (result.status === 'linked') === (result.pullRequest !== null),
    'Only a linked result carries a pull request'
  )
  .refine(
    result => result.status === 'linked' || result.files.length === 0,
    'Only a linked result carries pull-request files'
  );

export const getHostedWorkspacePullRequestFileInput = z
  .object({
    ...workspaceScopedInputFields,
    path: workspacePathSchema,
    expectedHeadSha: pullRequestHeadShaSchema,
  })
  .strict();

export const getHostedWorkspacePullRequestFileOutput = z
  .object({
    status: z.enum([
      'available',
      'omitted',
      'not_listed',
      'stale',
      'not_linked',
      'unverified',
      'credential_required',
      'unavailable',
      'not_github',
    ]),
    path: workspacePathSchema,
    reason: hostedWorkspacePullRequestReasonSchema.nullable(),
    omissionReason: hostedWorkspacePullRequestFileOmissionReasonSchema.nullable(),
    headSha: pullRequestHeadShaSchema.nullable(),
    patch: z.string().min(1).nullable(),
  })
  .strict()
  .refine(
    result =>
      result.status === 'available'
        ? result.patch !== null && result.omissionReason === null && result.headSha !== null
        : result.status === 'omitted'
          ? result.patch === null && result.omissionReason !== null && result.headSha !== null
          : result.patch === null && result.omissionReason === null,
    'Pull-request file result does not match its status'
  );

export type HostedWorkspaceChangeState = z.infer<typeof hostedWorkspaceChangeStateSchema>;
export type HostedWorkspaceChangeFile = z.infer<typeof hostedWorkspaceChangeFileSchema>;
export type HostedWorkspaceChangeComparison = z.infer<typeof hostedWorkspaceChangeComparisonSchema>;
export type GetHostedWorkspaceChangesOutput = z.infer<typeof getHostedWorkspaceChangesOutput>;
export type GetHostedWorkspacePullRequestOutput = z.infer<
  typeof getHostedWorkspacePullRequestOutput
>;
export type GetHostedWorkspacePullRequestFileOutput = z.infer<
  typeof getHostedWorkspacePullRequestFileOutput
>;
export type HostedWorkspacePullRequestReason = z.infer<
  typeof hostedWorkspacePullRequestReasonSchema
>;
