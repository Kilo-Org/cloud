/**
 * Integration tests for the shared operation ledger (P1-A-08a / DEC-01).
 *
 * Runs against the per-worker PostgreSQL test database migrated by
 * `apps/web/src/tests/setup/workerSetup.ts`. Covers the ledger state machine:
 * concurrent same-key admit, duplicate replay, double settle, atomic
 * settle-plus-outbox, canonical-result bound, expiration, lease takeover,
 * reconcile-pending, deterministic event UUID, progress, and provider ref.
 */
import { randomUUID } from 'crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { analytics_event_outbox, operation_ledgers } from '@kilocode/db/schema';
import type { AnalyticsEventMap } from '@kilocode/app-shared/analytics';
import {
  admitOperation,
  settleOperation,
  markReconcilePending,
  recordOperationProgress,
  recordOperationAcceptance,
  setOperationProviderRef,
  computeEventUuid,
  CanonicalResultTooLargeError,
  OutboxEventValidationError,
  type OutboxEventInput,
} from '@kilocode/db/operation-ledger';

const SESSION_DOMAIN = 'session' as const;

function terminalSessionEvent(
  properties?: Partial<AnalyticsEventMap['session_create_settled']>
): OutboxEventInput {
  return {
    eventName: 'session_create_settled',
    distinctId: 'user@example.com',
    properties: {
      source: 'server',
      surface: 'session',
      phase: 'terminal',
      creation_target: 'cloud',
      outcome: 'completed',
      admission: 'new',
      duration_ms: 120,
      in_organization: false,
      ...properties,
    },
  };
}

async function admitSession(userId = 'ledger-user', operationKey: string = randomUUID()) {
  return admitOperation(db, {
    userId,
    domain: SESSION_DOMAIN,
    intent: 'create_cloud',
    operationKey,
    taxonomy: 'safe-retry',
    leaseSeconds: 60,
  });
}

