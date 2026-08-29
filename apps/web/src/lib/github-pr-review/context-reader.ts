import 'server-only';

import pLimit from 'p-limit';
import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import {
  GitHubPrReviewContextSchema,
  type GitHubPrReviewContext,
  type GitHubPrReviewRevision,
  type GitHubPrReviewSource,
} from './context-dtos';
import { classifyGitHubHttpError } from './errors';
import { buildOverviewDto } from './mappers';

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
  for (const collection of [context.requirements, context.checks]) {
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
  // Later source readers use this same reader and budget before the final revision fence.
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
