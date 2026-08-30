jest.mock('@/lib/drizzle', () => ({ db: { select: jest.fn() } }));
jest.mock('@/lib/config.server', () => ({}));
jest.mock('./bitbucket-read', () => ({
  getBitbucketReview: jest.fn(),
  listBitbucketFiles: jest.fn(),
}));
jest.mock('@kilocode/db/operation-ledger', () => ({
  ...jest.requireActual('@kilocode/db/operation-ledger'),
  admitOperation: jest.fn(),
  recordOperationProgress: jest.fn(),
  recordOperationAcceptance: jest.fn(),
  settleOperation: jest.fn(),
  markReconcilePending: jest.fn(),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { repositoryResourceKey } from '@kilocode/app-shared/code-review/repository-identity';
import { db } from '@/lib/drizzle';
import {
  operation_ledgers,
  user_terms_acceptances,
  type OperationLedgerRow,
} from '@kilocode/db/schema';
import {
  admitOperation,
  recordOperationProgress,
  recordOperationAcceptance,
  settleOperation,
  markReconcilePending,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';
import { ANALYTICS_EVENT_SCHEMAS } from '@kilocode/app-shared/analytics';
import { CURRENT_UGC_TERMS_VERSION } from '@kilocode/app-shared/moderation';
import {
  providerReviewFixtures,
  reviewCapabilityFixtures,
} from '@kilocode/app-shared/provider-review/fixtures';
import { BitbucketInteractiveClientError } from '@/lib/integrations/platforms/bitbucket/interactive-client';
import type { BitbucketReviewAuthorization } from './bitbucket-authorization';
import { getBitbucketReview } from './bitbucket-read';
import {
  runBitbucketReviewOperation,
  type BitbucketReviewOperationRequest,
} from './bitbucket-write';
import {
  confirmedReviewEffect,
  rejectedReviewEffect,
  unresolvedReviewEffect,
  runReviewOperation,
  type ReviewOperationRequest,
  type ReviewEffectResult,
} from './operation';

const userId = 'oauth/reviewer';
const request: ReviewOperationRequest = {
  userId,
  distinctId: 'reviewer@example.com',
  operationKey: '11111111-1111-4111-8111-111111111111',
  intent: {
    accountId: userId,
    actorId: '9',
    review: {
      ...providerReviewFixtures.gitlab.user,
      authorization: {
        kind: 'ownerIntegration',
        owner: { type: 'user', id: userId },
        integrationId: 'integration',
      },
    },
    revision: {
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      startSha: 'c'.repeat(40),
      targetHeadSha: null,
    },
    input: { action: 'comment', body: 'Private review text' },
  },
};
const ref = { provider: 'gitlab' as const, kind: 'comment' as const, id: '42', url: null };
let rows: Map<string, OperationLedgerRow>;
let outbox: OutboxEventInput[];
let effects: string[];
let terms: boolean;
const rowKey = (user: string, key: string) => `${user}:${key}`;
const row = () => [...rows.values()][0];
function recorded(rowId: string) {
  const value = [...rows.values()].find(item => item.id === rowId);
  if (!value) throw new Error('Missing test row');
  return value;
}
const execute = async () => {
  effects.push('comment');
  return confirmedReviewEffect(ref);
};
const reconcile = async () => unresolvedReviewEffect('receipt_missing');
const run = (input = request) => runReviewOperation(input, { execute, reconcile });

beforeEach(() => {
  jest.resetAllMocks();
  rows = new Map();
  outbox = [];
  effects = [];
  terms = true;
  jest.mocked(db.select).mockImplementation(
    () =>
      ({
        from: (table: unknown) => ({
          where: (where: Parameters<PgDialect['sqlToQuery']>[0]) => ({
            limit: async () => {
              const parameters = new PgDialect().sqlToQuery(where).params;
              if (table === user_terms_acceptances)
                return terms &&
                  parameters[0] === userId &&
                  parameters[1] === CURRENT_UGC_TERMS_VERSION
                  ? [{ id: 'acceptance' }]
                  : [];
              return [...rows.values()].filter(
                value =>
                  value.kilo_user_id === parameters[0] &&
                  value.domain === parameters[1] &&
                  value.operation_key === parameters[2]
              );
            },
          }),
        }),
      }) as any
  );
  jest.mocked(admitOperation).mockImplementation(async (_db, input) => {
    const key = rowKey(input.userId, input.operationKey),
      existing = rows.get(key);
    if (existing) {
      if (['completed', 'failed'].includes(existing.status))
        return { admission: 'duplicate_settled', row: existing };
      const live = new Date(existing.lease_expires_at).getTime() > Date.now();
      if (!live) existing.lease_expires_at = new Date(Date.now() + 60_000).toISOString();
      return {
        admission:
          existing.status === 'admitted'
            ? live
              ? 'duplicate_in_flight'
              : 'takeover'
            : live
              ? 'duplicate_reconcile_in_progress'
              : 'duplicate_reconcile_pending',
        row: { ...existing },
      };
    }
    const fresh: OperationLedgerRow = {
      id: String(rows.size + 1),
      kilo_user_id: input.userId,
      organization_id: input.orgId ?? null,
      domain: input.domain,
      intent: input.intent,
      operation_key: input.operationKey,
      resource_key: input.resourceKey ?? null,
      taxonomy: input.taxonomy,
      status: 'admitted',
      canonical_result: null,
      provider_ref: null,
      outcome_code: null,
      settled_at: null,
      admitted_at: '2026-08-30 01:00:00.000+00',
      expires_at: '2026-09-30 01:00:00.000+00',
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    rows.set(key, fresh);
    return { admission: 'admitted', row: { ...fresh } };
  });
  jest.mocked(recordOperationProgress).mockImplementation(async (_db, id, patch) => {
    const value = recorded(id);
    value.canonical_result = { ...value.canonical_result, ...patch };
    return value;
  });
  jest.mocked(recordOperationAcceptance).mockImplementation(async (_db, input) => {
    const value = recorded(input.rowId);
    value.canonical_result = { ...value.canonical_result, ...input.canonicalResult };
    value.provider_ref = input.providerRef;
    return value;
  });
  jest.mocked(settleOperation).mockImplementation(async (_db, input) => {
    const value = recorded(input.rowId);
    if (value.status === 'completed' || value.status === 'failed')
      return { settled: false, row: value };
    if (input.outboxEvent) {
      ANALYTICS_EVENT_SCHEMAS[input.outboxEvent.eventName].parse(input.outboxEvent.properties);
      outbox.push(input.outboxEvent);
    }
    Object.assign(value, {
      status: input.status,
      outcome_code: input.outcomeCode,
      canonical_result: { ...value.canonical_result, ...input.canonicalResult },
    });
    return { settled: true, row: value };
  });
  jest.mocked(markReconcilePending).mockImplementation(async (_db, input) => {
    const value = recorded(input.rowId);
    if (value.status === 'admitted') {
      value.status = 'reconcile_pending';
      value.lease_expires_at = new Date(0).toISOString();
      if (input.outboxEvent) {
        ANALYTICS_EVENT_SCHEMAS[input.outboxEvent.eventName].parse(input.outboxEvent.properties);
        outbox.push(input.outboxEvent);
      }
    }
    return value;
  });
});

it('AC6 admits concurrent same-key calls once and replays the confirmed result', async () => {
  const gate = Promise.withResolvers<void>();
  const first = runReviewOperation(request, {
    execute: async () => {
      effects.push('comment');
      await gate.promise;
      return confirmedReviewEffect(ref);
    },
    reconcile,
  });
  await Promise.resolve();
  await Promise.resolve();
  const duplicate = await run();
  expect(duplicate).toMatchObject({
    status: 'unresolved',
    reason: 'operation_in_progress',
    retry: 'reconcile',
  });
  gate.resolve();
  expect(await first).toMatchObject({ status: 'confirmed', reference: ref });
  expect(await run()).toEqual(await first);
  expect(effects).toEqual(['comment']);
  expect(rows.size).toBe(1);
  expect(outbox).toHaveLength(1);
});

it.each([
  'actor',
  'owner',
  'integration',
  'instance',
  'repository',
  'review',
  'head',
  'body',
  'action',
] as const)(
  'AC6/AC10 refuses same-key %s replacement without another provider effect',
  async field => {
    await run();
    const changed = structuredClone(request);
    switch (field) {
      case 'actor':
        changed.intent.actorId = 'another-actor';
        break;
      case 'owner':
        changed.intent.review.authorization = {
          kind: 'ownerIntegration',
          owner: { type: 'org', id: 'another-org' },
          integrationId: 'integration',
        };
        break;
      case 'integration':
        if (changed.intent.review.authorization.kind === 'ownerIntegration')
          changed.intent.review.authorization.integrationId = 'other';
        break;
      case 'instance':
        changed.intent.review.repository.instanceUrl = 'https://other.example/GitLab';
        break;
      case 'repository':
        changed.intent.review.repository.repositoryId = 'another';
        break;
      case 'review':
        changed.intent.review.reviewId = 'another';
        break;
      case 'head':
        changed.intent.revision.headSha = 'd'.repeat(40);
        break;
      case 'body':
        changed.intent.input.body = 'Changed text';
        break;
      case 'action':
        changed.intent.input = { action: 'approve' };
        break;
    }
    expect(await run(changed)).toMatchObject({
      status: 'rejected',
      code: 'operation_key_reuse_mismatch',
      retry: 'never',
    });
    expect(effects).toEqual(['comment']);
    expect(outbox).toHaveLength(1);
  }
);

it('AC6 retains Terms acceptance before content admission', async () => {
  terms = false;
  await expect(run()).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'terms_required',
  });
  expect(rows.size).toBe(0);
  expect(effects).toEqual([]);
});
it('AC6 refuses a different caller before admission', async () => {
  expect(await run({ ...request, userId: 'someone-else' })).toMatchObject({
    status: 'rejected',
    code: 'operation_identity_mismatch',
  });
  expect(rows.size).toBe(0);
  expect(effects).toEqual([]);
});
it('AC10 keeps the new helper away from the legacy GitHub namespace', async () => {
  const github = {
    ...request,
    intent: { ...request.intent, review: providerReviewFixtures.github.user },
  };
  expect(await run(github)).toMatchObject({ status: 'rejected' });
  expect(rows.size).toBe(0);
  expect(effects).toEqual([]);
});
it('AC6 never retries a provider write after a lost response', async () => {
  const lost = async () => {
    effects.push('comment');
    throw new Error('secret provider response');
  };
  const first = await runReviewOperation(request, { execute: lost, reconcile });
  expect(first).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  expect(JSON.stringify(first)).not.toContain('secret');
  expect(await run()).toMatchObject({ status: 'unresolved' });
  row().lease_expires_at = new Date(0).toISOString();
  expect(await run()).toMatchObject({ status: 'unresolved' });
  expect(effects).toEqual(['comment']);
  expect(row().status).toBe('reconcile_pending');
});
it('AC6 forbids takeover replay when acceptance and pending persistence both fail', async () => {
  jest.mocked(recordOperationAcceptance).mockRejectedValueOnce(new Error('offline'));
  jest.mocked(markReconcilePending).mockRejectedValueOnce(new Error('offline'));
  expect(await run()).toMatchObject({ status: 'unresolved', reason: 'ledger_persistence_failed' });
  expect(row().provider_ref).toBeNull();
  row().lease_expires_at = new Date(0).toISOString();
  expect(await run()).toMatchObject({ status: 'unresolved' });
  expect(effects).toEqual(['comment']);
});
it('AC6 settles a recorded receipt after outbox failure without repeating the effect', async () => {
  jest.mocked(settleOperation).mockRejectedValueOnce(new Error('outbox unavailable'));
  expect(await run()).toMatchObject({ status: 'unresolved', reason: 'ledger_persistence_failed' });
  expect(row().provider_ref).toBe(JSON.stringify(ref));
  expect(outbox).toEqual([]);
  expect(await run()).toMatchObject({ status: 'confirmed', reference: ref });
  expect(effects).toEqual(['comment']);
  expect(row().status).toBe('completed');
  expect(outbox).toHaveLength(1);
});
it('AC6 permits only an explicitly persisted pre-dispatch retry', async () => {
  const denied = await runReviewOperation(request, {
    execute: async () => rejectedReviewEffect('preflight_unavailable', 'same-key'),
    reconcile,
  });
  expect(denied).toMatchObject({ status: 'rejected', retry: 'same-key' });
  expect(effects).toEqual([]);
  expect(await run()).toMatchObject({ status: 'confirmed' });
  expect(effects).toEqual(['comment']);
});
it('AC7 serializes reconciliation and preserves accepted task progress', async () => {
  const accepted: ReviewEffectResult = {
    status: 'accepted',
    reference: ref,
    task: null,
    retry: 'reconcile',
    reconciliation: 'pending',
  };
  await runReviewOperation(request, {
    execute: async () => {
      effects.push('task');
      return accepted;
    },
    reconcile,
  });
  const gate = Promise.withResolvers<void>();
  const first = runReviewOperation(request, {
    reconcile: async () => {
      await gate.promise;
      return confirmedReviewEffect(ref);
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const second = await runReviewOperation(request, { reconcile });
  expect(second).toEqual(accepted);
  gate.resolve();
  expect(await first).toMatchObject({ status: 'confirmed' });
  expect(effects).toEqual(['task']);
  expect(outbox).toHaveLength(1);
});
it.each(['confirmed', 'rejected'] as const)(
  'AC7 preserves accepted evidence across failed reads and reconstruction until %s',
  async outcome => {
    const rebase = {
      ...request,
      intent: { ...request.intent, input: { action: 'updateBranch' as const } },
    };
    const accepted: ReviewEffectResult = {
      status: 'accepted',
      reference: { ...ref, kind: 'review', id: '77' },
      task: null,
      retry: 'reconcile',
      reconciliation: 'pending',
    };
    const execute = async () => {
      effects.push('rebase');
      return accepted;
    };
    expect(await runReviewOperation(rebase, { execute, reconcile })).toEqual(accepted);
    expect(
      await runReviewOperation(rebase, {
        execute,
        reconcile: async stored =>
          unresolvedReviewEffect(
            'reconciliation_unavailable',
            stored && 'reference' in stored ? stored.reference : null
          ),
      })
    ).toMatchObject({ status: 'unresolved', retry: 'reconcile' });

    // Reconstruct the process from serialized ledger rows, not the previous handler's memory.
    rows = new Map(JSON.parse(JSON.stringify([...rows])) as [string, OperationLedgerRow][]);
    let reconstructedRun = runReviewOperation;
    jest.isolateModules(() => {
      reconstructedRun = jest.requireActual<{ runReviewOperation: typeof runReviewOperation }>(
        './operation'
      ).runReviewOperation;
    });
    row().lease_expires_at = new Date(0).toISOString();
    expect(
      await reconstructedRun(rebase, {
        execute,
        reconcile: async () => {
          throw new Error('Status read unavailable');
        },
      })
    ).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
    expect(row().canonical_result).toEqual({ result: accepted });
    expect(row().provider_ref).toBe(JSON.stringify(accepted.reference));

    row().lease_expires_at = new Date(0).toISOString();
    const terminal =
      outcome === 'confirmed'
        ? confirmedReviewEffect(accepted.reference)
        : rejectedReviewEffect('rebase_failed');
    const recovered = await reconstructedRun(rebase, {
      execute,
      reconcile: async stored =>
        stored?.status === 'accepted' ? terminal : unresolvedReviewEffect('acceptance_missing'),
    });
    expect(recovered).toEqual(terminal);
    expect(await reconstructedRun(rebase, { execute, reconcile })).toEqual(terminal);
    expect(row().status).toBe(outcome === 'confirmed' ? 'completed' : 'failed');
    expect(effects).toEqual(['rebase']);
  }
);
it('AC6 status for an empty ledger never creates an operation or a provider effect', async () => {
  expect(await runReviewOperation(request, { reconcile })).toMatchObject({
    status: 'rejected',
    code: 'operation_not_admitted',
    retry: 'same-key',
  });
  expect(rows.size).toBe(0);
  expect(effects).toEqual([]);
});
it('AC6 keeps large comment bodies out of canonical results and analytics', async () => {
  await run({
    ...request,
    intent: { ...request.intent, input: { action: 'comment', body: 'Private '.repeat(10_000) } },
  });
  expect(Buffer.byteLength(JSON.stringify(row().canonical_result))).toBeLessThan(4096);
  expect(JSON.stringify([row().canonical_result, outbox])).not.toContain('Private');
  expect(outbox[0].properties).toMatchObject({
    intent: 'create_review_comment',
    outcome: 'completed',
  });
});
it('AC6 rejects an oversized request before provider access', async () => {
  await expect(
    run({
      ...request,
      intent: { ...request.intent, input: { action: 'comment', body: 'x'.repeat(256_000) } },
    })
  ).rejects.toThrow('serialized byte limit');
  expect(rows.size).toBe(0);
  expect(effects).toEqual([]);
});
it('AC6 keeps an oversized provider receipt unresolved instead of storing an invalid result', async () => {
  expect(
    await runReviewOperation(request, {
      execute: async () => {
        effects.push('comment');
        return confirmedReviewEffect({ ...ref, id: 'x'.repeat(5000) });
      },
      reconcile,
    })
  ).toMatchObject({ status: 'unresolved', reason: 'result_too_large' });
  expect(Buffer.byteLength(JSON.stringify(row().canonical_result))).toBeLessThan(4096);
  expect(await run()).toMatchObject({ status: 'unresolved' });
  expect(effects).toEqual(['comment']);
});
it('AC6 retires a safe retry before a later dispatch loses its response', async () => {
  await runReviewOperation(request, {
    execute: async () => rejectedReviewEffect('preflight_unavailable', 'same-key'),
    reconcile,
  });
  expect(
    await runReviewOperation(request, {
      execute: async () => {
        effects.push('comment');
        throw new Error('lost response');
      },
      reconcile,
    })
  ).toMatchObject({ status: 'unresolved' });
  row().lease_expires_at = new Date(0).toISOString();
  expect(await run()).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  expect(effects).toEqual(['comment']);
});
it('AC6 emits no duplicate provider outcome for an aggregate row', async () => {
  expect(await runReviewOperation(request, { execute, reconcile, aggregate: true })).toMatchObject({
    status: 'confirmed',
  });
  expect(effects).toEqual(['comment']);
  expect(outbox).toEqual([]);
  expect(row().status).toBe('completed');
});
it('AC10 keeps effect fingerprints stable across object field order', async () => {
  expect(await run({ ...request, effect: { id: 'item', action: 'comment' } })).toMatchObject({
    status: 'confirmed',
  });
  expect(await run({ ...request, effect: { action: 'comment', id: 'item' } })).toMatchObject({
    status: 'confirmed',
  });
  expect(effects).toEqual(['comment']);
  expect(rows.size).toBe(1);
});
it('AC6 blocks dispatch when the durable dispatch fence cannot persist', async () => {
  jest.mocked(recordOperationProgress).mockRejectedValueOnce(new Error('offline'));
  expect(await run()).toMatchObject({ status: 'unresolved', retry: 'reconcile' });
  expect(effects).toEqual([]);
});

describe('Bitbucket merge evidence through the real operation and JSON ledger boundary', () => {
  const repository = {
    provider: 'bitbucket' as const,
    instanceUrl: 'https://bitbucket.org',
    repositoryId: '44444444-4444-4444-8444-444444444444',
    workspaceUuid: '33333333-3333-4333-8333-333333333333',
    fullName: 'team/repo',
    defaultBranch: 'trunk',
  };
  const authorization = {
    kind: 'ownerIntegration' as const,
    owner: { type: 'org' as const, id: '11111111-1111-4111-8111-111111111111' },
    integrationId: '22222222-2222-4222-8222-222222222222',
  };
  const mergeRequest: BitbucketReviewOperationRequest = {
    userId,
    distinctId: 'caller',
    operationKey: '66666666-6666-4666-8666-666666666666',
    intent: {
      accountId: userId,
      actorId: '55555555-5555-4555-8555-555555555555',
      review: {
        repository,
        authorization,
        reviewId: '7',
        number: '7',
        canonicalUrl: 'https://bitbucket.org/team/repo/pull-requests/7',
      },
      revision: {
        headSha: 'a'.repeat(40),
        targetHeadSha: 'b'.repeat(40),
        baseSha: null,
        startSha: null,
      },
      input: { action: 'merge', method: 'merge_commit' },
    },
  };
  const evidence = {
    source: {
      repositoryId: repository.repositoryId,
      workspaceUuid: repository.workspaceUuid,
      fullName: repository.fullName,
      branch: 'feature',
    },
    destination: {
      repositoryId: repository.repositoryId,
      workspaceUuid: repository.workspaceUuid,
      fullName: repository.fullName,
      branch: 'trunk',
    },
  };
  const taskUrl =
    'https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests/7/merge/task-status/task-1';
  const actualLedger = jest.requireActual<{
    recordOperationProgress: typeof recordOperationProgress;
    recordOperationAcceptance: typeof recordOperationAcceptance;
  }>('@kilocode/db/operation-ledger');
  let auth: BitbucketReviewAuthorization;
  let pr: any;
  let acceptedTask: boolean;
  let taskComplete: boolean;
  let unavailable: boolean;
  let loseResponse: boolean;
  let dispatchSnapshots: unknown[];
  let recoveredRun: typeof runBitbucketReviewOperation;

  // Keep real progress/acceptance merging and the production JSONB serializer. Only storage I/O is fake.
  function storage(rowId: string) {
    return {
      select: () => ({
        from: () => ({ where: () => ({ for: async () => [structuredClone(recorded(rowId))] }) }),
      }),
      update: () => ({
        set: (patch: Partial<OperationLedgerRow>) => ({
          where: () => ({
            returning: async () => {
              const value = recorded(rowId);
              const json = operation_ledgers.canonical_result.mapToDriverValue(
                patch.canonical_result ?? null
              );
              Object.assign(value, {
                ...patch,
                canonical_result: operation_ledgers.canonical_result.mapFromDriverValue(json),
              });
              return [structuredClone(value)];
            },
          }),
        }),
      }),
    } as any;
  }
  function restart() {
    rows = new Map(JSON.parse(JSON.stringify([...rows])) as [string, OperationLedgerRow][]);
    for (const value of rows.values()) value.lease_expires_at = new Date(0).toISOString();
    jest.isolateModules(() => {
      recoveredRun = jest.requireActual<{
        runBitbucketReviewOperation: typeof runBitbucketReviewOperation;
      }>('./bitbucket-write').runBitbucketReviewOperation;
    });
  }
  function finishMerge() {
    pr.state = 'MERGED';
    pr.merge_commit = { hash: 'c'.repeat(40) };
  }
  beforeEach(() => {
    acceptedTask = false;
    taskComplete = false;
    unavailable = false;
    loseResponse = false;
    dispatchSnapshots = [];
    recoveredRun = runBitbucketReviewOperation;
    const nativeRepository = {
      uuid: `{${repository.repositoryId}}`,
      full_name: repository.fullName,
      workspace: { uuid: `{${repository.workspaceUuid}}` },
    };
    pr = {
      type: 'pullrequest',
      id: 7,
      state: 'OPEN',
      links: { html: { href: mergeRequest.intent.review.canonicalUrl } },
      source: {
        repository: structuredClone(nativeRepository),
        branch: { name: 'feature' },
        commit: { hash: mergeRequest.intent.revision.headSha },
      },
      destination: {
        repository: structuredClone(nativeRepository),
        branch: { name: 'trunk' },
        commit: { hash: mergeRequest.intent.revision.targetHeadSha },
      },
    };
    auth = {
      userId,
      repository,
      authorization,
      path: {
        workspace: `{${repository.workspaceUuid}}`,
        repo_slug: `{${repository.repositoryId}}`,
      },
      actor: {
        provider: 'bitbucket',
        instanceUrl: repository.instanceUrl,
        id: mergeRequest.intent.actorId,
        login: 'reviewer',
        displayName: null,
        avatarUrl: null,
      },
      credentialKind: 'bitbucketOAuth',
      scopes: ['pullrequest:write'],
      client: {
        execute: async input => {
          if (input.operation === 'merge') {
            dispatchSnapshots = structuredClone(
              [...rows.values()].map(value => value.canonical_result)
            );
            effects.push('merge');
            if (loseResponse) {
              finishMerge();
              throw new BitbucketInteractiveClientError('transport_failed');
            }
            if (acceptedTask)
              return { status: 202, data: null, location: taskUrl, metadata: {} } as any;
            finishMerge();
          } else if (input.operation === 'mergeTask') {
            if (unavailable) throw new BitbucketInteractiveClientError('temporarily_unavailable');
            if (taskComplete) finishMerge();
            return {
              status: 200,
              data: {
                task_status: taskComplete ? 'SUCCESS' : 'PENDING',
                links: { self: { href: taskUrl } },
                ...(taskComplete ? { merge_result: structuredClone(pr) } : {}),
              },
              metadata: {},
            } as any;
          }
          return { status: 200, data: structuredClone(pr), metadata: {} } as any;
        },
      },
    };
    jest.mocked(getBitbucketReview).mockImplementation(
      async () =>
        ({
          identity: mergeRequest.intent.review,
          revision: mergeRequest.intent.revision,
          state: 'open',
          source: { repository, branch: pr.source.branch.name },
          target: { repository, branch: pr.destination.branch.name },
          merge: { methods: [{ id: 'merge_commit', label: 'Merge commit' }] },
          authorization: { capabilities: reviewCapabilityFixtures('bitbucket') },
        }) as any
    );
    jest
      .mocked(recordOperationProgress)
      .mockImplementation(async (_db, rowId, patch) =>
        actualLedger.recordOperationProgress(storage(rowId), rowId, patch)
      );
    jest
      .mocked(recordOperationAcceptance)
      .mockImplementation(async (_db, input) =>
        actualLedger.recordOperationAcceptance(storage(input.rowId), input)
      );
  });

  it('AC7 stores server preflight identity before dispatch and ignores client evidence', async () => {
    const forged = {
      source: { ...evidence.source, branch: 'injected' },
      destination: evidence.destination,
    };
    const result = await recoveredRun(auth, {
      ...mergeRequest,
      intent: { ...mergeRequest.intent, bitbucketMergeEvidence: forged },
      bitbucketMergeEvidence: forged,
    } as BitbucketReviewOperationRequest);
    expect(result).toEqual(
      confirmedReviewEffect({
        provider: 'bitbucket',
        kind: 'review',
        id: '7',
        url: mergeRequest.intent.review.canonicalUrl,
      })
    );
    expect(dispatchSnapshots).toEqual([
      { result: unresolvedReviewEffect('dispatching'), bitbucketMergeEvidence: evidence },
    ]);
    expect(row().canonical_result).toEqual({ result, bitbucketMergeEvidence: evidence });
    expect(Buffer.byteLength(JSON.stringify(row().canonical_result))).toBeLessThan(4096);
    expect(effects).toEqual(['merge']);
  });

  it('AC7 retains the task and preflight identity through unavailable polling and process restart', async () => {
    acceptedTask = true;
    const accepted = await recoveredRun(auth, mergeRequest);
    expect(accepted).toMatchObject({ status: 'accepted', reference: { id: 'task-1' } });
    restart();
    unavailable = true;
    expect(await recoveredRun(auth, mergeRequest, true)).toMatchObject({
      status: 'unresolved',
      retry: 'reconcile',
    });
    expect(row().canonical_result).toEqual({ result: accepted, bitbucketMergeEvidence: evidence });
    expect(row().provider_ref).toBe(
      JSON.stringify({ provider: 'bitbucket', kind: 'merge-task', id: 'task-1', url: taskUrl })
    );
    restart();
    unavailable = false;
    taskComplete = true;
    expect(await recoveredRun(auth, mergeRequest, true)).toMatchObject({ status: 'confirmed' });
    expect(await recoveredRun(auth, mergeRequest)).toMatchObject({ status: 'confirmed' });
    expect(row().status).toBe('completed');
    expect(row().canonical_result?.bitbucketMergeEvidence).toEqual(evidence);
    expect(effects).toEqual(['merge']);
  });

  it('AC7 recovers a lost merge response from serialized preflight identity without another write', async () => {
    loseResponse = true;
    expect(await recoveredRun(auth, mergeRequest)).toMatchObject({ status: 'unresolved' });
    restart();
    loseResponse = false;
    expect(await recoveredRun(auth, mergeRequest, true)).toMatchObject({ status: 'confirmed' });
    expect(pr.state).toBe('MERGED');
    expect(effects).toEqual(['merge']);
  });

  it.each(
    (['source', 'destination'] as const).flatMap(endpoint =>
      (['branch', 'repository', 'workspace'] as const).map(field => ({ endpoint, field }))
    )
  )(
    'AC7 rejects same-SHA $endpoint $field drift after serialized restart',
    async ({ endpoint, field }) => {
      loseResponse = true;
      await recoveredRun(auth, mergeRequest);
      restart();
      if (field === 'branch') pr[endpoint].branch.name = 'different';
      if (field === 'repository')
        pr[endpoint].repository.uuid = '{77777777-7777-4777-8777-777777777777}';
      if (field === 'workspace')
        pr[endpoint].repository.workspace.uuid = '{88888888-8888-4888-8888-888888888888}';
      expect(await recoveredRun(auth, mergeRequest, true)).toMatchObject({
        status: 'unresolved',
        retry: 'reconcile',
      });
      restart();
      expect(await recoveredRun(auth, mergeRequest)).toMatchObject({ status: 'unresolved' });
      expect(row().canonical_result?.bitbucketMergeEvidence).toEqual(evidence);
      expect(effects).toEqual(['merge']);
    }
  );

  it.each(['absent', 'malformed', 'incomplete', 'legacy accepted', 'legacy confirmed'] as const)(
    'AC7 never reconstructs %s merge identity from matching postflight objects',
    async condition => {
      acceptedTask = condition === 'legacy accepted';
      loseResponse = condition !== 'legacy accepted' && condition !== 'legacy confirmed';
      await recoveredRun(auth, mergeRequest);
      const canonical = row().canonical_result!;
      if (condition === 'malformed')
        canonical.bitbucketMergeEvidence = {
          ...evidence,
          source: { ...evidence.source, repositoryId: 'not-a-uuid' },
        };
      else if (condition === 'incomplete')
        canonical.bitbucketMergeEvidence = { source: evidence.source };
      else delete canonical.bitbucketMergeEvidence;
      finishMerge();
      restart();
      expect(await recoveredRun(auth, mergeRequest, true)).toMatchObject({
        status: 'unresolved',
        reason: 'merge_identity_unavailable',
        retry: 'reconcile',
      });
      restart();
      expect(await recoveredRun(auth, mergeRequest)).toMatchObject({ status: 'unresolved' });
      expect(effects).toEqual(['merge']);
    }
  );

  it.each(['valid', 'absent', 'malformed', 'incomplete', 'missing child'] as const)(
    'AC7 checks serialized child identity beneath a cached aggregate: %s',
    async condition => {
      const aggregateRequest: BitbucketReviewOperationRequest = {
        ...mergeRequest,
        intent: {
          ...mergeRequest.intent,
          input: {
            ...mergeRequest.intent.input,
            deletion: {
              effect: 'delete',
              branch: 'feature',
              expectedHeadSha: mergeRequest.intent.revision.headSha,
              repositoryKey: repositoryResourceKey(userId, { repository, authorization }),
            },
          },
        },
      };
      const execute = auth.client.execute;
      auth.client.execute = async input => {
        if (input.operation !== 'branch') return execute(input);
        if (pr.state === 'MERGED') throw new BitbucketInteractiveClientError('not_found');
        return {
          status: 200,
          data: { name: 'feature', target: { hash: mergeRequest.intent.revision.headSha } },
          metadata: {},
        } as any;
      };
      expect(await recoveredRun(auth, aggregateRequest)).toMatchObject({ status: 'confirmed' });
      const child = [...rows.values()].find(
        value => value.intent === 'merge' && value.operation_key !== aggregateRequest.operationKey
      )!;
      expect(child.canonical_result).toMatchObject({
        result: { status: 'confirmed' },
        bitbucketMergeEvidence: evidence,
      });
      const canonical = child.canonical_result!;
      if (condition === 'missing child') rows.delete(rowKey(userId, child.operation_key));
      else if (condition === 'absent') delete canonical.bitbucketMergeEvidence;
      else if (condition === 'malformed')
        canonical.bitbucketMergeEvidence = {
          ...evidence,
          source: { ...evidence.source, repositoryId: 'not-a-uuid' },
        };
      else if (condition === 'incomplete')
        canonical.bitbucketMergeEvidence = { source: evidence.source };

      for (const statusOnly of [true, false]) {
        restart();
        expect(await recoveredRun(auth, aggregateRequest, statusOnly)).toMatchObject(
          condition === 'valid'
            ? { status: 'confirmed', reference: { kind: 'review', id: '7' } }
            : {
                status: 'partial',
                retry: 'unfinished-only',
                items: [
                  {
                    itemId: 'merge',
                    effect: 'merge',
                    result:
                      condition === 'missing child'
                        ? { status: 'rejected', code: 'operation_not_admitted', retry: 'same-key' }
                        : {
                            status: 'unresolved',
                            reason: 'merge_identity_unavailable',
                            retry: 'reconcile',
                          },
                  },
                  {
                    itemId: 'deleteBranch',
                    effect: 'deleteBranch',
                    result: { status: 'confirmed' },
                  },
                ],
              }
        );
        expect(effects).toEqual(['merge']);
        expect(rows.size).toBe(condition === 'missing child' ? 2 : 3);
      }
    }
  );

  it.each(['throw', 'no row'] as const)(
    'AC7 sends no merge when evidence persistence returns %s',
    async failure => {
      const progress = jest.mocked(recordOperationProgress).getMockImplementation()!;
      jest.mocked(recordOperationProgress).mockImplementation(async (database, rowId, patch) => {
        if (patch.bitbucketMergeEvidence) {
          if (failure === 'throw') throw new Error('Storage unavailable');
          return null;
        }
        return progress(database, rowId, patch);
      });
      expect(await recoveredRun(auth, mergeRequest)).toMatchObject({
        status: 'rejected',
        code: 'preflight_unavailable',
        retry: 'same-key',
      });
      expect(effects).toEqual([]);
      expect(pr.state).toBe('OPEN');
      jest.mocked(recordOperationProgress).mockImplementation(progress);
      expect(await recoveredRun(auth, mergeRequest)).toMatchObject({ status: 'confirmed' });
      expect(effects).toEqual(['merge']);
    }
  );

  it('AC7 rejects evidence that cannot fit the existing ledger before sending a merge', async () => {
    pr.source.branch.name = 's'.repeat(2000);
    pr.destination.branch.name = 'd'.repeat(2000);
    expect(await recoveredRun(auth, mergeRequest)).toMatchObject({
      status: 'rejected',
      code: 'preflight_unavailable',
      retry: 'same-key',
    });
    expect(effects).toEqual([]);
    expect(pr.state).toBe('OPEN');
    expect(Buffer.byteLength(JSON.stringify(row().canonical_result))).toBeLessThan(4096);
  });
});
