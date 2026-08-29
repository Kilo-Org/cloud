import 'server-only';

import { z } from 'zod';

export const GitHubPrReviewTimestampSchema = z.string().datetime({ offset: true });
const nullableTimestamp = GitHubPrReviewTimestampSchema.nullable();
const nullableId = z.string().min(1).nullable();

export const GitHubPrReviewSourceSchema = z
  .object({
    availability: z.enum(['available', 'partial', 'denied', 'unavailable', 'stale']),
    retryable: z.boolean(),
    provenance: z.array(z.string().min(1)),
    reason: z.string().nullable(),
    observedAt: nullableTimestamp,
  })
  .strict();
export type GitHubPrReviewSource = z.infer<typeof GitHubPrReviewSourceSchema>;

export const unavailablePrReviewSource = (): GitHubPrReviewSource => ({
  availability: 'unavailable',
  retryable: false,
  provenance: [],
  reason: 'not-requested',
  observedAt: null,
});

export function githubPrReviewCollectionSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      source: GitHubPrReviewSourceSchema,
      items: z.array(item),
      completeness: z.enum(['complete', 'partial', 'unknown']),
      knownCount: z.number().int().nonnegative(),
      totalCount: z.number().int().nonnegative().nullable(),
      hasNextPage: z.boolean().nullable(),
      endCursor: z.string().nullable(),
    })
    .strict()
    .default(() => ({
      source: unavailablePrReviewSource(),
      items: [],
      completeness: 'unknown' as const,
      knownCount: 0,
      totalCount: null,
      hasNextPage: null,
      endCursor: null,
    }));
}

export const GitHubPrReviewRevisionSchema = z
  .object({
    prNodeId: z.string().min(1),
    number: z.number().int().positive(),
    headSha: z.string().min(1),
    baseRepoFullName: nullableId,
    baseRef: z.string(),
    baseSha: nullableId,
  })
  .strict();
export type GitHubPrReviewRevision = z.infer<typeof GitHubPrReviewRevisionSchema>;

export const GitHubPrReviewIdentitySchema = z
  .object({
    id: nullableId,
    kind: z.enum(['User', 'Team', 'Bot', 'Mannequin', 'Unavailable']),
    login: z.string().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
    url: z.string().url().nullable(),
    teamSlug: z.string().nullable(),
  })
  .strict();
export type GitHubPrReviewIdentity = z.infer<typeof GitHubPrReviewIdentitySchema>;

export const GitHubPrReviewLabelSchema = z
  .object({
    id: nullableId,
    name: z.string(),
    color: z.string().nullable(),
  })
  .strict();

export const GitHubPrReviewSubmissionSchema = z
  .object({
    id: z.string().min(1),
    actor: GitHubPrReviewIdentitySchema.nullable(),
    state: z.enum([
      'APPROVED',
      'CHANGES_REQUESTED',
      'COMMENTED',
      'DISMISSED',
      'PENDING',
      'UNKNOWN',
    ]),
    submittedAt: nullableTimestamp,
    commitSha: nullableId,
    onBehalfOf: githubPrReviewCollectionSchema(GitHubPrReviewIdentitySchema.nullable()),
  })
  .strict();

export const GitHubPrReviewIssueSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(['OPEN', 'CLOSED']),
    repository: z.string().min(1),
    url: z.string().url().nullable(),
    relationships: z.array(
      z
        .object({
          category: z.enum(['closing', 'connected', 'referenced', 'duplicate']),
          membership: z.enum(['current', 'historical']),
          evidenceId: z.string().min(1),
          sourceId: z.string().min(1),
          targetId: z.string().min(1),
        })
        .strict()
    ),
  })
  .strict();

export const GitHubPrReviewEvidenceSchema = z
  .object({
    source: z.string().min(1),
    policyId: nullableId,
    observation: z.string().min(1),
    headSha: nullableId,
    baseSha: nullableId,
    evaluatedSha: nullableId,
    observedAt: nullableTimestamp,
  })
  .strict();

const checkKind = z.enum(['check-run', 'status', 'unknown']);
export const GitHubPrReviewApplicationBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app'), appId: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('any') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);

export const GitHubPrReviewRequirementSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string(),
    state: z.enum(['met', 'unmet', 'unavailable']),
    policy: z
      .object({
        id: z.string().min(1),
        source: z.enum(['classic', 'ruleset', 'github']),
        enforcement: z.enum(['active', 'evaluate', 'disabled', 'unknown']),
      })
      .strict()
      .nullable(),
    check: z
      .object({
        name: z.string().min(1),
        kind: checkKind,
        application: GitHubPrReviewApplicationBindingSchema,
      })
      .strict()
      .nullable(),
    evidence: z.array(GitHubPrReviewEvidenceSchema),
  })
  .strict();

export const GitHubPrReviewContextCheckSchema = z
  .object({
    id: nullableId,
    name: z.string().min(1),
    kind: checkKind,
    application: z
      .object({
        id: z.number().int().positive().nullable(),
        nodeId: nullableId,
        slug: z.string().nullable(),
        name: z.string().nullable(),
      })
      .strict()
      .nullable(),
    outcome: z.enum(['success', 'failure', 'pending', 'skipped', 'unknown']),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    requiredness: z.enum(['required', 'optional', 'unknown']),
    observation: z.enum(['observed', 'missing', 'unknown']),
    evaluatedSha: nullableId,
    detailsUrl: z.string().url().nullable(),
    evidence: z.array(GitHubPrReviewEvidenceSchema),
  })
  .strict();

export const GitHubPrReviewLifecycleSchema = z
  .object({
    source: GitHubPrReviewSourceSchema,
    openedAt: nullableTimestamp,
    updatedAt: nullableTimestamp,
    closedAt: nullableTimestamp,
    mergedAt: nullableTimestamp,
  })
  .strict();

export const GitHubPrReviewQueueSchema = z
  .object({
    membership: z
      .object({
        source: GitHubPrReviewSourceSchema,
        state: z.enum(['queued', 'not-queued', 'unknown']),
        entryId: nullableId,
      })
      .strict(),
    position: z
      .object({
        source: GitHubPrReviewSourceSchema,
        entryId: nullableId,
        prNodeId: nullableId,
        value: z.number().int().nonnegative().nullable(),
        state: z
          .enum(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED', 'UNMERGEABLE'])
          .nullable(),
        enqueuedAt: nullableTimestamp,
      })
      .strict(),
  })
  .strict();

// Old context payloads omit sources. Retain defaults until all old clients, servers, and records are gone.
// Missing sources never establish an empty collection.
export const GitHubPrReviewContextSchema = z
  .object({
    revision: GitHubPrReviewRevisionSchema,
    observedAt: nullableTimestamp.default(null),
    evaluatedShas: z.array(z.string().min(1)).default(() => []),
    labels: githubPrReviewCollectionSchema(GitHubPrReviewLabelSchema),
    assignees: githubPrReviewCollectionSchema(GitHubPrReviewIdentitySchema.nullable()),
    reviewRequests: githubPrReviewCollectionSchema(
      z
        .object({
          id: nullableId,
          reviewer: GitHubPrReviewIdentitySchema.nullable(),
        })
        .strict()
    ),
    reviewDecisions: githubPrReviewCollectionSchema(GitHubPrReviewSubmissionSchema),
    reviewActivity: githubPrReviewCollectionSchema(GitHubPrReviewSubmissionSchema),
    lifecycle: GitHubPrReviewLifecycleSchema.default(() => ({
      source: unavailablePrReviewSource(),
      openedAt: null,
      updatedAt: null,
      closedAt: null,
      mergedAt: null,
    })),
    merger: z
      .object({
        source: GitHubPrReviewSourceSchema,
        identity: GitHubPrReviewIdentitySchema.nullable(),
      })
      .strict()
      .default(() => ({ source: unavailablePrReviewSource(), identity: null })),
    issues: githubPrReviewCollectionSchema(GitHubPrReviewIssueSchema),
    // Completeness covers supported PR-side sources, not every outgoing or inaccessible link.
    issueCoverage: z.literal('supported-pr-sources').default('supported-pr-sources'),
    requirements: githubPrReviewCollectionSchema(GitHubPrReviewRequirementSchema),
    checks: githubPrReviewCollectionSchema(GitHubPrReviewContextCheckSchema),
    queue: GitHubPrReviewQueueSchema.default(() => ({
      membership: { source: unavailablePrReviewSource(), state: 'unknown' as const, entryId: null },
      position: {
        source: unavailablePrReviewSource(),
        entryId: null,
        prNodeId: null,
        value: null,
        state: null,
        enqueuedAt: null,
      },
    })),
  })
  .strict();
export type GitHubPrReviewContext = z.infer<typeof GitHubPrReviewContextSchema>;
