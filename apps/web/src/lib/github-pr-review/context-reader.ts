import 'server-only';

import pLimit from 'p-limit';
import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import {
  GitHubPrReviewContextSchema,
  GitHubPrReviewTimestampSchema,
  type GitHubPrReviewContext,
  type GitHubPrReviewRevision,
  type GitHubPrReviewSource,
} from './context-dtos';
import { classifyGitHubHttpError } from './errors';
import { buildOverviewDto } from './mappers';
import {
  PR_CONTEXT_PEOPLE_QUERIES,
  contextLabelSchema,
  contextIdentitySchema,
  contextReviewRequestSchema,
  mergeKnownContextIdentity,
} from './context-people';
import {
  PR_CONTEXT_REVIEW_QUERIES,
  contextReviewSchema,
  contextReviewEvidenceConflicts,
  resolveContextReviewDecisions,
} from './context-reviews';

import {
  PR_CONTEXT_ISSUE_QUERIES,
  contextIssueSchema,
  contextIssueEventSchema,
  resolveContextIssues,
} from './context-issues';
import { normalizeContextPolicies } from './context-rules';
import {
  PR_CONTEXT_EVALUATION_QUERY,
  PR_CONTEXT_REQUIREMENT_QUERIES,
  contextCheckSchema,
  contextCheckOutcome,
  contextComparisonSchema,
  contextDeploymentSchema,
  contextRequirementEvidence,
  contextTestMergeSchema,
  contextThreadSchema,
  evaluateContextRequirements,
  type ContextReadResult,
  type RequirementFacts,
} from './context-requirements';

const collectionQueries = {
  ...PR_CONTEXT_PEOPLE_QUERIES,
  ...PR_CONTEXT_REVIEW_QUERIES,
  ...PR_CONTEXT_ISSUE_QUERIES,
  ...PR_CONTEXT_REQUIREMENT_QUERIES,
};
const deadlineError = new Error('PR context deadline');
type PrInput = { owner: string; repo: string; number: number };
export type { ContextReadResult } from './context-requirements';

export function createContextReadBudget() {
  const deadline = Date.now() + 10_000;
  const limit = pLimit({ concurrency: 4, rejectOnClear: true });
  const controller = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(deadlineError), { once: true });
  });
  // Authentication can still be pending when the deadline expires.
  void expired.catch(() => undefined);
  const close = () => {
    controller.abort();
    limit.clearQueue();
  };
  const timer = setTimeout(close, 10_000);
  return {
    async run<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (Date.now() >= deadline) close();
      if (controller.signal.aborted) throw deadlineError;
      const result = await Promise.race([
        limit(() => {
          if (controller.signal.aborted || Date.now() >= deadline) throw deadlineError;
          return request(controller.signal);
        }),
        expired,
      ]).catch((error: unknown) => {
        if (Date.now() >= deadline) close();
        throw controller.signal.aborted ? deadlineError : error;
      });
      // A response can settle before an overdue timer gets its turn.
      if (Date.now() >= deadline) close();
      if (controller.signal.aborted) throw deadlineError;
      return result;
    },
    close() {
      clearTimeout(timer);
      close();
    },
  };
}

type ContextReadBudget = ReturnType<typeof createContextReadBudget>;
const isHttp401 = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
const observation = (provenance: string): GitHubPrReviewSource => ({
  availability: 'available',
  retryable: false,
  provenance: [provenance],
  reason: null,
  observedAt: new Date().toISOString(),
});

function failedSource(error: unknown, provenance: string): GitHubPrReviewSource {
  const { code } = classifyGitHubHttpError(error);
  return {
    ...observation(provenance),
    availability: code === 'FORBIDDEN' ? 'denied' : 'unavailable',
    retryable: ['BAD_GATEWAY', 'TOO_MANY_REQUESTS', 'CONFLICT'].includes(code),
    reason: error === deadlineError ? 'deadline' : code.toLowerCase(),
  };
}

