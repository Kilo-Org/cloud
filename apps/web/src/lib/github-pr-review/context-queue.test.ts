import { Octokit } from '@octokit/rest';
import {
  createContextReadBudget,
  PR_CONTEXT_REVISION_QUERY,
  readPullRequestContext,
} from './context-reader';
import { PR_CONTEXT_QUEUE_QUERIES } from './context-queue';
import { GitHubPrReviewContextSchema } from './context-dtos';
import type { PullRequestRestData } from './mappers';

const revision = {
  prNodeId: 'PR_1',
  number: 1,
  headSha: 'head',
  baseRepoFullName: 'o/r',
  baseRef: 'main',
  baseSha: 'base',
};
const pr: PullRequestRestData = {
  node_id: 'PR_1',
  number: 1,
  title: 'PR',
  body: null,
  user: null,
  state: 'open',
  head: { ref: 'feature', sha: 'head' },
  base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
  commits: 1,
  changed_files: 1,
  additions: 1,
  deletions: 0,
  mergeable: null,
};
const entry = {
  __typename: 'MergeQueueEntry',
  id: 'ENTRY_1',
  pullRequest: { id: 'PR_1' },
  position: 17,
  state: 'QUEUED',
  enqueuedAt: '2026-08-28T12:00:00Z',
};
const envelope = (data: unknown, errors?: unknown[]) => ({ data: { data, errors } });
const membership = (value: unknown = { id: 'ENTRY_1' }, id = 'PR_1', errors?: unknown[]) =>
  envelope({ repository: { pullRequest: { id, membership: value } } }, errors);
const failure = (status: number) => Object.assign(new Error('provider-only'), { status });
const denied = [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'membership'] }];
let budget: ReturnType<typeof createContextReadBudget>;
beforeEach(() => {
  jest.useFakeTimers();
  budget = createContextReadBudget();
});
afterEach(() => {
  budget.close();
  jest.useRealTimers();
});

async function run(
  members: unknown[] = [membership()],
  details: unknown = envelope({ node: entry }),
  finalRevision?: unknown
) {
  const requests: string[] = [];
  const client = new Octokit();
  const deny = async () => {
    throw failure(403);
  };
  const octokit = {
    pulls: { get: async () => ({ data: pr }) },
    repos: {
      getBranchProtection: deny,
      getBranchRules: Object.assign(deny, client.repos.getBranchRules),
    },
    paginate: client.paginate,
    request: async (_route: string, body: { query: string; variables: { entryId?: string } }) => {
      let response: unknown;
      if (body.query === PR_CONTEXT_QUEUE_QUERIES.queueMembership) {
        requests.push('membership');
        response = members.shift();
      } else if (body.query === PR_CONTEXT_QUEUE_QUERIES.queueEntry) {
        requests.push(`entry:${body.variables.entryId}`);
        response = details;
      } else if (body.query === PR_CONTEXT_REVISION_QUERY && finalRevision !== undefined) {
        response = finalRevision;
      } else
        return envelope({
          repository: {
            pullRequest: {
              id: 'PR_1',
              number: 1,
              headRefOid: 'head',
              baseRefName: 'main',
              baseRefOid: 'base',
              baseRepository: { nameWithOwner: 'o/r' },
            },
          },
        });
      if (response instanceof Error) throw response;
      return response;
    },
  } as unknown as Octokit;
  const context = GitHubPrReviewContextSchema.parse(
    await readPullRequestContext(
      octokit,
      { owner: 'o', repo: 'r', number: 1, expectedRevision: revision },
      budget
    )
  );
  return { queue: context.queue, requests };
}

it.each(['AWAITING_CHECKS', 'LOCKED', 'MERGEABLE', 'QUEUED', 'UNMERGEABLE'])(
  'preserves authoritative %s details after membership',
  async state => {
    const { queue, requests } = await run([membership()], envelope({ node: { ...entry, state } }));
    expect(queue.membership).toMatchObject({
      state: 'queued',
      entryId: 'ENTRY_1',
      source: { availability: 'available' },
    });
    expect(queue.position).toMatchObject({
      value: 17,
      state,
      enqueuedAt: entry.enqueuedAt,
      entryId: 'ENTRY_1',
      prNodeId: 'PR_1',
      source: { availability: 'available' },
    });
    expect(requests).toEqual(['membership', 'entry:ENTRY_1']);
  }
);

