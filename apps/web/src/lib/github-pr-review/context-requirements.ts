import 'server-only';

import { z } from 'zod';
import type {
  GitHubPrReviewContext,
  GitHubPrReviewRevision,
  GitHubPrReviewSource,
} from './context-dtos';
import type { ContextReadResult } from './context-reader';

type Check = GitHubPrReviewContext['checks']['items'][number];
type Requirement = GitHubPrReviewContext['requirements']['items'][number];
export type RequirementCollection<T> = Omit<GitHubPrReviewContext['checks'], 'items'> & {
  items: T[];
};

export const PR_CONTEXT_EVALUATION_QUERY = /* GraphQL */ `
  query PrReviewContextEvaluation($owner: String!, $name: String!, $number: Int!, $head: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id number headRefOid baseRefName baseRefOid baseRepository { nameWithOwner }
        mergeable
        viewerCanMergeAsAdmin
        potentialMergeCommit { oid parents(first: 2) { totalCount nodes { oid } } }
        baseRef {
          refUpdateRule { requiredApprovingReviewCount requiredStatusCheckContexts requiresConversationResolution }
          compare(headRef: $head) { behindBy baseTarget { oid } headTarget { oid } }
        }
      }
    }
  }
`;

export const PR_CONTEXT_REQUIREMENT_QUERIES = {
  checks: /* GraphQL */ `
    query PrReviewContextChecks($owner: String!, $name: String!, $oid: String!, $pr: ID!, $after: String) {
      repository(owner: $owner, name: $name) {
        object(expression: $oid) {
          ... on Commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                totalCount pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun {
                    id name status conclusion detailsUrl isRequired(pullRequestId: $pr)
                    checkSuite { commit { oid } app { databaseId id slug name } }
                  }
                  ... on StatusContext {
                    id context state targetUrl isRequired(pullRequestId: $pr) commit { oid }
                  }
                }
              }
            }
          }
        }
      }
    }
  `,
  reviewThreads: /* GraphQL */ `
    query PrReviewContextThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            totalCount pageInfo { hasNextPage endCursor } nodes { id isResolved }
          }
        }
      }
    }
  `,
  eligibleReviews: /* GraphQL */ `
    query PrReviewContextEligibleReviews($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          eligibleReviews: latestOpinionatedReviews(first: 100, after: $after, writersOnly: true) {
            totalCount pageInfo { hasNextPage endCursor }
            nodes {
              id state submittedAt commit { oid }
              author {
                __typename
                ... on User { id login name avatarUrl url }
                ... on Bot { id login avatarUrl url }
                ... on Mannequin { id login avatarUrl url }
              }
            }
          }
        }
      }
    }
  `,
  deployments: /* GraphQL */ `
    query PrReviewContextDeployments($owner: String!, $name: String!, $oid: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        object(expression: $oid) {
          ... on Commit {
            oid
            deployments(first: 100, after: $after) {
              totalCount pageInfo { hasNextPage endCursor }
              nodes { id commitOid environment latestStatus { state } }
            }
          }
        }
      }
    }
  `,
};

const oidSchema = z.object({ oid: z.string().min(1) });
export const contextTestMergeSchema = oidSchema
  .extend({
    parents: z
      .object({ totalCount: z.literal(2), nodes: z.array(oidSchema).length(2) })
      .nullable()
      .catch(null),
  })
  .nullable();
export const contextComparisonSchema = z
  .object({
    behindBy: z.number().int().nonnegative(),
    baseTarget: oidSchema,
    headTarget: oidSchema,
  })
  .nullable();
export const contextThreadSchema = z.object({
  id: z.string().min(1),
  isResolved: z.boolean().nullable().catch(null),
});
export const contextDeploymentSchema = z.object({
  id: z.string().min(1),
  commitOid: z.string().min(1),
  environment: z.string().nullable(),
  latestStatus: z.object({ state: z.string() }).nullable(),
});
const applicationSchema = z
  .object({
    databaseId: z.number().int().positive().nullable().catch(null),
    id: z.string().min(1).nullable().catch(null),
    slug: z.string().nullable().catch(null),
    name: z.string().nullable().catch(null),
  })
  .nullable()
  .catch(null);