export function createContextSourceReader(
  octokit: Octokit,
  input: PrInput,
  budget: ContextReadBudget
) {
  let probe: Promise<boolean> | undefined;
  return async function read<T>(
    provenance: string,
    request: (signal: AbortSignal) => Promise<T>
  ): Promise<ContextReadResult<T>> {
    try {
      return { data: await budget.run(request), source: observation(provenance) };
    } catch (error) {
      if (!isHttp401(error)) return { data: null, source: failedSource(error, provenance) };
      // Release the optional request's slot before sharing a same-credential core probe.
      probe ??= budget
        .run(signal =>
          octokit.pulls.get({
            owner: input.owner,
            repo: input.repo,
            pull_number: input.number,
            request: { signal },
          })
        )
        .then(
          () => true,
          error => {
            if (isHttp401(error)) throw error;
            return false;
          }
        );
      const valid = await probe;
      return {
        data: null,
        source: {
          ...observation(provenance),
          availability: valid ? 'denied' : 'unavailable',
          retryable: !valid,
          reason: valid ? 'optional-permission-denied' : 'credential-probe-inconclusive',
        },
      };
    }
  };
}

const graphQlErrorSchema = z
  .object({
    type: z.string().optional(),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])).nullish(),
    extensions: z.object({ code: z.string().optional() }).optional(),
  })
  .catch({});
const envelopeSchema = z.object({
  data: z.unknown(),
  errors: z.array(graphQlErrorSchema).optional().catch([{}]),
});

// Optional reads alone decode partial envelopes; mutation guards stay fail-closed.
export function decodeContextGraphQlSource<T extends z.ZodTypeAny>(
  result: ContextReadResult<unknown>,
  path: ReadonlyArray<string | number>,
  schema: T
): ContextReadResult<z.output<T>> {
  if (result.source.availability !== 'available') return { data: null, source: result.source };
  const envelope = envelopeSchema.safeParse(result.data);
  const errors = envelope.success ? (envelope.data.errors ?? []) : [{}];
  const related = errors.filter(
    error =>
      !error.path?.length ||
      error.path
        .slice(0, Math.min(path.length, error.path.length))
        .every((part, i) => part === path[i])
  );
  let value: unknown = envelope.success ? envelope.data.data : undefined;
  let missing = false;
  for (const part of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) {
      missing = true;
      break;
    }
    value = Reflect.get(value, part);
  }
  const parsed = schema.safeParse(value);
  const complete = !missing && parsed.success && related.length === 0;
  const denied = (error: z.output<typeof graphQlErrorSchema>) =>
    ['FORBIDDEN', 'NOT_FOUND'].includes(error.type ?? error.extensions?.code ?? '');
  return {
    data: !missing && parsed.success ? parsed.data : null,
    source: {
      ...result.source,
      availability: complete
        ? 'available'
        : !missing && parsed.success && parsed.data !== null
          ? 'partial'
          : related.some(denied)
            ? 'denied'
            : 'unavailable',
      retryable: !complete && (related.length === 0 || related.some(error => !denied(error))),
      reason: complete ? null : related.some(denied) ? 'graphql-denied' : 'graphql-incomplete',
    },
  };
}

export const PR_CONTEXT_REVISION_QUERY = /* GraphQL */ `
  query PrReviewContextRevision($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id
        number
        headRefOid
        baseRefName
        baseRefOid
        baseRepository { nameWithOwner }
      }
    }
  }
`;
const graphQlRevisionSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    headRefOid: z.string().min(1),
    baseRefName: z.string(),
    baseRefOid: z.string().min(1).nullable(),
    baseRepository: z.object({ nameWithOwner: z.string().min(1) }).nullable(),
  })
  .transform(
    (pr): GitHubPrReviewRevision => ({
      prNodeId: pr.id,
      number: pr.number,
      headSha: pr.headRefOid,
      baseRef: pr.baseRefName,
      baseSha: pr.baseRefOid,
      baseRepoFullName: pr.baseRepository?.nameWithOwner ?? null,
    })
  );