it.each([
  ['unproved null', membership(null), 'unavailable', false],
  ['missing entry', envelope({ repository: { pullRequest: { id: 'PR_1' } } }), 'unavailable', true],
  ['wrong PR', membership({ id: 'ENTRY_1' }, 'OTHER'), 'unavailable', true],
  ['invalid entry ID', membership({ id: '' }), 'unavailable', true],
  ['null ancestor', envelope({ repository: null }), 'unavailable', true],
  ['denied field', membership(null, 'PR_1', denied), 'denied', false],
  ['pathless error', membership(null, 'PR_1', [{ type: 'INTERNAL' }]), 'unavailable', true],
  ['HTTP 403', failure(403), 'denied', false],
  ['optional HTTP 401', failure(401), 'denied', false],
  ['HTTP 503', failure(503), 'unavailable', true],
])('does not infer membership from %s', async (_name, response, availability, retryable) => {
  const { queue, requests } = await run([response]);
  expect(queue.membership).toMatchObject({
    state: 'unknown',
    entryId: null,
    source: { availability, retryable },
  });
  expect(queue.position).toMatchObject({ value: null, state: null, enqueuedAt: null });
  expect(requests).toEqual(['membership']);
});

it.each([
  ['HTTP 503', failure(503), 'unavailable', true],
  ['HTTP 403', failure(403), 'denied', false],
  ['optional HTTP 401', failure(401), 'denied', false],
  [
    'null propagation',
    envelope({ node: null }, [{ type: 'INTERNAL', path: ['node', 'position'] }]),
    'unavailable',
    true,
  ],
  [
    'denied position',
    envelope({ node: null }, [{ type: 'FORBIDDEN', path: ['node', 'position'] }]),
    'denied',
    false,
  ],
  [
    'errored value',
    envelope({ node: entry }, [{ type: 'INTERNAL', path: ['node', 'position'] }]),
    'unavailable',
    true,
  ],
  ['invalid position', envelope({ node: { ...entry, position: -1 } }), 'unavailable', true],
  ['invalid state', envelope({ node: { ...entry, state: 'UNKNOWN' } }), 'unavailable', true],
  [
    'invalid timestamp',
    envelope({ node: { ...entry, enqueuedAt: 'yesterday' } }),
    'unavailable',
    true,
  ],
])('retains membership through %s', async (_name, response, availability, retryable) => {
  const { queue, requests } = await run([membership()], response);
  expect(queue.membership).toMatchObject({
    state: 'queued',
    entryId: 'ENTRY_1',
    source: { availability: 'available' },
  });
  expect(queue.position).toMatchObject({
    value: null,
    state: null,
    enqueuedAt: null,
    entryId: null,
    prNodeId: null,
    source: { availability, retryable },
  });
  expect(requests).toEqual(['membership', 'entry:ENTRY_1']);
});

it.each([
  ['disappearance', envelope({ node: null })],
  ['wrong entry', envelope({ node: { ...entry, id: 'ENTRY_2' } })],
  ['wrong PR', envelope({ node: { ...entry, pullRequest: { id: 'OTHER' } } })],
  ['wrong node type', envelope({ node: { ...entry, __typename: 'PullRequest' } })],
  [
    'movement with a denied old position',
    envelope({ node: { ...entry, id: 'ENTRY_2' } }, [
      { type: 'FORBIDDEN', path: ['node', 'position'] },
    ]),
  ],
  [
    'movement with detail errors',
    envelope({ node: { ...entry, id: 'ENTRY_2' } }, [
      { type: 'INTERNAL', path: ['node', 'position'] },
    ]),
  ],
])('refreshes membership once after %s without reusing details', async (_name, response) => {
  const { queue, requests } = await run([membership(), membership({ id: 'ENTRY_2' })], response);
  expect(queue.membership).toMatchObject({
    state: 'queued',
    entryId: 'ENTRY_2',
    source: { availability: 'available' },
  });
  expect(queue.position).toMatchObject({
    value: null,
    state: null,
    enqueuedAt: null,
    source: { availability: 'unavailable', retryable: true },
  });
  expect(requests).toEqual(['membership', 'entry:ENTRY_1', 'membership']);
});