const checkFields = {
  id: z.string().min(1),
  isRequired: z.boolean().nullable().catch(null),
};
export const contextCheckSchema = z
  .discriminatedUnion('__typename', [
    z.object({
      ...checkFields,
      __typename: z.literal('CheckRun'),
      name: z.string().min(1),
      status: z.string().nullable().catch(null),
      conclusion: z.string().nullable().catch(null),
      detailsUrl: z.string().url().nullable().catch(null),
      checkSuite: z
        .object({
          app: applicationSchema,
          commit: oidSchema.nullable().catch(null),
        })
        .nullable()
        .catch(null),
    }),
    z.object({
      ...checkFields,
      __typename: z.literal('StatusContext'),
      context: z.string().min(1),
      state: z.string().nullable().catch(null),
      targetUrl: z.string().url().nullable().catch(null),
      commit: oidSchema.nullable().catch(null),
    }),
  ])
  .transform((node): Check => {
    const run = node.__typename === 'CheckRun';
    const app = run ? node.checkSuite?.app : null;
    const kind = run ? 'check-run' : 'status';
    const status = run ? node.status : node.state;
    const conclusion = run ? node.conclusion : null;
    return {
      id: node.id,
      name: run ? node.name : node.context,
      kind,
      application: app
        ? { id: app.databaseId, nodeId: app.id, slug: app.slug, name: app.name }
        : null,
      outcome: contextCheckOutcome(kind, status, conclusion),
      status,
      conclusion,
      requiredness:
        node.isRequired === true ? 'required' : node.isRequired === false ? 'optional' : 'unknown',
      observation: 'observed',
      evaluatedSha: (run ? node.checkSuite?.commit?.oid : node.commit?.oid) ?? null,
      detailsUrl: run ? node.detailsUrl : node.targetUrl,
      evidence: [],
    };
  });

export function contextCheckOutcome(
  kind: Check['kind'],
  status: string | null,
  conclusion: string | null
): Check['outcome'] {
  if (kind === 'status') {
    return status === 'SUCCESS'
      ? 'success'
      : status === 'FAILURE' || status === 'ERROR'
        ? 'failure'
        : status === 'PENDING' || status === 'EXPECTED'
          ? 'pending'
          : 'unknown';
  }
  if (status === 'COMPLETED') {
    if (conclusion === 'SUCCESS') return 'success';
    if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'skipped';
    if (
      ['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(
        conclusion ?? ''
      )
    )
      return 'failure';
    return 'unknown';
  }
  return ['QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING', 'PENDING'].includes(status ?? '')
    ? 'pending'
    : 'unknown';
}

export type RequirementFacts = {
  mergeable: ContextReadResult<'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'>;
  testMerge: ContextReadResult<z.output<typeof contextTestMergeSchema>>;
  comparison: ContextReadResult<z.output<typeof contextComparisonSchema>>;
  viewerRule: {
    requiredApprovingReviewCount: ContextReadResult<number>;
    requiredStatusCheckContexts: ContextReadResult<Array<string | null>>;
    requiresConversationResolution: ContextReadResult<boolean>;
  };
  canBypassClassic: ContextReadResult<boolean>;
};
export type RequirementObservations = {
  head: GitHubPrReviewContext['checks'];
  merge: GitHubPrReviewContext['checks'] | null;
  threads: RequirementCollection<z.output<typeof contextThreadSchema>>;
  eligibleReviews: GitHubPrReviewContext['reviewDecisions'];
  deployments: RequirementCollection<z.output<typeof contextDeploymentSchema>>;
};

const objectSchema = z.record(z.string(), z.json());
const object = (value: unknown): z.output<typeof objectSchema> =>
  objectSchema.safeParse(value).data ?? {};

export function contextRequirementEvidence(
  revision: GitHubPrReviewRevision,
  source: GitHubPrReviewSource,
  observation: string,
  evaluatedSha: string | null,
  policyId: string | null = null
): Requirement['evidence'] {
  return source.provenance.map(provenance => ({
    source: provenance,
    policyId,
    observation,
    headSha: revision.headSha,
    baseSha: revision.baseSha,
    evaluatedSha,
    observedAt: source.observedAt,
  }));
}

const reviewFlags = [
  [
    'require_code_owner_reviews',
    'require_code_owner_review',
    'code-owner-reviews',
    'Code owner reviews',
  ],
  [
    'require_last_push_approval',
    'require_last_push_approval',
    'last-push-approval',
    'Approval of the last push',
  ],
  [
    'dismiss_stale_reviews',
    'dismiss_stale_reviews_on_push',
    'stale-review-dismissal',
    'Stale review dismissal',
  ],
] as const;