function invalidateRevision(context: GitHubPrReviewContext, source: GitHubPrReviewSource) {
  for (const collection of [context.reviewDecisions, context.requirements, context.checks]) {
    collection.source = source;
    collection.completeness = 'unknown';
  }
  for (const requirement of context.requirements.items) requirement.state = 'unavailable';
  for (const check of context.checks.items) {
    check.requiredness = 'unknown';
    check.observation = 'unknown';
  }
  // Keep failed sources' recovery metadata; invalidate only previously successful observations.
  for (const [key, evaluationSource] of Object.entries(context.evaluationSources)) {
    if (evaluationSource.availability !== 'available') continue;
    Object.assign(context.evaluationSources, {
      [key]: {
        ...source,
        provenance: [...new Set([...evaluationSource.provenance, ...source.provenance])],
      },
    });
  }
  context.queue.membership.source = source;
  context.queue.position.source = source;
  return context;
}

export async function readPullRequestContext(
  octokit: Octokit,
  input: PrInput & { expectedRevision: GitHubPrReviewRevision },
  budget: ContextReadBudget
): Promise<GitHubPrReviewContext> {
  let context = GitHubPrReviewContextSchema.parse({ revision: input.expectedRevision });
  try {
    const initial = await budget.run(signal =>
      octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.number,
        request: { signal },
      })
    );
    context = buildOverviewDto({ pr: initial.data, repo: {}, graphQl: null, viewer: null }).context;
  } catch (error) {
    // This is a core REST read, so its 401 already confirms credential rejection.
    if (isHttp401(error)) throw error;
    return invalidateRevision(context, failedSource(error, 'rest.pullRequest'));
  }
  const read = createContextSourceReader(octokit, input, budget);
  type Collection<T> = Omit<GitHubPrReviewContext['labels'], 'items'> & { items: T[] };
  async function collect<T extends { id: string | null } | null>(
    field: keyof typeof collectionQueries,
    node: z.ZodType<T>,
    fallback: Collection<T>,
    merge: (known: T, current: T) => T,
    matches = (known: T, current: T) => known?.id != null && known.id === current?.id,
    normalize: (item: T, result: ContextReadResult<unknown>, index: number) => T = item => item,
    options: {
      path?: ReadonlyArray<string | number>;
      variables?: Record<string, string>;
      validPage?: (result: ContextReadResult<unknown>) => boolean;
    } = {}
  ): Promise<Collection<T>> {
    const schema = z.object({
      nodes: z.array(node.nullable().catch(null)).nullish().catch(null),
      totalCount: z.number().int().nonnegative().nullish().catch(null),
      pageInfo: z
        .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
        .nullish()
        .catch(null),
    });
    const collection: Collection<T> = {
      ...fallback,
      items: [],
      totalCount: null,
      hasNextPage: null,
      endCursor: null,
    };
    const entries = new Map<string, T>();
    const cursors = new Set<string>();
    let incomplete: GitHubPrReviewSource | undefined;
    const markIncomplete = (): GitHubPrReviewSource => ({
      ...collection.source,
      reason: incomplete?.reason ?? collection.source.reason ?? 'pagination-incomplete',
      retryable: Boolean(
        incomplete?.retryable ||
        collection.source.retryable ||
        collection.source.availability === 'available'
      ),
    });
    for (;;) {
      const result = await read(`graphql.${field}`, async (signal): Promise<unknown> => {
        const response = await octokit.request('POST /graphql', {
          query: collectionQueries[field],
          variables: {
            owner: input.owner,
            name: input.repo,
            number: input.number,
            after: collection.endCursor,
            ...options.variables,
          },
          request: { signal },
        });
        return response.data;
      });
      const page = decodeContextGraphQlSource(
        result,
        options.path ?? ['repository', 'pullRequest', field],
        schema
      );
      collection.source = page.source;
      if (page.source.availability !== 'available' || options.validPage?.(result) === false)
        incomplete = markIncomplete();
      if (!page.data) break;
      const { nodes, totalCount, pageInfo } = page.data;
      if (
        !nodes ||
        totalCount == null ||
        !pageInfo ||
        (collection.totalCount != null && totalCount !== collection.totalCount)
      ) {
        incomplete = markIncomplete();
      }
      collection.totalCount = totalCount ?? collection.totalCount;
      collection.hasNextPage = pageInfo?.hasNextPage ?? null;
      collection.endCursor = pageInfo?.endCursor ?? null;
      for (const [index, item] of (nodes ?? []).entries()) {
        if (item?.id) entries.set(item.id, normalize(item, result, index));
        else incomplete = markIncomplete();
      }
      if (!pageInfo?.hasNextPage) break;
      if (!pageInfo.endCursor || cursors.has(pageInfo.endCursor)) {
        incomplete = markIncomplete();
        break;
      }
      cursors.add(pageInfo.endCursor);
    }
    if (
      !incomplete &&
      (collection.hasNextPage !== false || entries.size !== collection.totalCount)
    ) {
      incomplete = markIncomplete();
    }
    collection.items = [...entries.values()];
    if (incomplete) {
      collection.items = collection.items.map(current => {
        const known = fallback.items.find(item => matches(item, current));
        return known === undefined ? current : merge(known, current);
      });
      collection.items.push(
        ...fallback.items.filter(
          known => !collection.items.some(current => matches(known, current))
        )
      );
      collection.source = {
        ...incomplete,
        availability:
          collection.items.length || incomplete.availability === 'available'
            ? 'partial'
            : incomplete.availability,
        provenance: [...new Set([...fallback.source.provenance, ...incomplete.provenance])],
      };
    }
    collection.knownCount = collection.items.length;
    collection.completeness = incomplete
      ? collection.knownCount
        ? 'partial'
        : 'unknown'
      : 'complete';
    return collection;
  }
  const reviewEvidence = {
    latestOpinionatedReviews: new Map<string, z.output<typeof contextReviewSchema>>(),
    latestReviews: new Map<string, z.output<typeof contextReviewSchema>>(),
    eligibleReviews: new Map<string, z.output<typeof contextReviewSchema>>(),
  };
  const conflictingReviewIds = new Set<string>();
  const collectReviews = (
    field: keyof typeof reviewEvidence,
    fallback: GitHubPrReviewContext['reviewDecisions'],
    conflicts = conflictingReviewIds
  ) => {
    const evidence = reviewEvidence[field];
    const pageConflicts = new Set<string>();
    return collect(
      field,
      contextReviewSchema,
      fallback,
      (_known, current) => current,
      undefined,
      (review, result, index) => {
        const attribution = decodeContextGraphQlSource(
          result,
          ['repository', 'pullRequest', field, 'nodes', index, 'onBehalfOf'],
          z.object({})
        );
        const state = decodeContextGraphQlSource(
          result,
          ['repository', 'pullRequest', field, 'nodes', index, 'state'],
          z.string()
        );
        const submission = decodeContextGraphQlSource(
          result,
          ['repository', 'pullRequest', field, 'nodes', index, 'submittedAt'],
          GitHubPrReviewTimestampSchema.nullable()
        );
        const submittedAt =
          submission.source.availability === 'available' ? review.submittedAt : null;
        const available = attribution.source.availability === 'available';
        const previous = evidence.get(review.id);
        const current: z.output<typeof contextReviewSchema> = {
          ...review,
          submittedAt,
          state: state.source.availability === 'available' ? review.state : 'UNKNOWN',
          onBehalfOf: {
            ...review.onBehalfOf,
            completeness: available
              ? review.onBehalfOf.completeness
              : review.onBehalfOf.knownCount
                ? 'partial'
                : 'unknown',
            source: {
              ...(available ? review.onBehalfOf.source : attribution.source),
              observedAt: attribution.source.observedAt,
              provenance: [`graphql.${field}.onBehalfOf`],
            },
          },
        };
        if (previous && contextReviewEvidenceConflicts(previous, current)) {
          pageConflicts.add(review.id);
          conflicts.add(review.id);
        }
        // Missing observations cannot erase comparison evidence or supply public field values.
        evidence.set(review.id, {
          ...current,
          state: current.state === 'UNKNOWN' ? (previous?.state ?? 'UNKNOWN') : current.state,
          submittedAt: current.submittedAt ?? previous?.submittedAt ?? null,
          commitSha: current.commitSha ?? previous?.commitSha ?? null,
        });
        if (pageConflicts.has(review.id)) current.state = 'UNKNOWN';
        return current;
      }
    );
  };
  async function collectIssues() {
    const empty = { ...context.issues, items: [] };
    const [closing, history] = await Promise.all([
      collect('closingIssuesReferences', contextIssueSchema, empty, (_known, current) => current),
      collect('timelineItems', contextIssueEventSchema, empty, (_known, current) => current),
    ]);
    return resolveContextIssues(context.revision.prNodeId, closing, history);
  }
  async function collectPolicies() {
    const { baseRepoFullName, baseRef, baseSha } = context.revision;
    const [owner, repo, extra] = baseRepoFullName?.split('/') ?? [];
    if (!owner || !repo || extra || !baseRef || !baseSha) return context.requirements;
    const parameters = { owner, repo, branch: baseRef };
    const classic: Collection<unknown> = { ...context.requirements, items: [] };
    const rules: Collection<unknown> = { ...context.requirements, items: [] };
    await Promise.all([
      (async () => {
        const result = await read('rest.branchProtection', async signal => {
          const response = await octokit.repos.getBranchProtection({
            ...parameters,
            request: { signal },
          });
          if (response.status !== 200) throw new Error('Incomplete branch protection response');
          return response;
        });
        classic.source = result.source;
        if (result.data) {
          classic.items = [result.data.data];
          classic.completeness = 'complete';
          classic.hasNextPage = false;
        } else if (result.source.reason === 'not_found') {
          // A 404 or nullable rule cannot prove absence; require an explicitly unprotected matching branch.
          const absence = await read('rest.branch', async signal => {
            const response = await octokit.repos.getBranch({ ...parameters, request: { signal } });
            if (response.status !== 200) throw new Error('Incomplete branch response');
            return z
              .object({
                name: z.literal(baseRef),
                commit: z.object({ sha: z.literal(baseSha) }),
                protected: z.boolean(),
              })
              .parse(response.data);
          });
          if (absence.source.availability !== 'available') classic.source = absence.source;
          else if (absence.data?.protected === false) {
            classic.source = absence.source;
            classic.completeness = 'complete';
            classic.hasNextPage = false;
          }
          classic.source.provenance = [...result.source.provenance, ...absence.source.provenance];
        }
        classic.knownCount = classic.items.length;
      })(),
      (async () => {
        const stopped = new Error('Policy pagination stopped');
        const urls = new Set<string>();
        // The paginator drops request.signal and converts raw 409/null responses to empty arrays.
        // Read and validate each page before it reaches that normalization.
        try {
          const requestPage = Object.assign(
            async (params: Parameters<typeof octokit.repos.getBranchRules>[0]) => {
              const result = await read('rest.branchRules', async signal => {
                if (typeof params?.url !== 'string' || !params.url || urls.has(params.url))
                  throw new Error('Repeated policy page');
                urls.add(params.url);
                const response = await octokit.repos.getBranchRules({
                  ...params,
                  request: { signal },
                });
                if (response.status !== 200 || !Array.isArray(response.data))
                  throw new Error('Incomplete branch rules response');
                return response;
              });
              rules.source = result.source;
              if (!result.data) throw stopped;
              return result.data;
            },
            octokit.repos.getBranchRules
          );
          for await (const page of octokit.paginate.iterator(requestPage, {
            ...parameters,
            per_page: 100,
          })) {
            rules.items.push(...page.data);
            rules.hasNextPage = true;
          }
          rules.completeness = 'complete';
          rules.hasNextPage = false;
        } catch (error) {
          if (isHttp401(error)) throw error;
          if (error !== stopped) rules.source = failedSource(error, 'rest.branchRules');
        }
        rules.knownCount = rules.items.length;
      })(),
    ]);
    return normalizeContextPolicies(context.revision, classic, rules);
  }
  async function collectEvaluation() {
    const result = await read('graphql.requirements', async (signal): Promise<unknown> => {
      const response = await octokit.request('POST /graphql', {
        query: PR_CONTEXT_EVALUATION_QUERY,
        variables: {
          owner: input.owner,
          name: input.repo,
          number: input.number,
          head: context.revision.headSha,
        },
        request: { signal },
      });
      return response.data;
    });
    const path = ['repository', 'pullRequest'];
    const revision = decodeContextGraphQlSource(result, path, graphQlRevisionSchema);
    const identity = (
      [
        ['prNodeId', ['id'], z.string().min(1)],
        ['number', ['number'], z.number().int().positive()],
        ['headSha', ['headRefOid'], z.string().min(1)],
        ['baseRef', ['baseRefName'], z.string().min(1)],
        ['baseSha', ['baseRefOid'], z.string().min(1)],
        ['baseRepoFullName', ['baseRepository', 'nameWithOwner'], z.string().min(1)],
      ] as const
    ).map(([field, parts, schema]) => ({
      field,
      ...decodeContextGraphQlSource(result, [...path, ...parts], schema),
    }));
    // Matching outer reads cannot supply missing evaluation identity.
    const identified = identity.every(field => field.source.availability === 'available');
    function fact<T extends z.ZodTypeAny>(
      fields: string[],
      schema: T
    ): ContextReadResult<z.output<T>> {
      const decoded = decodeContextGraphQlSource(result, [...path, ...fields], schema);
      return identified
        ? decoded
        : {
            data: null,
            source: {
              ...revision.source,
              availability: revision.source.availability === 'denied' ? 'denied' : 'unavailable',
              reason: revision.source.reason ?? 'evaluation-identity-unavailable',
            },
          };
    }
    const facts: RequirementFacts = {
      mergeable: fact(['mergeable'], z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])),
      testMerge: fact(['potentialMergeCommit'], contextTestMergeSchema),
      canBypassClassic: fact(['viewerCanMergeAsAdmin'], z.boolean()),
      viewerRule: {
        requiredApprovingReviewCount: fact(
          ['baseRef', 'refUpdateRule', 'requiredApprovingReviewCount'],
          z.number().int().nonnegative().nullable()
        ),
        requiredStatusCheckContexts: fact(
          ['baseRef', 'refUpdateRule', 'requiredStatusCheckContexts'],
          z.array(z.string().nullable()).nullable()
        ),
        requiresConversationResolution: fact(
          ['baseRef', 'refUpdateRule', 'requiresConversationResolution'],
          z.boolean()
        ),
      },
      comparison: fact(['baseRef', 'compare'], contextComparisonSchema),
    };
    const commitMatches = (page: ContextReadResult<unknown>, oid: string) =>
      decodeContextGraphQlSource(page, ['repository', 'object', 'oid'], z.literal(oid)).source
        .availability === 'available';
    const collectChecks = (oid: string) => {
      const checkPath = ['repository', 'object', 'statusCheckRollup', 'contexts'];
      const seen = new Map<string, z.output<typeof contextCheckSchema>>();
      const conflicts = new Set<string>();
      return collect(
        'checks',
        contextCheckSchema,
        context.checks,
        (_known, current) => current,
        undefined,
        (item, page, index) => {
          const nodePath = [...checkPath, 'nodes', index];
          const run = item.kind === 'check-run';
          const field = <T extends z.ZodTypeAny>(parts: string[], schema: T) =>
            decodeContextGraphQlSource(page, [...nodePath, ...parts], schema);
          const required = field(['isRequired'], z.boolean());
          const status = field([run ? 'status' : 'state'], z.string());
          const conclusion = run ? field(['conclusion'], z.string().nullable()) : null;
          const application = run ? field(['checkSuite', 'app'], z.unknown()) : null;
          const commit = field(
            run ? ['checkSuite', 'commit', 'oid'] : ['commit', 'oid'],
            z.literal(oid)
          );
          const identity = field(['id'], z.literal(item.id));
          const name = field([run ? 'name' : 'context'], z.literal(item.name));
          const current = {
            ...item,
            status: status.source.availability === 'available' ? status.data : null,
            conclusion: conclusion?.source.availability === 'available' ? conclusion.data : null,
            application: application?.source.availability === 'available' ? item.application : null,
            requiredness:
              required.source.availability !== 'available'
                ? ('unknown' as const)
                : required.data
                  ? ('required' as const)
                  : ('optional' as const),
          };
          current.outcome = contextCheckOutcome(current.kind, current.status, current.conclusion);
          if (
            !commitMatches(page, oid) ||
            [commit, identity, name].some(value => value.source.availability !== 'available')
          ) {
            current.observation = 'unknown';
            current.requiredness = 'unknown';
          }
          if (current.id) {
            const previous = seen.get(current.id);
            if (previous && JSON.stringify(previous) !== JSON.stringify(current))
              conflicts.add(current.id);
            seen.set(current.id, { ...current });
            if (conflicts.has(current.id)) {
              current.observation = 'unknown';
              current.requiredness = 'unknown';
            }
          }
          current.evidence = [
            ...contextRequirementEvidence(
              context.revision,
              { ...required.source, provenance: ['graphql.checks.isRequired'] },
              `isRequired:${current.requiredness}`,
              current.evaluatedSha
            ),
            ...contextRequirementEvidence(
              context.revision,
              { ...page.source, provenance: ['graphql.checks'] },
              `check:${current.id}:${current.outcome};status:${current.status};conclusion:${current.conclusion}`,
              current.evaluatedSha
            ),
          ];
          return current;
        },
        {
          path: checkPath,
          variables: { oid, pr: context.revision.prNodeId },
          validPage: page => commitMatches(page, oid),
        }
      );
    };
    const [head, merge, threads, eligibleReviews, deployments] = await Promise.all([
      collectChecks(context.revision.headSha),
      facts.testMerge.data ? collectChecks(facts.testMerge.data.oid) : Promise.resolve(null),
      collect(
        'reviewThreads',
        contextThreadSchema,
        { ...context.checks, items: [] },
        (_known, current) => current,
        undefined,
        (thread, page, index) => ({
          ...thread,
          isResolved:
            decodeContextGraphQlSource(
              page,
              [...path, 'reviewThreads', 'nodes', index, 'isResolved'],
              z.boolean()
            ).source.availability === 'available'
              ? thread.isResolved
              : null,
        })
      ),
      collectReviews('eligibleReviews', { ...context.reviewDecisions, items: [] }, new Set()),
      collect(
        'deployments',
        contextDeploymentSchema,
        { ...context.checks, items: [] },
        (_known, current) => current,
        undefined,
        undefined,
        {
          path: ['repository', 'object', 'deployments'],
          variables: { oid: context.revision.headSha },
          validPage: page => commitMatches(page, context.revision.headSha),
        }
      ),
    ]);
    return {
      // Incomplete identity cannot prove a verdict, but reliable fields can still prove a mismatch.
      identity,
      facts,
      observations: { head, merge, threads, eligibleReviews, deployments },
    };
  }
  let evaluation: Awaited<ReturnType<typeof collectEvaluation>>;
  [
    context.labels,
    context.assignees,
    context.reviewRequests,
    context.reviewDecisions,
    context.reviewActivity,
    context.issues,
    context.requirements,
    evaluation,
  ] = await Promise.all([
    collect('labels', contextLabelSchema, context.labels, (known, current) => ({
      ...current,
      color: current.color ?? known.color,
    })),
    collect(
      'assignees',
      contextIdentitySchema.nullable(),
      context.assignees,
      mergeKnownContextIdentity
    ),
    collect(
      'reviewRequests',
      contextReviewRequestSchema,
      context.reviewRequests,
      (known, current) => ({
        ...current,
        reviewer: mergeKnownContextIdentity(known.reviewer, current.reviewer),
      }),
      (known, current) =>
        known.id != null
          ? known.id === current.id
          : known.reviewer?.id != null && known.reviewer.id === current.reviewer?.id
    ),
    collectReviews('latestOpinionatedReviews', context.reviewDecisions),
    collectReviews('latestReviews', context.reviewActivity),
    collectIssues(),
    collectPolicies(),
    collectEvaluation(),
  ]);
  // Final null fields can hide contradictions between the two connections.
  for (const review of context.reviewDecisions.items) {
    const opinionated = reviewEvidence.latestOpinionatedReviews.get(review.id);
    const activity = reviewEvidence.latestReviews.get(review.id);
    if (opinionated && activity && contextReviewEvidenceConflicts(opinionated, activity)) {
      conflictingReviewIds.add(review.id);
      review.state = 'UNKNOWN';
    }
  }
  context.reviewDecisions = resolveContextReviewDecisions(
    context.reviewDecisions,
    context.reviewActivity,
    conflictingReviewIds
  );
  Object.assign(
    context,
    evaluateContextRequirements(context, evaluation.facts, evaluation.observations)
  );
  const final = decodeContextGraphQlSource(
    await read('graphql.revision', async (signal): Promise<unknown> => {
      const response = await octokit.request('POST /graphql', {
        query: PR_CONTEXT_REVISION_QUERY,
        variables: { owner: input.owner, name: input.repo, number: input.number },
        request: { signal },
      });
      return response.data;
    }),
    ['repository', 'pullRequest'],
    graphQlRevisionSchema
  );
  const observations = [input.expectedRevision, context.revision, final.data];
  const fields = [
    'prNodeId',
    'number',
    'headSha',
    'baseRepoFullName',
    'baseRef',
    'baseSha',
  ] as const;
  const mismatch =
    input.number !== input.expectedRevision.number ||
    fields.some(
      field =>
        new Set(
          [
            ...observations.map(revision => revision?.[field]),
            evaluation.identity.find(
              identity => identity.field === field && identity.source.availability === 'available'
            )?.data,
          ].filter(value => value != null && value !== '')
        ).size > 1
    );
  if (mismatch) {
    // Only normalized revision identities enter diagnostics, never provider envelopes or errors.
    console.info('github-pr-review.context-revision-mismatch', {
      expected: input.expectedRevision,
      initial: context.revision,
      final: final.data,
    });
    return invalidateRevision(context, {
      ...observation('revision-fence'),
      availability: 'stale',
      retryable: true,
      reason: 'revision-mismatch',
    });
  }
  if (
    final.source.availability !== 'available' ||
    observations.some(
      revision => !revision || !revision.baseRepoFullName || !revision.baseSha || !revision.baseRef
    )
  ) {
    return invalidateRevision(context, {
      ...final.source,
      availability: final.source.availability === 'denied' ? 'denied' : 'unavailable',
      retryable: final.source.availability === 'available' || final.source.retryable,
      reason: final.source.reason ?? 'revision-unavailable',
    });
  }
  return context;
}
