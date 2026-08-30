import { z } from 'zod';
import { CODE_REVIEW_PLATFORMS } from '../code-review/enums';
import type { RepositoryIdentity, RepositoryReference } from '../code-review/repository-identity';
import { repositoryResourceKey } from '../code-review/repository-identity';

const id = z.string().min(1);
const line = z.number().int().positive();
const side = z.enum(['old', 'new']);
const url = z.url({ protocol: /^https$/ });

// IDs remain opaque. Only adapters interpret provider-native references.
export const ProviderReferenceSchema = z.strictObject({
  provider: z.enum(CODE_REVIEW_PLATFORMS),
  kind: z.enum(['review', 'comment', 'thread', 'reaction', 'merge-task']),
  id,
  url: url.nullable(),
});
export type ProviderReference = z.infer<typeof ProviderReferenceSchema>;
export type ReviewIdentity = RepositoryReference & {
  reviewId: string;
  number: string;
  canonicalUrl: string; // Derived by the authorized server, never an authorization input.
};

export function reviewResourceKey(accountId: string, review: ReviewIdentity): string {
  const { repository, authorization } = review;
  if (repository.provider === 'github' && authorization.kind !== 'githubUser') {
    throw new Error('GitHub review requires user authorization');
  }
  if (
    repository.provider === 'bitbucket' &&
    authorization.kind === 'ownerIntegration' &&
    authorization.owner.type !== 'org'
  ) {
    throw new Error('Bitbucket review requires an organization');
  }
  return JSON.stringify([
    'provider-review:v1',
    repositoryResourceKey(accountId, review),
    id.parse(review.reviewId),
    id.parse(review.number),
  ]);
}

export const ReviewActorSchema = z.strictObject({
  provider: z.enum(CODE_REVIEW_PLATFORMS),
  instanceUrl: url,
  id,
  displayName: z.string().nullable(),
  login: z.string().nullable(),
  avatarUrl: url.nullable(),
});
export type ReviewActor = z.infer<typeof ReviewActorSchema>;
export const ReviewRevisionSchema = z.strictObject({
  headSha: id,
  baseSha: id.nullable(),
  startSha: id.nullable(),
  targetHeadSha: id.nullable(),
});
export type ReviewRevision = z.infer<typeof ReviewRevisionSchema>;
const rangeEnd = z.strictObject({
  lineCode: id,
  side,
  oldLine: line.nullable(),
  newLine: line.nullable(),
});
export const ReviewPositionSchema = z
  .strictObject({
    revision: ReviewRevisionSchema,
    oldPath: id.nullable(),
    newPath: id.nullable(),
    side,
    line,
    startLine: line.optional(),
    startSide: side.optional(),
    native: z.discriminatedUnion('provider', [
      z.strictObject({ provider: z.literal('github') }),
      z.strictObject({
        provider: z.literal('gitlab'),
        oldLine: line.nullable(),
        newLine: line.nullable(),
        lineRange: z.strictObject({ start: rangeEnd, end: rangeEnd }).optional(),
      }),
      z.strictObject({
        provider: z.literal('bitbucket'),
        from: line.optional(),
        to: line.optional(),
        startFrom: line.optional(),
        startTo: line.optional(),
      }),
    ]),
  })
  .refine(
    position =>
      (position.startLine === undefined) === (position.startSide === undefined) &&
      (position.side === 'old' ? position.oldPath !== null : position.newPath !== null) &&
      (position.native.provider !== 'gitlab' ||
        (position.revision.baseSha !== null && position.revision.startSha !== null)),
    'Incomplete review position'
  );
export type ReviewPosition = z.infer<typeof ReviewPositionSchema>;

