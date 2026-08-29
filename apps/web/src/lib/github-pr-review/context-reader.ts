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

const collectionQueries = {
  ...PR_CONTEXT_PEOPLE_QUERIES,
  ...PR_CONTEXT_REVIEW_QUERIES,
  ...PR_CONTEXT_ISSUE_QUERIES,
};
const deadlineError = new Error('PR context deadline');
type PrInput = { owner: string; repo: string; number: number };
export type ContextReadResult<T> = { data: T | null; source: GitHubPrReviewSource };

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
    normalize: (item: T, result: ContextReadResult<unknown>, index: number) => T = item => item
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
          },
          request: { signal },
        });
        return response.data;
      });
      const page = decodeContextGraphQlSource(result, ['repository', 'pullRequest', field], schema);
      collection.source = page.source;
      if (page.source.availability !== 'available') incomplete = markIncomplete();
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
  };
  const conflictingReviewIds = new Set<string>();
  const collectReviews = (
    field: keyof typeof PR_CONTEXT_REVIEW_QUERIES,
    fallback: GitHubPrReviewContext['reviewDecisions']
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
          conflictingReviewIds.add(review.id);
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
  [
    context.labels,
    context.assignees,
    context.reviewRequests,
    context.reviewDecisions,
    context.reviewActivity,
    context.issues,
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
          observations
            .map(revision => revision?.[field])
            .filter(value => value != null && value !== '')
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
