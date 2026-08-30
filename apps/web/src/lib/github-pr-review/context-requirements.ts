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
    requiredApprovingReviewCount: ContextReadResult<number | null>;
    requiredStatusCheckContexts: ContextReadResult<Array<string | null> | null>;
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