it.each([membership(null), membership(null, 'PR_1', denied)])(
  'keeps an inconclusive refresh unknown',
  async refresh => {
    const { queue, requests } = await run([membership(), refresh], envelope({ node: null }));
    expect(queue.membership).toMatchObject({
      state: 'unknown',
      entryId: null,
      source: { retryable: false },
    });
    expect(queue.membership.source.availability).not.toBe('available');
    expect(queue.position).toMatchObject({ value: null, source: { retryable: false } });
    expect(requests).toEqual(['membership', 'entry:ENTRY_1', 'membership']);
  }
);

describe.each(['deadline', 'revision-mismatch'])('after %s', revisionFailure => {
  it.each([
    ['unproved null', membership(null), envelope({ node: entry })],
    ['denied membership', membership(null, 'PR_1', denied), envelope({ node: entry })],
    ['denied position', membership(), failure(403)],
    ['transient position failure', membership(), failure(503)],
    ['successful queue', membership(), envelope({ node: entry })],
  ])(
    'preserves permanent failures and revision recovery for %s',
    async (_name, member, details) => {
      const before = (await run([member], details)).queue;
      const finalRevision =
        revisionFailure === 'deadline'
          ? new Promise(() => undefined)
          : envelope({
              repository: {
                pullRequest: {
                  id: 'PR_1',
                  number: 1,
                  headRefOid: 'new-head',
                  baseRefName: 'main',
                  baseRefOid: 'base',
                  baseRepository: { nameWithOwner: 'o/r' },
                },
              },
            });
      const pending = run([member], details, finalRevision);
      if (revisionFailure === 'deadline') await jest.advanceTimersByTimeAsync(10_000);
      const { queue } = await pending;
      for (const field of ['membership', 'position'] as const) {
        if (before[field].source.availability === 'available' || before[field].source.retryable) {
          expect(queue[field].source).toMatchObject({
            availability: revisionFailure === 'deadline' ? 'unavailable' : 'stale',
            retryable: true,
            reason: revisionFailure,
          });
        } else {
          expect(queue[field].source).toEqual(before[field].source);
        }
      }
      expect(queue.membership.state).toBe(before.membership.state);
      expect(queue.position.value).toBe(before.position.value);
    }
  );
});

it('keeps the observed entry when the shared deadline prevents detail and revision completion', async () => {
  const pending = run([membership()], new Promise(() => undefined));
  await jest.advanceTimersByTimeAsync(10_000);
  const { queue, requests } = await pending;
  expect(queue.membership).toMatchObject({
    state: 'queued',
    entryId: 'ENTRY_1',
    source: { availability: 'unavailable', retryable: true, reason: 'deadline' },
  });
  expect(queue.position).toMatchObject({
    value: null,
    state: null,
    source: { reason: 'deadline' },
  });
  expect(requests).toEqual(['membership', 'entry:ENTRY_1']);
});

it.each([
  { name: 'HTTP 503', response: failure(503), reason: 'bad_gateway' },
  { name: 'rate limiting', response: failure(429), reason: 'too_many_requests' },
  { name: 'deadline', response: new Promise(() => undefined), reason: 'deadline' },
])(
  'marks both unattempted queue sources retryable after initial core $name',
  async ({ response, reason }) => {
    const octokit = {
      pulls: {
        get: async () => {
          if (response instanceof Error) throw response;
          return response;
        },
      },
    } as unknown as Octokit;
    const pending = readPullRequestContext(
      octokit,
      { owner: 'o', repo: 'r', number: 1, expectedRevision: revision },
      budget
    );
    if (reason === 'deadline') await jest.advanceTimersByTimeAsync(10_000);
    const { queue } = GitHubPrReviewContextSchema.parse(await pending);
    const source = {
      availability: 'unavailable',
      retryable: true,
      reason,
      provenance: ['rest.pullRequest'],
      observedAt: expect.any(String),
    };
    expect(queue).toMatchObject({
      membership: { state: 'unknown', entryId: null, source },
      position: {
        entryId: null,
        prNodeId: null,
        value: null,
        state: null,
        enqueuedAt: null,
        source,
      },
    });
  }
);
