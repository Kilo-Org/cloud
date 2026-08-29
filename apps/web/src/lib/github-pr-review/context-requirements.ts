import 'server-only';

import { z } from 'zod';
import {
  GitHubPrReviewPolicySchema,
  type GitHubPrReviewContext,
  type GitHubPrReviewRevision,
  type GitHubPrReviewSource,
} from './context-dtos';
import type { ContextReadResult } from './context-reader';

type Check = GitHubPrReviewContext['checks']['items'][number];
type Requirement = GitHubPrReviewContext['requirements']['items'][number];
type Policy = NonNullable<Requirement['policy']>;
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

const complete = <T>(collection: RequirementCollection<T>) =>
  collection.source.availability === 'available' &&
  collection.completeness === 'complete' &&
  collection.hasNextPage === false &&
  collection.knownCount === collection.items.length &&
  collection.totalCount === collection.items.length;
const available = <T>(field: ContextReadResult<T>) => field.source.availability === 'available';
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

export function evaluateContextRequirements(
  context: GitHubPrReviewContext,
  facts: RequirementFacts,
  observations: RequirementObservations
): Pick<GitHubPrReviewContext, 'checks' | 'requirements' | 'evaluatedShas'> {
  const { revision } = context;
  const { head, merge } = observations;
  const testMerge = facts.testMerge.data;
  const validMerge =
    available(facts.testMerge) &&
    (!testMerge ||
      (testMerge.parents?.nodes.some(parent => parent.oid === revision.headSha) &&
        testMerge.parents?.nodes.some(parent => parent.oid === revision.baseSha)));
  // GitHub documents status-based selection, not check-run-only or per-context fallback.
  const selected = !validMerge
    ? null
    : !testMerge
      ? head
      : merge?.items.some(
            check =>
              check.kind === 'status' &&
              check.evaluatedSha === testMerge.oid &&
              check.observation === 'observed'
          )
        ? merge
        : merge && complete(merge) && merge.items.length === 0
          ? head
          : null;
  const selectedSha =
    selected === head ? revision.headSha : selected ? (testMerge?.oid ?? null) : null;
  const collections = [head, ...(merge ? [merge] : [])];
  const allChecks = collections.flatMap(collection => collection.items);
  const currentPolicy = (policy: Policy | null): policy is Policy =>
    Boolean(
      policy &&
      policy.enforcement === 'active' &&
      policy.base?.baseRepoFullName === revision.baseRepoFullName &&
      policy.base?.baseRef === revision.baseRef &&
      policy.base?.baseSha === revision.baseSha
    );
  const classicEnforced =
    available(facts.canBypassClassic) && facts.canBypassClassic.data === false;
  const enforced = (policy: Policy, checkName?: string) =>
    currentPolicy(policy) &&
    ((policy.viewerEnforcement === 'enforced' && policy.viewerBypass === 'never') ||
      (policy.source === 'classic' && classicEnforced)) &&
    (!checkName ||
      policy.source !== 'classic' ||
      (available(facts.viewerRule.requiredStatusCheckContexts) &&
        facts.viewerRule.requiredStatusCheckContexts.data?.includes(checkName) === true));
  const evidence = (
    source: GitHubPrReviewSource,
    observation: string,
    sha = revision.headSha,
    policyId: string | null = null
  ) => contextRequirementEvidence(revision, source, observation, sha, policyId);
  const githubPolicy = (id: string, ruleType: string) =>
    GitHubPrReviewPolicySchema.parse({
      id,
      source: 'github',
      enforcement: 'active',
      ruleType,
      base: {
        baseRepoFullName: revision.baseRepoFullName,
        baseRef: revision.baseRef,
        baseSha: revision.baseSha,
      },
      viewerEnforcement: 'enforced',
      viewerBypass: 'never',
    });
  const items: Requirement[] = [];
  const record = (
    row: Requirement,
    state: Requirement['state'],
    source: GitHubPrReviewSource,
    observation: string,
    sha = revision.headSha
  ) => {
    const policy = row.policy;
    return {
      ...row,
      state: currentPolicy(policy) ? state : ('unavailable' as const),
      policy:
        policy && enforced(policy)
          ? { ...policy, viewerEnforcement: 'enforced' as const, viewerBypass: 'never' as const }
          : policy,
      evidence: [...row.evidence, ...evidence(source, observation, sha, policy?.id ?? null)],
    };
  };
  const sameCheckSource = (left: Check, right: Check) => {
    if (left.name !== right.name || left.kind !== right.kind) return false;
    const numeric = left.application?.id != null && right.application?.id != null;
    const node = left.application?.nodeId != null && right.application?.nodeId != null;
    return (
      (numeric && left.application?.id === right.application?.id) ||
      (node && left.application?.nodeId === right.application?.nodeId) ||
      (!numeric && !node)
    );
  };
  const checkState = (check: Check): Requirement['state'] => {
    const currentEvidence = check.evidence.filter(
      entry =>
        entry.headSha === revision.headSha &&
        entry.baseSha === revision.baseSha &&
        entry.evaluatedSha === selectedSha &&
        entry.observedAt !== null
    );
    if (
      !selected ||
      !['available', 'partial'].includes(selected.source.availability) ||
      check.evaluatedSha !== selectedSha ||
      check.kind === 'unknown' ||
      check.observation !== 'observed' ||
      check.requiredness !== 'required' ||
      !currentEvidence.some(
        entry =>
          entry.source === 'graphql.checks.isRequired' &&
          entry.observation === 'isRequired:required'
      ) ||
      !currentEvidence.some(
        entry =>
          entry.source === 'graphql.checks' &&
          entry.observation.startsWith(`check:${check.id}:${check.outcome}`)
      ) ||
      selected.items.filter(other => sameCheckSource(check, other)).length !== 1
    )
      return 'unavailable';
    return check.outcome === 'success' || check.outcome === 'skipped'
      ? 'met'
      : check.outcome === 'failure' || check.outcome === 'pending'
        ? 'unmet'
        : 'unavailable';
  };
  const covered = new Set<Check>();
  for (const row of context.requirements.items.flatMap(expandPolicy)) {
    const policy = row.policy;
    if (!currentPolicy(policy)) {
      items.push({ ...row, state: 'unavailable' });
      continue;
    }
    if (row.check) {
      const binding = row.check.application;
      const named = selected?.items.filter(check => check.name === row.check?.name) ?? [];
      const matching = named.filter(
        check =>
          binding.kind === 'any' ||
          (binding.kind === 'app' && check.application?.id === binding.appId)
      );
      if (matching.length) {
        for (const check of matching) {
          covered.add(check);
          items.push({
            ...record(
              {
                ...row,
                id: `${row.id}:${check.kind}:${check.id}`,
                check: { ...row.check, kind: check.kind },
              },
              enforced(policy, row.check.name) ? checkState(check) : 'unavailable',
              selected?.source ?? head.source,
              `check:${check.id}:${check.outcome}`,
              check.evaluatedSha ?? revision.headSha
            ),
            evidence: [
              ...row.evidence,
              ...check.evidence.map(entry => ({ ...entry, policyId: policy.id })),
            ],
          });
        }
      } else {
        const headFallback =
          selected === merge && head.items.some(check => check.name === row.check?.name);
        const unresolvedIdentity = named.some(
          check => check.kind === 'status' || check.application?.id == null
        );
        const missing =
          binding.kind !== 'unknown' &&
          !headFallback &&
          !unresolvedIdentity &&
          enforced(policy, row.check.name) &&
          complete(context.requirements) &&
          complete(head) &&
          Boolean(selected && complete(selected)) &&
          (!testMerge || Boolean(merge && complete(merge)));
        items.push(
          record(
            row,
            missing ? 'unmet' : 'unavailable',
            selected?.source ?? head.source,
            missing
              ? 'required-check-missing:complete-policy-and-observations'
              : 'check-source-or-application-unavailable',
            selectedSha ?? revision.headSha
          )
        );
        if (missing)
          allChecks.push({
            id: null,
            name: row.check.name,
            kind: row.check.kind,
            application:
              binding.kind === 'app'
                ? { id: binding.appId, nodeId: null, slug: null, name: null }
                : null,
            outcome: 'pending',
            status: null,
            conclusion: null,
            requiredness: 'required',
            observation: 'missing',
            evaluatedSha: selectedSha,
            detailsUrl: null,
            evidence: items[items.length - 1]?.evidence ?? [],
          });
      }
      continue;
    }
    items.push({ ...row, state: 'unavailable' });
  }
  for (const check of (selected?.items ?? allChecks).filter(
    check =>
      check.requiredness === 'required' && check.observation === 'observed' && !covered.has(check)
  )) {
    const id = `github:isRequired:${check.id}`;
    items.push({
      id,
      kind: 'status-check',
      title: check.name,
      // isRequired identifies requiredness, not the binding or the viewer's bypass rights.
      state: 'unavailable',
      policy: {
        ...githubPolicy(id, 'required_status_checks'),
        viewerEnforcement: 'unknown',
        viewerBypass: 'unknown',
      },
      check: {
        name: check.name,
        kind: check.kind,
        application: check.application?.id
          ? { kind: 'app', appId: check.application.id }
          : { kind: 'unknown' },
      },
      evidence: check.evidence.map(entry => ({ ...entry, policyId: id })),
    });
  }
  if (
    !selected ||
    !complete(selected) ||
    selected.items.some(
      check => check.requiredness === 'unknown' || check.observation === 'unknown'
    )
  ) {
    items.push({
      id: 'github:check-evaluation',
      kind: 'check-evaluation',
      title: 'Required check evaluation',
      state: 'unavailable',
      policy: null,
      check: null,
      evidence: evidence(
        selected?.source ?? facts.testMerge.source,
        `check-source-unavailable;head:${revision.headSha};test-merge:${testMerge?.oid ?? 'unknown'}`,
        selectedSha ?? revision.headSha
      ),
    });
  }
  if (!available(facts.mergeable) || facts.mergeable.data !== 'MERGEABLE') {
    const id = 'github:merge-conflicts';
    items.push({
      id,
      kind: 'merge-conflicts',
      title: 'Merge conflicts',
      state:
        available(facts.mergeable) && facts.mergeable.data === 'CONFLICTING'
          ? 'unmet'
          : 'unavailable',
      policy: githubPolicy(id, 'mergeability'),
      check: null,
      evidence: evidence(
        facts.mergeable.source,
        `mergeable:${facts.mergeable.data ?? 'unavailable'}`,
        revision.headSha,
        id
      ),
    });
  }
  const checksComplete = Boolean(selected) && collections.every(complete);
  const failed =
    collections.find(collection => !complete(collection))?.source ?? facts.testMerge.source;
  const selectionEvidence = contextRequirementEvidence(
    revision,
    facts.testMerge.source,
    `head:${revision.headSha};test-merge:${testMerge?.oid ?? (available(facts.testMerge) ? 'none' : 'unavailable')};selected:${selectedSha ?? 'unavailable'}`,
    selectedSha
  );
  return {
    evaluatedShas: [
      ...new Set([
        revision.headSha,
        ...(testMerge ? [testMerge.oid] : []),
        ...allChecks.flatMap(check => (check.evaluatedSha ? [check.evaluatedSha] : [])),
      ]),
    ],
    checks: {
      ...head,
      items: allChecks.map(check => ({
        ...check,
        evidence: [...check.evidence, ...selectionEvidence],
      })),
      knownCount: allChecks.length,
      totalCount: checksComplete ? allChecks.length : null,
      completeness: checksComplete ? 'complete' : allChecks.length ? 'partial' : 'unknown',
      hasNextPage: collections.some(collection => collection.hasNextPage === true)
        ? true
        : collections.every(collection => collection.hasNextPage === false)
          ? false
          : null,
      source: {
        ...failed,
        provenance: [...new Set(collections.flatMap(collection => collection.source.provenance))],
        availability: checksComplete
          ? 'available'
          : allChecks.length
            ? 'partial'
            : failed.availability === 'denied'
              ? 'denied'
              : 'unavailable',
        reason: checksComplete ? null : (failed.reason ?? 'check-source-ambiguous'),
        retryable: checksComplete
          ? false
          : collections.some(collection => collection.source.retryable) ||
            facts.testMerge.source.retryable,
      },
    },
    requirements: {
      ...context.requirements,
      items,
      knownCount: items.length,
      totalCount: context.requirements.completeness === 'complete' ? items.length : null,
    },
  };
}