describe('operation ledger (integration)', () => {
  beforeEach(async () => {
    await db.delete(analytics_event_outbox).where(sql`true`);
    await db.delete(operation_ledgers).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(analytics_event_outbox).where(sql`true`);
    await db.delete(operation_ledgers).where(sql`true`);
  });

  it('admits a fresh operation and settles it to a terminal status', async () => {
    const admitted = await admitSession();
    expect(admitted.admission).toBe('admitted');
    if (admitted.admission !== 'admitted') return;

    const settled = await settleOperation(db, {
      rowId: admitted.row.id,
      status: 'completed',
      outcomeCode: 'ok',
    });
    expect(settled.settled).toBe(true);
    if (!settled.settled) return;
    expect(settled.row.status).toBe('completed');
    expect(settled.row.outcome_code).toBe('ok');
    expect(settled.row.settled_at).not.toBeNull();
  });

  it('produces exactly one winner under concurrent same-key admits', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        admitOperation(db, {
          userId: 'concurrent-user',
          domain: SESSION_DOMAIN,
          intent: 'create_cloud',
          operationKey: 'concurrent-key',
          taxonomy: 'safe-retry',
          leaseSeconds: 60,
        })
      )
    );

    const winners = results.filter(r => r.admission === 'admitted');
    expect(winners).toHaveLength(1);
    expect(results.filter(r => r.admission === 'duplicate_in_flight')).toHaveLength(
      results.length - 1
    );

    const rows = await db
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.kilo_user_id, 'concurrent-user'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('admitted');
  });

  it('reports duplicate_settled on replay after a terminal settle', async () => {
    const admitted = await admitSession('replay-user');
    if (admitted.admission !== 'admitted') return;

    await settleOperation(db, { rowId: admitted.row.id, status: 'completed' });

    const replay = await admitSession('replay-user', admitted.row.operation_key);
    expect(replay.admission).toBe('duplicate_settled');
    if (replay.admission !== 'duplicate_settled') return;
    expect(replay.row.id).toBe(admitted.row.id);
  });

  it('reports duplicate_in_flight while the lease is live', async () => {
    const first = await admitSession('in-flight-user');
    if (first.admission !== 'admitted') return;

    const second = await admitSession('in-flight-user', first.row.operation_key);
    expect(second.admission).toBe('duplicate_in_flight');
  });

  it('treats a second settle as a no-op', async () => {
    const admitted = await admitSession('double-settle-user');
    if (admitted.admission !== 'admitted') return;

    const first = await settleOperation(db, {
      rowId: admitted.row.id,
      status: 'failed',
      outcomeCode: 'err',
    });
    expect(first.settled).toBe(true);

    const second = await settleOperation(db, {
      rowId: admitted.row.id,
      status: 'completed',
      outcomeCode: 'ok',
    });
    expect(second.settled).toBe(false);
    if (!second.row) return;
    expect(second.row.status).toBe('failed');
    expect(second.row.outcome_code).toBe('err');
  });

  it('writes the outbox row atomically with the deterministic event uuid', async () => {
    const admitted = await admitSession('outbox-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const settled = await settleOperation(db, {
      rowId,
      status: 'completed',
      outboxEvent: terminalSessionEvent(),
    });
    expect(settled.settled).toBe(true);

    const expectedUuid = await computeEventUuid(rowId, 'session_create_settled');
    const outboxRows = await db.select().from(analytics_event_outbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.event_uuid).toBe(expectedUuid);
    expect(outboxRows[0]?.distinct_id).toBe('user@example.com');
    expect(outboxRows[0]?.status).toBe('pending');
    expect(outboxRows[0]?.attempts).toBe(0);
    expect(outboxRows[0]?.properties).toMatchObject({ outcome: 'completed' });
  });

  it('rolls back the settle when the outbox event fails validation', async () => {
    const admitted = await admitSession('rollback-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const invalidEvent = terminalSessionEvent({ duration_ms: -5 });

    await expect(
      settleOperation(db, { rowId, status: 'completed', outboxEvent: invalidEvent })
    ).rejects.toBeInstanceOf(OutboxEventValidationError);

    const [row] = await db.select().from(operation_ledgers).where(eq(operation_ledgers.id, rowId));
    expect(row?.status).toBe('admitted');
    expect(await db.select().from(analytics_event_outbox)).toHaveLength(0);
  });

  it('emits only one outbox event per (ledger row, event name)', async () => {
    const admitted = await admitSession('dedupe-event-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    await markReconcilePending(db, {
      rowId,
      outboxEvent: terminalSessionEvent({ outcome: 'ambiguous' }),
    });
    await settleOperation(db, {
      rowId,
      status: 'completed',
      outboxEvent: terminalSessionEvent(),
    });

    const outboxRows = await db.select().from(analytics_event_outbox);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.properties).toMatchObject({ outcome: 'ambiguous' });
  });

  it('rejects a canonical_result over the serialized bound and leaves the row admitted', async () => {
    const admitted = await admitSession('bound-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const oversized: Record<string, unknown> = { pad: 'x'.repeat(5000) };
    await expect(
      settleOperation(db, { rowId, status: 'completed', canonicalResult: oversized })
    ).rejects.toBeInstanceOf(CanonicalResultTooLargeError);

    // The bound applies to the merged result, so progress plus a settle can
    // also exceed it.
    await recordOperationProgress(db, rowId, { pad: 'y'.repeat(3000) });
    await expect(
      settleOperation(db, {
        rowId,
        status: 'completed',
        canonicalResult: { pad2: 'z'.repeat(2000) },
      })
    ).rejects.toBeInstanceOf(CanonicalResultTooLargeError);

    const [row] = await db.select().from(operation_ledgers).where(eq(operation_ledgers.id, rowId));
    expect(row?.status).toBe('admitted');
  });

  it('rejects oversized progress merges atomically and preserves prior canonical result', async () => {
    const admitted = await admitSession('progress-bound-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    await recordOperationProgress(db, rowId, { phase: 'allocated', id: 'abc' });

    const oversized: Record<string, unknown> = { pad: 'x'.repeat(5000) };
    await expect(recordOperationProgress(db, rowId, oversized)).rejects.toBeInstanceOf(
      CanonicalResultTooLargeError
    );

    // The rejected merge must leave the row admitted with the prior result.
    const [row] = await db.select().from(operation_ledgers).where(eq(operation_ledgers.id, rowId));
    expect(row?.status).toBe('admitted');
    expect(row?.canonical_result).toMatchObject({ phase: 'allocated', id: 'abc' });
    expect(row?.canonical_result).not.toHaveProperty('pad');
  });

  it('deletes an expired row and re-admits it fresh', async () => {
    const admitted = await admitSession('expire-user');
    if (admitted.admission !== 'admitted') return;
    const oldId = admitted.row.id;

    await db
      .update(operation_ledgers)
      .set({ expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(operation_ledgers.id, oldId));

    const replay = await admitSession('expire-user', admitted.row.operation_key);
    expect(replay.admission).toBe('admitted');
    if (replay.admission !== 'admitted') return;
    expect(replay.row.id).not.toBe(oldId);

    const rows = await db
      .select()
      .from(operation_ledgers)
      .where(
        and(
          eq(operation_ledgers.kilo_user_id, 'expire-user'),
          eq(operation_ledgers.operation_key, admitted.row.operation_key)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(replay.row.id);
  });

  it('takes over an expired-lease admitted row with a renewed lease', async () => {
    const admitted = await admitSession('takeover-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    await db
      .update(operation_ledgers)
      .set({ lease_expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(operation_ledgers.id, rowId));

    const takeover = await admitSession('takeover-user', admitted.row.operation_key);
    expect(takeover.admission).toBe('takeover');
    if (takeover.admission !== 'takeover') return;
    expect(takeover.row.id).toBe(rowId);
    expect(new Date(takeover.row.lease_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('transitions to reconcile_pending and re-admit reports duplicate_reconcile_pending', async () => {
    const admitted = await admitSession('reconcile-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const reconciled = await markReconcilePending(db, { rowId });
    expect(reconciled?.status).toBe('reconcile_pending');

    const replay = await admitSession('reconcile-user', admitted.row.operation_key);
    expect(replay.admission).toBe('duplicate_reconcile_pending');

    const settled = await settleOperation(db, { rowId, status: 'completed' });
    expect(settled.settled).toBe(true);

    // A reconcile after a terminal settle is a no-op that returns the row.
    const lateReconcile = await markReconcilePending(db, { rowId });
    expect(lateReconcile?.status).toBe('completed');
  });

  it('serializes concurrent reconcile retries behind exactly one lease claim', async () => {
    const admitted = await admitSession('concurrent-reconcile-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    // The transition makes the reconciliation lease immediately claimable.
    await markReconcilePending(db, { rowId });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        admitSession('concurrent-reconcile-user', admitted.row.operation_key)
      )
    );

    // Exactly one retry holds the reconciliation lease and may run the effect.
    expect(results.filter(r => r.admission === 'duplicate_reconcile_pending')).toHaveLength(1);
    // Every other retry sees the live reconciliation lease and must not run it.
    expect(results.filter(r => r.admission === 'duplicate_reconcile_in_progress')).toHaveLength(
      results.length - 1
    );

    const claim = results.find(r => r.admission === 'duplicate_reconcile_pending');
    expect(claim).toBeDefined();
    expect(new Date(claim?.row.lease_expires_at ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  it('takes over an expired reconciliation lease after a crashed reconciler', async () => {
    const admitted = await admitSession('reconcile-takeover-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    await markReconcilePending(db, { rowId });

    // The first retry atomically claims the claimable lease and reconciles.
    const claim = await admitSession('reconcile-takeover-user', admitted.row.operation_key);
    expect(claim.admission).toBe('duplicate_reconcile_pending');
    if (claim.admission !== 'duplicate_reconcile_pending') return;

    // While the reconciler holds the lease, a retry reports in-progress.
    const inProgress = await admitSession('reconcile-takeover-user', admitted.row.operation_key);
    expect(inProgress.admission).toBe('duplicate_reconcile_in_progress');

    // The reconciler crashes; its lease expires.
    await db
      .update(operation_ledgers)
      .set({ lease_expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(operation_ledgers.id, rowId));

    // A later retry takes over the expired reconciliation lease and may reconcile.
    const takeover = await admitSession('reconcile-takeover-user', admitted.row.operation_key);
    expect(takeover.admission).toBe('duplicate_reconcile_pending');
    if (takeover.admission !== 'duplicate_reconcile_pending') return;
    expect(takeover.row.id).toBe(rowId);
    expect(new Date(takeover.row.lease_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('records fresh allocation progress on a reconcile_pending row', async () => {
    const admitted = await admitSession('reconcile-progress-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    await markReconcilePending(db, { rowId });
    const replay = await admitSession('reconcile-progress-user', admitted.row.operation_key);
    expect(replay.admission).toBe('duplicate_reconcile_pending');

    // A fresh takeover allocation under the reconcile_pending row must persist
    // its new IDs: the next retry reconciles them instead of allocating again.
    const progress = await recordOperationProgress(db, rowId, {
      cloudAgentSessionId: 'agent_allocated',
      kiloSessionId: 'ses_allocated',
    });
    expect(progress?.status).toBe('reconcile_pending');
    expect(progress?.canonical_result).toMatchObject({
      cloudAgentSessionId: 'agent_allocated',
      kiloSessionId: 'ses_allocated',
    });

    // The 4096 serialized-byte bound still applies to progress on the row.
    const oversized: Record<string, unknown> = { pad: 'x'.repeat(5000) };
    await expect(recordOperationProgress(db, rowId, oversized)).rejects.toBeInstanceOf(
      CanonicalResultTooLargeError
    );

    const [row] = await db.select().from(operation_ledgers).where(eq(operation_ledgers.id, rowId));
    expect(row?.status).toBe('reconcile_pending');
    expect(row?.canonical_result).toMatchObject({
      cloudAgentSessionId: 'agent_allocated',
      kiloSessionId: 'ses_allocated',
    });
    expect(row?.canonical_result).not.toHaveProperty('pad');

    // A retry within the live reconciliation lease reports in-progress; the
    // row still carries the recorded IDs for the later reconciliation.
    const retry = await admitSession('reconcile-progress-user', admitted.row.operation_key);
    expect(retry.admission).toBe('duplicate_reconcile_in_progress');
    if (retry.admission !== 'duplicate_reconcile_in_progress') return;
    expect(retry.row.canonical_result).toMatchObject({
      cloudAgentSessionId: 'agent_allocated',
      kiloSessionId: 'ses_allocated',
    });
  });

  it('merges recordOperationProgress into canonical_result while admitted', async () => {
    const admitted = await admitSession('progress-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const first = await recordOperationProgress(db, rowId, { phase: 'allocated', id: 'abc' });
    expect(first?.canonical_result).toMatchObject({ phase: 'allocated', id: 'abc' });

    const second = await recordOperationProgress(db, rowId, { step: 2 });
    expect(second?.canonical_result).toMatchObject({ phase: 'allocated', id: 'abc', step: 2 });

    await settleOperation(db, {
      rowId,
      status: 'completed',
      canonicalResult: { final: true },
    });
    const [row] = await db.select().from(operation_ledgers).where(eq(operation_ledgers.id, rowId));
    expect(row?.canonical_result).toMatchObject({ phase: 'allocated', step: 2, final: true });

    // Progress after a terminal settle must not touch the row.
    expect(await recordOperationProgress(db, rowId, { late: true })).toBeNull();
  });

  it('fences progress on the current queue-send claim id', async () => {
    const admitted = await admitSession('claim-fence-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    // The first sender records its queue-send claim.
    const firstClaim = await recordOperationProgress(db, rowId, {
      queueAdmitted: false,
      queueSendClaimedUntil: new Date(Date.now() + 60_000).toISOString(),
      queueSendClaimId: 'claim-a',
    });
    expect(firstClaim?.canonical_result).toMatchObject({
      queueAdmitted: false,
      queueSendClaimId: 'claim-a',
    });

    // The queue-send lease lapses and a newer sender replaces the claim.
    const newerClaim = await recordOperationProgress(db, rowId, {
      queueAdmitted: false,
      queueSendClaimedUntil: new Date(Date.now() + 60_000).toISOString(),
      queueSendClaimId: 'claim-b',
    });
    expect(newerClaim?.canonical_result).toMatchObject({ queueSendClaimId: 'claim-b' });

    // A stale sender naming the superseded claim must not confirm or clear
    // the newer claim: the CAS returns null and the row keeps claim-b.
    const stale = await recordOperationProgress(
      db,
      rowId,
      {
        queueAdmitted: true,
        queueSendClaimedUntil: new Date(0).toISOString(),
        queueSendClaimId: null,
      },
      { expectedQueueSendClaimId: 'claim-a' }
    );
    expect(stale).toBeNull();

    const [fenced] = await db
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, rowId));
    expect(fenced?.canonical_result).toMatchObject({
      queueAdmitted: false,
      queueSendClaimId: 'claim-b',
    });
    const newerLease = fenced?.canonical_result?.queueSendClaimedUntil as string | undefined;
    expect(newerLease).toBeDefined();
    expect(Date.parse(newerLease!)).toBeGreaterThan(Date.now());

    // The current claim holder can still update the row with its own id.
    const current = await recordOperationProgress(
      db,
      rowId,
      {
        queueAdmitted: true,
        queueSendClaimedUntil: new Date(0).toISOString(),
        queueSendClaimId: null,
      },
      { expectedQueueSendClaimId: 'claim-b' }
    );
    expect(current?.canonical_result).toMatchObject({ queueAdmitted: true });
    expect(current?.canonical_result?.queueSendClaimId).toBeNull();
  });

  it('overwrites the provider ref', async () => {
    const admitted = await admitSession('provider-ref-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const updated = await setOperationProviderRef(db, { rowId, providerRef: 'prov-1' });
    expect(updated?.provider_ref).toBe('prov-1');

    const cleared = await setOperationProviderRef(db, { rowId, providerRef: null });
    expect(cleared?.provider_ref).toBeNull();
  });

  it('records provider_ref and canonical_result atomically in one acceptance call', async () => {
    const admitted = await admitSession('acceptance-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    const updated = await recordOperationAcceptance(db, {
      rowId,
      providerRef: 'msg-1',
      canonicalResult: { commandId: 'cmd-1', runId: 'run-1', messageId: 'msg-1' },
    });
    expect(updated?.provider_ref).toBe('msg-1');
    expect(updated?.canonical_result).toMatchObject({
      commandId: 'cmd-1',
      runId: 'run-1',
      messageId: 'msg-1',
    });

    // A second acceptance on the same row overwrites provider_ref and merges
    // the correlation data, as a takeover re-submit does.
    const reaccepted = await recordOperationAcceptance(db, {
      rowId,
      providerRef: 'msg-2',
      canonicalResult: { commandId: 'cmd-2', runId: 'run-2', messageId: 'msg-2' },
    });
    expect(reaccepted?.provider_ref).toBe('msg-2');
    expect(reaccepted?.canonical_result).toMatchObject({
      commandId: 'cmd-2',
      runId: 'run-2',
      messageId: 'msg-2',
    });
  });

  it('leaves NO partial acceptance state when the atomic write fails', async () => {
    const admitted = await admitSession('acceptance-failure-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    // An oversized merged result must throw BEFORE either column is written:
    // provider_ref and canonical_result commit together or not at all. A
    // partial provider_ref would let a same-key retry blind-duplicate the
    // command against an un-recorded acceptance.
    const oversized: Record<string, unknown> = { pad: 'x'.repeat(5000) };
    await expect(
      recordOperationAcceptance(db, {
        rowId,
        providerRef: 'msg-partial',
        canonicalResult: oversized,
      })
    ).rejects.toBeInstanceOf(CanonicalResultTooLargeError);

    const [row] = await db.select().from(operation_ledgers).where(eq(operation_ledgers.id, rowId));
    expect(row?.status).toBe('admitted');
    expect(row?.provider_ref).toBeNull();
    expect(row?.canonical_result).toBeNull();
  });

  it('returns null for an acceptance record on a terminal or missing row', async () => {
    const admitted = await admitSession('acceptance-terminal-user');
    if (admitted.admission !== 'admitted') return;
    const rowId = admitted.row.id;

    await settleOperation(db, { rowId, status: 'completed' });
    expect(
      await recordOperationAcceptance(db, {
        rowId,
        providerRef: 'msg-1',
        canonicalResult: { commandId: 'cmd-1' },
      })
    ).toBeNull();

    expect(
      await recordOperationAcceptance(db, {
        rowId: '00000000-0000-4000-8000-000000000000',
        providerRef: 'msg-1',
        canonicalResult: { commandId: 'cmd-1' },
      })
    ).toBeNull();
  });

  it('computes a deterministic UUIDv5 per (rowId, eventName)', async () => {
    const rowId = randomUUID();
    const first = await computeEventUuid(rowId, 'session_create_settled');
    const second = await computeEventUuid(rowId, 'session_create_settled');
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const other = await computeEventUuid(rowId, 'pr_operation_settled');
    expect(other).not.toBe(first);
  });
});