export function expandPolicy(item: Requirement): Requirement[] {
  if (item.check || !item.policy) return [item];
  const { policy } = item;
  const parameters: z.output<typeof objectSchema> = policy.parameters ?? {};
  const classic = policy.source === 'classic';
  const rows: Requirement[] = [];
  const add = (kind: string, title: string) =>
    rows.push({ ...item, id: `${item.id}:${kind}:${title}`, kind, title });
  const status: z.output<typeof objectSchema> = classic
    ? object(parameters.required_status_checks)
    : policy.ruleType === 'required_status_checks'
      ? parameters
      : {};
  const checkListSchema = z.array(z.object({ context: z.string().min(1) }));
  const supportedStatus = (
    classic
      ? z
          .object({
            strict: z.boolean(),
            checks: checkListSchema,
            contexts: z.array(z.string().min(1)),
            url: z.string().optional(),
            contexts_url: z.string().optional(),
            enforcement_level: z.string().optional(),
          })
          .strict()
      : z
          .object({
            strict_required_status_checks_policy: z.boolean(),
            required_status_checks: checkListSchema,
            do_not_enforce_on_create: z.boolean().optional(),
          })
          .strict()
  ).safeParse(status).success;
  const checks = classic ? status.checks : status.required_status_checks;
  const emptyChecks =
    Array.isArray(checks) &&
    checks.length === 0 &&
    (!classic || (Array.isArray(status.contexts) && status.contexts.length === 0));
  const strict = classic ? status.strict : status.strict_required_status_checks_policy;
  if (strict === true && !emptyChecks) add('branch-freshness', 'Branch must be up to date');
  if (
    (classic
      ? parameters.required_status_checks != null
      : policy.ruleType === 'required_status_checks') &&
    !supportedStatus
  )
    add('status-policy', 'Required status check policy');
  const reviews: z.output<typeof objectSchema> = classic
    ? object(parameters.required_pull_request_reviews)
    : policy.ruleType === 'pull_request'
      ? parameters
      : {};
  const reviewCount = z
    .number()
    .int()
    .nonnegative()
    .safeParse(reviews.required_approving_review_count);
  if (
    (classic
      ? parameters.required_pull_request_reviews != null
      : policy.ruleType === 'pull_request') &&
    (!reviewCount.success || reviewCount.data > 0)
  )
    add('approving-reviews', 'Required approving reviews');
  for (const [classicField, rulesetField, kind, title] of reviewFlags)
    if (reviews[classic ? classicField : rulesetField] === true) add(kind, title);
  if (
    Object.keys(reviews).length &&
    reviewFlags.some(
      ([classicField, rulesetField]) =>
        typeof reviews[classic ? classicField : rulesetField] !== 'boolean'
    )
  )
    add('review-policy', 'Review requirements');
  if (
    (classic &&
      Object.hasOwn(parameters, 'required_conversation_resolution') &&
      parameters.required_conversation_resolution !== false &&
      object(parameters.required_conversation_resolution).enabled !== false) ||
    reviews.required_review_thread_resolution === true
  )
    add('conversation-resolution', 'Resolved review conversations');
  if (!classic && policy.ruleType === 'pull_request' && parameters.allowed_merge_methods != null)
    add('allowed-merge-methods', 'Allowed merge methods');
  const environments = classic
    ? object(parameters.required_deployments).required_deployment_environments
    : policy.ruleType === 'required_deployments'
      ? parameters.required_deployment_environments
      : undefined;
  const parsedEnvironments = z.array(z.string().min(1)).safeParse(environments);
  if (parsedEnvironments.success) {
    for (const environment of new Set(parsedEnvironments.data)) add('deployment', environment);
  } else if (classic && parameters.required_deployments != null) {
    add('deployment-policy', 'Required deployment policy');
  }
  if (classic) {
    for (const [field, kind, title] of [
      ['required_signatures', 'commit-signatures', 'Signed commits'],
      ['required_linear_history', 'linear-history', 'Linear history'],
      ['lock_branch', 'locked-branch', 'Unlocked branch'],
      ['block_creations', 'branch-creation', 'Branch creation restrictions'],
    ] as const)
      if (
        Object.hasOwn(parameters, field) &&
        parameters[field] !== false &&
        object(parameters[field]).enabled !== false
      )
        add(kind, title);
    if (parameters.restrictions != null) add('push-restrictions', 'Push restrictions');
    const known = new Set([
      'url',
      'name',
      'protection_url',
      'required_status_checks',
      'required_pull_request_reviews',
      'required_conversation_resolution',
      'required_deployments',
      'required_signatures',
      'required_linear_history',
      'lock_branch',
      'block_creations',
      'restrictions',
      'enforce_admins',
      'allow_force_pushes',
      'allow_deletions',
      'allow_fork_syncing',
    ]);
    for (const key of Object.keys(parameters)) if (!known.has(key)) add(key, key);
  }
  // Check descriptions are separate rows; do not keep an unevaluated umbrella for them.
  return rows.length || supportedStatus ? rows : [item];
}
