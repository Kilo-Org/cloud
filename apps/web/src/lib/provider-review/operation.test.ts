jest.mock('@/lib/drizzle', () => ({ db: { select: jest.fn() } }));
jest.mock('@kilocode/db/operation-ledger', () => ({
  ...jest.requireActual('@kilocode/db/operation-ledger'),
  admitOperation: jest.fn(),
  recordOperationProgress: jest.fn(),
  recordOperationAcceptance: jest.fn(),
  settleOperation: jest.fn(),
  markReconcilePending: jest.fn(),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '@/lib/drizzle';
import { user_terms_acceptances, type OperationLedgerRow } from '@kilocode/db/schema';
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
import { providerReviewFixtures } from '@kilocode/app-shared/provider-review/fixtures';
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