export const ReviewActionSchema = z.enum([
  'read',
  'comment',
  'inlineComment',
  'reply',
  'submitReview',
  'approve',
  'unapprove',
  'requestChanges',
  'removeChangeRequest',
  'resolveThread',
  'reopenThread',
  'addReaction',
  'removeReaction',
  'merge',
  'deleteBranch',
  'updateBranch',
  'enableAutoMerge',
  'disableAutoMerge',
]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
export const ReviewCapabilitySchema = z
  .strictObject({
    support: z.enum(['supported', 'unsupported', 'unknown']),
    version: z.enum(['available', 'unavailable', 'unknown']),
    license: z.enum(['available', 'unavailable', 'unknown']),
    permission: z.enum(['allowed', 'forbidden', 'unknown']),
    restrictions: z.array(id),
    explanation: z.string(),
    evidenceUrl: url.nullable(),
    recovery: z.enum([
      'none',
      'reconnect',
      'replaceToken',
      'refresh',
      'openProvider',
      'switchOrganization',
    ]),
    expectedHeadProtection: z.enum(['atomicSource', 'revisionAttachment', 'none', 'unknown']),
  })
  .refine(
    value =>
      value.support !== 'unsupported' ||
      (value.evidenceUrl !== null && value.explanation.length > 0),
    'Unsupported capabilities require provider evidence and an explanation'
  );
export type ReviewCapability = z.infer<typeof ReviewCapabilitySchema>;
export const ReviewCapabilitiesSchema = z.record(ReviewActionSchema, ReviewCapabilitySchema);
export type ReviewCapabilities = z.infer<typeof ReviewCapabilitiesSchema>;
export function reviewActionAvailability(capability: ReviewCapability) {
  if (capability.support !== 'supported') return capability.support;
  if (capability.version !== 'available')
    return capability.version === 'unknown' ? 'unknown' : 'version';
  if (capability.license !== 'available')
    return capability.license === 'unknown' ? 'unknown' : 'license';
  if (capability.permission !== 'allowed') return capability.permission;
  return capability.restrictions.length > 0 ? 'restricted' : 'available';
}
export type ReviewAuthorizationContext = {
  actor: ReviewActor;
  credentialKind:
    | 'githubUser'
    | 'gitlabOAuth'
    | 'gitlabPat'
    | 'gitlabProjectToken'
    | 'bitbucketOAuth'
    | 'bitbucketWorkspaceToken';
  capabilities: ReviewCapabilities;
  writeLimits: ReviewWriteLimits;
};

export const ProviderReviewStateSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('github'),
    decision: z.enum(['REVIEW_REQUIRED', 'APPROVED', 'CHANGES_REQUESTED']).nullable(),
  }),
  z.strictObject({
    provider: z.literal('gitlab'),
    approvals: z.strictObject({
      approved: z.boolean().nullable(),
      required: z.number().int().nonnegative().nullable(),
      remaining: z.number().int().nonnegative().nullable(),
      actorIds: z.array(id),
    }),
    requestedChanges: z.strictObject({
      actorIds: z.array(id),
      blocksMerge: z.boolean().nullable(),
      blockingCapability: ReviewCapabilitySchema,
    }),
  }),
  z.strictObject({
    provider: z.literal('bitbucket'),
    expectedHeadProtection: z.literal('none'),
    participants: z.array(
      z.strictObject({
        actor: ReviewActorSchema,
        role: id,
        state: z.enum(['approved', 'changes_requested']).nullable(),
        participatedOn: z.string().nullable(),
      })
    ),
  }),
]);
export const BitbucketMergeTaskSchema = z.strictObject({
  reference: ProviderReferenceSchema.extend({
    provider: z.literal('bitbucket'),
    kind: z.literal('merge-task'),
  }),
  state: z.enum(['pending', 'success', 'failed']),
  mergeCommitSha: id.nullable(),
  error: z.string().nullable(),
});
export type BitbucketMergeTask = z.infer<typeof BitbucketMergeTaskSchema>;

const bitbucketMergeEndpoint = z.strictObject({
  repositoryId: z.uuid(),
  workspaceUuid: z.uuid(),
  fullName: id.max(511),
  branch: id.max(4096),
});
// Server-observed preflight evidence lives beside the ledger result, never in the write intent.
// Old ledger rows omit it until their 30-day retention expires; absence cannot confirm a merge.
export const BitbucketMergeEvidenceSchema = z.strictObject({
  source: bitbucketMergeEndpoint,
  destination: bitbucketMergeEndpoint,
});
export type BitbucketMergeEvidence = z.infer<typeof BitbucketMergeEvidenceSchema>;

export const ReviewCheckSchema = z.strictObject({
  id,
  name: id,
  state: z.enum(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled', 'unknown']),
  required: z.boolean().nullable(),
  detailsUrl: url.nullable(),
});
export const ReviewChecksSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none'), checks: z.tuple([]) }),
  z.strictObject({ status: z.literal('unavailable'), explanation: id }),
  z.strictObject({ status: z.literal('reported'), checks: z.array(ReviewCheckSchema).min(1) }),
]);

export type ReviewPageScope = {
  resourceKey: string;
  surface: 'inbox' | 'files' | 'context' | 'checks' | 'threads';
  queryKey: string;
  revision: ReviewRevision | null;
};
export const ReviewCursorSchema = z.strictObject({ scopeKey: id, token: id.max(4096) });
export type ReviewCursor = z.infer<typeof ReviewCursorSchema>;
export type ReviewPage<T> = { items: T[]; nextCursor: ReviewCursor | null };
export function reviewPageKey(scope: ReviewPageScope): string {
  return JSON.stringify([
    'provider-review-page:v1',
    id.parse(scope.resourceKey),
    scope.surface,
    id.parse(scope.queryKey),
    scope.revision === null ? null : ReviewRevisionSchema.parse(scope.revision),
  ]);
}
// Parse persisted or client-supplied cursors, not trusted provider page objects.
export function parseReviewCursor(value: unknown, scope: ReviewPageScope): ReviewCursor {
  const cursor = ReviewCursorSchema.parse(value);
  if (cursor.scopeKey !== reviewPageKey(scope)) throw new Error('Pagination identity mismatch');
  return cursor;
}

export type ReviewFile = {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  revision: ReviewRevision;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'changed';
  patch: string | null;
  content: 'available' | 'binary' | 'truncated' | 'unavailable';
  // Line additions/deletions: null means unavailable; numeric zero means confirmed zero.
  additions: number | null;
  deletions: number | null;
  canonicalUrl: string | null;
};
export type ReviewFileContext = {
  revision: ReviewRevision;
  path: string;
  side: 'old' | 'new';
  startLine: number;
  lines: string[];
  totalLines: number | null;
  content: ReviewFile['content'];
  canonicalUrl: string | null;
};
export type ReviewComment = {
  id: string;
  reference: ProviderReference;
  author: ReviewActor | null;
  bodyMarkdown: string;
  createdAt: string;
  reactions: { id: string; content: string; count: number; viewerHasReacted: boolean }[];
};
export type ReviewThread = {
  id: string;
  reference: ProviderReference;
  subjectType: 'line' | 'file' | 'conversation';
  file: Pick<ReviewFile, 'oldPath' | 'newPath' | 'revision'> | null;
  position: ReviewPosition | null;
  diffHunk: string | null;
  resolved: boolean | null;
  outdated: boolean | null;
  comments: ReviewPage<ReviewComment>;
  capabilities: Partial<ReviewCapabilities>;
};
export type ReviewOverview = {
  identity: ReviewIdentity;
  title: string;
  bodyMarkdown: string | null;
  author: ReviewActor | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  revision: ReviewRevision;
  source: { repository: RepositoryIdentity | null; branch: string | null };
  target: { repository: RepositoryIdentity; branch: string };
  authorization: ReviewAuthorizationContext;
  providerState: z.infer<typeof ProviderReviewStateSchema>;
  checks: z.infer<typeof ReviewChecksSchema>;
  // Line additions/deletions: null means unavailable; numeric zero means confirmed zero.
  counts: { commits: number; files: number; additions: number | null; deletions: number | null };
  merge: {
    methods: { id: string; label: string }[];
    squash: 'required' | 'optional' | 'forbidden' | null;
    autoMerge: { method: string } | null;
    task: BitbucketMergeTask | null;
  };
};
export type ReviewInboxItem = Pick<
  ReviewOverview,
  'identity' | 'title' | 'author' | 'state' | 'draft'
> & {
  updatedAt: string;
};
export type ReviewInbox = ReviewPage<ReviewInboxItem> & {
  scope:
    | { kind: 'actor'; actor: ReviewActor }
    | { kind: 'repository'; actor: ReviewActor; repository: RepositoryIdentity };
};

export const ReviewEffectResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('confirmed'),
    reference: ProviderReferenceSchema.nullable(),
    retry: z.literal('never'),
    reconciliation: z.literal('complete'),
  }),
  z.strictObject({
    status: z.literal('accepted'),
    reference: ProviderReferenceSchema,
    task: BitbucketMergeTaskSchema.nullable(),
    retry: z.literal('reconcile'),
    reconciliation: z.literal('pending'),
  }),
  z.strictObject({
    status: z.literal('unresolved'),
    reference: ProviderReferenceSchema.nullable(),
    reason: id,
    retry: z.literal('reconcile'),
    reconciliation: z.literal('required'),
  }),
  z.strictObject({
    status: z.literal('rejected'),
    code: id,
    explanation: id,
    retry: z.enum(['same-key', 'never']),
    reconciliation: z.literal('not-needed'),
  }),
]);
export const ReviewMutationResultSchema = z.union([
  ReviewEffectResultSchema,
  z.strictObject({
    status: z.literal('partial'),
    items: z
      .array(
        z.strictObject({ itemId: id, effect: ReviewActionSchema, result: ReviewEffectResultSchema })
      )
      .min(1),
    retry: z.literal('unfinished-only'),
    reconciliation: z.literal('required'),
  }),
]);
export type ReviewMutationResult = z.infer<typeof ReviewMutationResultSchema>;

// Only the new interactive transport uses this limit. Legacy endpoints retain their limits.
export const REVIEW_WRITE_REQUEST_MAX_BYTES = 256_000;
export type ReviewWriteLimits = { requestMaxBytes: number; bodyMaxBytes: number | null };
export function serializeReviewWriteRequest(value: unknown): string {
  const serialized = z.string().parse(JSON.stringify(value));
  // JSON escapes lone surrogates. Each URI escape represents one UTF-8 byte, without a platform encoder.
  const bytes = encodeURIComponent(serialized).replace(/%[0-9A-F]{2}/g, 'x').length;
  if (bytes > REVIEW_WRITE_REQUEST_MAX_BYTES) {
    throw new Error('Review request exceeds the serialized byte limit');
  }
  return serialized;
}
