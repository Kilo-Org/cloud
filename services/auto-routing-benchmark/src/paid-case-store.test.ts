/**
 * Adversarial SQLite suite for the paid case store.
 *
 * The store decides who may measure a model request and which account pays it, so these
 * tests run the real statements against real SQLite (the same migration set the Worker
 * applies) instead of stubs. Billing is just-in-time: usage arrives as a receipt keyed by
 * a native usage id and D1 never sends a charge.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import type { PaidCaseKey, PaidCaseRunRow, PaidCreditOwner } from './paid-case-store';
import { completePaidCaseStatements } from './db';
import {
  acceptPaidAttemptUsageStatements,
  activatePaidBenchmarkRequestStatements,
  admitPaidModelRequestStatements,
  cancelPaidCaseStatements,
  claimPaidBillingOutbox,
  claimPaidCaseCancellations,
  claimPaidCaseStatements,
  completePaidBenchmarkRequestStatements,
  createPaidBenchmarkQuote,
  enqueuePaidCaseBatchStatements,
  enqueuePaidCaseStatements,
  enqueuePaidPoolPinsStatement,
  failPaidBillingOutbox,
  markPaidBillingOutboxDelivered,
  paidCaseClaimOutcome,
  paidCaseEnqueueOutcome,
  paidModelRequestAdmission,
  paidUnfundedStopOutcome,
  pausePaidUnfundedCaseStatements,
  paidModelRequestOutcome,
  PAID_CASE_BATCH_LIMIT,
  pausePaidBenchmarkRequestStatements,
  platformCoverageStatements,
  readPaidBenchmarkProgress,
  readPaidBenchmarkRequest,
  readPaidCasePayers,
  readPaidCaseRun,
  readPoolRequestActorUserId,
  readPaidModelRequest,
  refusePaidModelRequestStatements,
  releasePaidCaseGenerationStatements,
  selectPaidModelRequestPayerStatements,
  startPaidBenchmarkRequestStatements,
} from './paid-case-store';

const ENGINE = 'engine-test';
const MODEL = 'openai/gpt-test';
const CASE = 'case-1';

const POOL_PROJECT_ID = 'Auto-routing benchmarks / user/pool/router-1';
const PLATFORM_PROJECT_ID = 'Auto-routing benchmarks / platform';
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const ASSIGNMENT_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ASSIGNMENT_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USAGE_1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USAGE_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const alice: PaidCreditOwner = { ownerType: 'user', ownerId: 'alice' };
const bob: PaidCreditOwner = { ownerType: 'user', ownerId: 'bob' };
const acme: PaidCreditOwner = { ownerType: 'organization', ownerId: 'acme' };

function key(overrides: Partial<PaidCaseKey> = {}): PaidCaseKey {
  return {
    engineIdentity: ENGINE,
    model: MODEL,
    variant: '',
    rep: 0,
    caseId: CASE,
    ...overrides,
  };
}

type BatchResult = { results: Record<string, unknown>[]; meta: { changes: number } };

function lastRow<T>(results: unknown[]): T | null {
  const last = results[results.length - 1] as BatchResult;
  return (last.results[0] as T | undefined) ?? null;
}

function outbox(sqlite: DatabaseSync) {
  return sqlite.prepare(`SELECT * FROM paid_benchmark_billing_outbox ORDER BY seq`).all() as Array<
    Record<string, unknown>
  >;
}

function usageOf(sqlite: DatabaseSync) {
  return sqlite.prepare(`SELECT * FROM paid_attempt_usage ORDER BY usage_id`).all() as Array<
    Record<string, unknown>
  >;
}

async function seedRequest(
  db: D1Database,
  id: string,
  owner: PaidCreditOwner,
  planCases = 1,
  maximumMicrodollars = 10_000_000,
  routerId = `router-${id}`
) {
  await createPaidBenchmarkQuote(db, {
    id: `quote-${id}`,
    owner,
    router: 'efficient',
    routerId,
    poolVersion: 'v1',
    engineIdentity: ENGINE,
    context: '{}',
    plan: JSON.stringify({ projectId: POOL_PROJECT_ID }),
    estimateMicrodollars: maximumMicrodollars,
    maximumMicrodollars,
    planCases,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  await db.batch(
    startPaidBenchmarkRequestStatements(db, {
      quoteId: `quote-${id}`,
      requestId: id,
      actorUserId: 'actor-1',
    })
  );
}

function seedRun(sqlite: DatabaseSync, runId: string, status = 'running') {
  sqlite
    .prepare(
      `INSERT INTO benchmark_runs (
        id, kind, status, started_at, min_accuracy, switch_cost_factor, max_concurrency,
        engine_identity, repetitions, purpose, measurement_revision
      ) VALUES (?, 'decider', ?, '2026-01-01T00:00:00.000Z', 0.7, 0.5, 4, ?, 1, 'user', 3)`
    )
    .run(runId, status, ENGINE);
}

function seedChunk(
  sqlite: DatabaseSync,
  input: {
    chunkId: string;
    runId: string;
    token: string;
    slot: number;
    caseId?: string;
    status?: string;
    leaseUntil?: number;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO scheduler_chunks (
        id, run_id, model, variant, providers, rep, chunk, case_ids, status, token, slot,
        lease_until, available_at, attempts
      ) VALUES (?, ?, ?, '', '[]', 0, 0, ?, ?, ?, ?, ?, 0, 0)`
    )
    .run(
      input.chunkId,
      input.runId,
      MODEL,
      JSON.stringify([input.caseId ?? CASE]),
      input.status ?? 'active',
      input.token,
      input.slot,
      input.leaseUntil ?? Date.now() + 600_000
    );
}

async function claim(
  db: D1Database,
  input: { key?: PaidCaseKey; runId: string; token: string; platform?: boolean }
) {
  const caseKey = input.key ?? key();
  const executor = { runId: input.runId, token: input.token };
  const results = await db.batch(
    claimPaidCaseStatements(db, { key: caseKey, executor, platform: input.platform })
  );
  return paidCaseClaimOutcome(lastRow<PaidCaseRunRow>(results), executor);
}

/** Stage one case and activate the request (a one-slot plan unless a test stages more). */
async function enqueue(db: D1Database, requestId: string) {
  const results = await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId }));
  await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId }));
  return paidCaseEnqueueOutcome(lastRow<PaidCaseRunRow>(results));
}

async function stage(db: D1Database, requestId: string, caseKey = key()) {
  const results = await db.batch(enqueuePaidCaseStatements(db, { key: caseKey, requestId }));
  return paidCaseEnqueueOutcome(lastRow<PaidCaseRunRow>(results));
}

async function selectModelRequest(
  db: D1Database,
  input: {
    key?: PaidCaseKey;
    generation: number;
    modelRequestId: string;
    assignmentId?: string;
    usageId?: string;
    platformOrganizationId?: string | null;
  }
) {
  const results = await db.batch(
    selectPaidModelRequestPayerStatements(db, {
      key: input.key ?? key(),
      generation: input.generation,
      modelRequestId: input.modelRequestId,
      assignmentId: input.assignmentId ?? ASSIGNMENT_1,
      api: 'chat/completions',
      executorUserId: 'actor-1',
      usageId: input.usageId ?? USAGE_1,
      platformOrganizationId: input.platformOrganizationId,
    })
  );
  return paidModelRequestOutcome(results as never) as unknown as Record<string, unknown> | null;
}

async function admitModelRequest(
  db: D1Database,
  input: {
    key?: PaidCaseKey;
    generation: number;
    modelRequestId: string;
    assignmentId: string;
  }
) {
  const results = await db.batch(
    admitPaidModelRequestStatements(db, {
      key: input.key ?? key(),
      generation: input.generation,
      modelRequestId: input.modelRequestId,
      assignmentId: input.assignmentId,
    })
  );
  return lastRow<Record<string, unknown>>(results);
}

async function caseRun(db: D1Database, caseKey: PaidCaseKey = key()) {
  const run = await readPaidCaseRun(db, caseKey);
  expect(run).not.toBeNull();
  return run as PaidCaseRunRow;
}

async function acceptUsage(
  db: D1Database,
  input: {
    assignmentId: string;
    usageId: string;
    owner: PaidCreditOwner;
    microdollars: number;
    generation: number;
    projectId?: string | null;
    platformOrganizationId?: string | null;
  }
) {
  await db.batch(
    acceptPaidAttemptUsageStatements(db, {
      assignmentId: input.assignmentId,
      usageId: input.usageId,
      microdollars: input.microdollars,
      expected: {
        owner: input.owner,
        model: MODEL,
        variant: '',
        caseId: CASE,
        generation: input.generation,
        projectId: input.projectId ?? POOL_PROJECT_ID,
        platformOrganizationId: input.platformOrganizationId,
      },
    })
  );
}

/** Select and admit one model request; returns its stored assignment identity. */
async function payModelRequest(
  db: D1Database,
  input: {
    generation: number;
    modelRequestId: string;
    assignmentId?: string;
    usageId?: string;
    platformOrganizationId?: string | null;
  }
) {
  const assignmentId = input.assignmentId ?? ASSIGNMENT_1;
  const selected = await selectModelRequest(db, { ...input, assignmentId });
  expect(selected?.state).toBe('selecting');
  await admitModelRequest(db, {
    generation: input.generation,
    modelRequestId: input.modelRequestId,
    assignmentId,
  });
  return { assignmentId, row: await readPaidModelRequest(db, input.modelRequestId) };
}

describe('case-run claim fence', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedRun(sqlite, 'run-2');
  });

  it('starts one generation and attaches the second run without inferring', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    const first = await claim(db, { runId: 'run-1', token: 'token-1' });
    expect(first.outcome).toBe('started');

    seedChunk(sqlite, { chunkId: 'chunk-2', runId: 'run-2', token: 'token-2', slot: 2 });
    const second = await claim(db, { runId: 'run-2', token: 'token-2' });
    expect(second.outcome).toBe('attached');

    const run = await caseRun(db);
    expect(run.status).toBe('running');
    expect(run.generation).toBe(2);
    expect(run.executor_run_id).toBe('run-1');
    const execution = sqlite.prepare(`SELECT * FROM scheduler_executions`).all() as Array<
      Record<string, unknown>
    >;
    expect(execution).toHaveLength(1);
    expect(execution[0].run_id).toBe('run-1');
  });

  it('fences a claim whose chunk guard no longer holds', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });

    const lost = await claim(db, { runId: 'run-1', token: 'stale-token' });
    expect(lost.outcome).toBe('fenced');
    expect(lost.run?.status).toBe('queued');
  });

  it('does not start a case whose lane already dead-lettered', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    sqlite
      .prepare(
        `INSERT INTO run_lane_failures (run_id, model, variant, rep, chunk, shard, failed_at)
        VALUES ('run-1', ?, '', 0, 0, 0, '2026-01-01T00:00:00.000Z')`
      )
      .run(MODEL);

    const result = await claim(db, { runId: 'run-1', token: 'token-1' });
    expect(result.outcome).toBe('fenced');
  });

  it('reuses a settled case and never starts another inference', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        resultUsable: true,
        settlementId: 'settle-1',
      })
    );

    seedChunk(sqlite, { chunkId: 'chunk-2', runId: 'run-2', token: 'token-2', slot: 2 });
    const second = await claim(db, { runId: 'run-2', token: 'token-2' });
    expect(second.outcome).toBe('reused');
    expect(await caseRun(db)).toMatchObject({ status: 'settled', result_usable: 1 });
  });

  it('releases a known-unbilled generation back to queued without touching payers', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    await db.batch(
      releasePaidCaseGenerationStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
      })
    );
    expect(await caseRun(db)).toMatchObject({
      status: 'queued',
      generation: run.generation,
      executor_run_id: null,
    });

    const reclaim = await claim(db, { runId: 'run-1', token: 'token-1' });
    expect(reclaim.outcome).toBe('started');
    expect((await caseRun(db)).generation).toBe(run.generation + 1);
  });

  it('never releases a generation that already admitted a native model request', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({ state: 'admitted' });

    // The provider may have run, so an "unbilled" heuristic must not reopen the slot.
    await db.batch(
      releasePaidCaseGenerationStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
      })
    );
    expect(await caseRun(db)).toMatchObject({
      status: 'running',
      generation: run.generation,
      executor_run_id: 'run-1',
      result_usable: 0,
    });
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({ state: 'admitted' });
  });

  it('still releases a generation that never selected a payer', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    await db.batch(
      releasePaidCaseGenerationStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
      })
    );
    expect(await caseRun(db)).toMatchObject({
      status: 'queued',
      generation: run.generation,
      executor_run_id: null,
    });
  });

  it('does not let an old generation settle a newer attempt', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'wrong', generation: run.generation },
        resultUsable: true,
        settlementId: 'settle-old',
      })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'running', result_usable: 0 });
  });
});

describe('per-model request payer selection', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
  });

  it('alternates A/B/A across three model requests of one case', async () => {
    await seedRequest(db, 'request-b', bob);
    await stage(db, 'request-b');
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-b' }));
    const run = await caseRun(db);

    const first = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    expect(first.row).toMatchObject({ state: 'admitted', owner_id: 'alice' });
    await acceptUsage(db, {
      assignmentId: first.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 10,
      generation: run.generation,
    });

    const second = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_2,
    });
    expect(second.row).toMatchObject({ state: 'admitted', owner_id: 'bob' });
    await acceptUsage(db, {
      assignmentId: second.assignmentId,
      usageId: USAGE_2,
      owner: bob,
      microdollars: 12,
      generation: run.generation,
    });

    const third = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_3,
    });
    expect(third.row).toMatchObject({ state: 'admitted', owner_id: 'alice' });
  });

  it('lets the platform take over a later model request in the same case', async () => {
    const run = await caseRun(db);
    const first = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    expect(first.row).toMatchObject({ owner_id: 'alice' });
    await acceptUsage(db, {
      assignmentId: first.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 10,
      generation: run.generation,
    });

    await db.batch(platformCoverageStatements(db, { key: key() }));
    const second = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_2,
      assignmentId: ASSIGNMENT_2,
      platformOrganizationId: 'org-benchmark',
    });
    expect(second.row).toMatchObject({
      state: 'admitted',
      assignment_id: ASSIGNMENT_2,
      platform_covered: 1,
    });
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.charged_microdollars).toBe(10);
  });

  it('never selects a platform-covered call without the paying organization', async () => {
    const run = await caseRun(db);
    await db.batch(platformCoverageStatements(db, { key: key() }));
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // No paying org was supplied, so the row must stay signable-by-nobody rather than
    // carrying a half-built platform assignment the gateway would throw on.
    expect(selected).toMatchObject({ state: 'selecting' });
    expect(selected?.platform_organization_id ?? null).toBeNull();
    expect(selected?.pool_request_id ?? null).toBeNull();
    // Admission then refuses too: nothing can be signed.
    const admitted = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(admitted).changed).toBe(false);
  });

  it('refuses admission after the selected account was detached', async () => {
    const run = await caseRun(db);
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    expect(selected?.owner_id).toEqual(expect.any(String));

    // A trusted payment refusal detaches that account before any upstream call.
    await db.batch(
      refusePaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
        reason: 'payment_refused',
      })
    );
    // Re-create the same selection state the gateway would still be holding, so only the
    // detach guard can stop the admit.
    sqlite
      .prepare(
        `UPDATE paid_model_requests SET state = 'selecting', reason = NULL
        WHERE id = ?`
      )
      .run(UUID_1);
    const admitted = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(admitted).changed).toBe(false);
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({ state: 'selecting' });
  });

  it('blocks admission when the pool request pauses between selection and admission', async () => {
    const run = await caseRun(db);
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    const assignmentId = selected?.assignment_id as string;
    expect(assignmentId).toBe(ASSIGNMENT_1);
    expect(selected?.owner_id).toBe('alice');

    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'owner' })
    );
    const admitted = await admitModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId,
    });
    expect(admitted).toBeNull();
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({
      state: 'selecting',
      assignment_id: ASSIGNMENT_1,
      owner_id: 'alice',
    });
    expect(usageOf(sqlite)).toHaveLength(0);
  });

  it('admits once when two deliveries of the same model request race', async () => {
    const run = await caseRun(db);
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    const assignmentId = selected?.assignment_id as string;

    const [first, second] = await Promise.all([
      admitModelRequest(db, {
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId,
      }),
      admitModelRequest(db, {
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId,
      }),
    ]);
    // Both deliveries may observe the same committed admission (that is the idempotent
    // answer), but exactly one assignment is ever accepted.
    expect(first).toMatchObject({ assignment_id: assignmentId });
    expect(second).toMatchObject({ assignment_id: assignmentId });
    const attempts = sqlite
      .prepare(`SELECT status, assignment_id FROM paid_model_request_attempts`)
      .all() as Array<Record<string, unknown>>;
    expect(attempts).toEqual([{ status: 'accepted', assignment_id: assignmentId }]);
  });

  it('moves from an unfunded A to B, then refuses to admit when nobody is funded', async () => {
    await seedRequest(db, 'request-b', bob);
    await stage(db, 'request-b');
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-b' }));
    const run = await caseRun(db);

    const selectedA = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    const assignmentA = selectedA?.assignment_id as string;
    await db.batch(
      refusePaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: assignmentA,
        reason: 'insufficient funds',
      })
    );
    const selectedB = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_2,
    });
    expect(selectedB?.state).toBe('selecting');
    // The candidate is B now; the assignment stays the gateway's UUID.
    expect(selectedB?.owner_id).toBe('bob');

    // Billing failure for B leaves no eligible account for this generation.
    await db.batch(
      refusePaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_2,
        reason: 'insufficient funds',
      })
    );
    const selectedNone = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    // Both accounts are detached, so this delivery cannot be admitted; it keeps the
    // last gateway assignment so the refusal is answerable, and stays retryable.
    expect(selectedNone).toMatchObject({ state: 'refused' });
    const detached = sqlite
      .prepare(
        `SELECT owner_id FROM benchmark_case_payers WHERE status = 'detached' ORDER BY owner_id`
      )
      .all() as Array<Record<string, unknown>>;
    expect(detached).toEqual([{ owner_id: 'alice' }, { owner_id: 'bob' }]);
  });

  it('never pauses or gates admission on the advisory review amount', async () => {
    // Forecast at the threshold; the forecast is advisory, so the model request still
    // admits. Only the native payer's own refusal can stop a call.
    sqlite
      .prepare(
        `UPDATE paid_benchmark_requests SET charged_microdollars = 100,
          maximum_microdollars = 100 WHERE id = 'request-a'`
      )
      .run();
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    expect(paid.row).toMatchObject({ state: 'admitted', owner_id: 'alice' });
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.status).toBe('active');
  });

  it('refuses a second admission while one native receipt is outstanding', async () => {
    const run = await caseRun(db);
    const first = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });

    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_2,
    });
    const admitted = await admitModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_2,
      assignmentId: selected?.assignment_id as string,
    });
    expect(admitted).toBeNull();

    await acceptUsage(db, {
      assignmentId: first.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 5,
      generation: run.generation,
    });
    expect(
      await admitModelRequest(db, {
        generation: run.generation,
        modelRequestId: UUID_2,
        assignmentId: selected?.assignment_id as string,
      })
    ).toMatchObject({ state: 'admitted' });
  });
});

describe('usage receipts', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
  });

  it('records usage once per stored native usage id and totals it by recomputation', async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 40,
      generation: run.generation,
    });
    // Same metadata: no second receipt, no double count.
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 40,
      generation: run.generation,
    });
    expect(usageOf(sqlite)).toHaveLength(1);
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.charged_microdollars).toBe(40);
    expect(outbox(sqlite)).toHaveLength(0);
  });

  it('ignores a receipt whose native identity does not match the admission', async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    // Wrong owner and wrong usage id: both are refusals, not accounting.
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: 'usage-mismatched',
      owner: bob,
      microdollars: 999,
      generation: run.generation,
    });
    expect(usageOf(sqlite)).toHaveLength(0);
    // A different usage id for an already-receipted request does not add a row either.
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 20,
      generation: run.generation,
    });
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_2,
      owner: alice,
      microdollars: 30,
      generation: run.generation,
    });
    expect(usageOf(sqlite)).toHaveLength(1);
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.charged_microdollars).toBe(20);
  });

  it('counts a late receipt after the pool request paused', async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'owner' })
    );
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 30,
      generation: run.generation,
    });
    expect(usageOf(sqlite)).toHaveLength(1);
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.charged_microdollars).toBe(30);
  });

  it('rejects a receipt for an assignment that was never admitted', async () => {
    const run = await caseRun(db);
    await acceptUsage(db, {
      assignmentId: 'never-admitted',
      usageId: USAGE_2,
      owner: alice,
      microdollars: 999,
      generation: run.generation,
    });
    expect(usageOf(sqlite)).toHaveLength(0);
  });

  it('counts admitted model requests without a receipt, even after a pause', async () => {
    const run = await caseRun(db);
    await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    if (progress.status !== 'active') throw new Error('expected active progress');
    expect(progress.pendingModelRequests).toBe(1);

    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'owner' })
    );
    const paused = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    if (paused.status !== 'paused') throw new Error('expected paused progress');
    expect(paused.pendingModelRequests).toBe(1);

    const paid = await caseRun(db);
    await acceptUsage(db, {
      assignmentId: ASSIGNMENT_1,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 25,
      generation: paid.generation,
    });
    const settled = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    if (settled.status !== 'paused') throw new Error('expected paused progress');
    expect(settled.pendingModelRequests).toBe(0);
    expect(settled.billedModelRequests).toBe(1);
    expect(settled.chargedMicrodollars).toBe(25);
  });

  it('keeps platform-covered usage out of the owner billed count', async () => {
    const run = await caseRun(db);
    await db.batch(platformCoverageStatements(db, { key: key() }));
    // Platform path of the two-step API: the payer row is stored covered and the usage
    // receipt carries the stored platform flag.
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_2,
      usageId: USAGE_1,
      platformOrganizationId: 'org-benchmark',
    });
    expect(paid.row).toMatchObject({
      state: 'admitted',
      platform_covered: 1,
      platform_organization_id: 'org-benchmark',
      assignment_id: ASSIGNMENT_2,
    });
    await acceptUsage(db, {
      assignmentId: ASSIGNMENT_2,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 90,
      generation: run.generation,
      projectId: PLATFORM_PROJECT_ID,
      platformOrganizationId: 'org-benchmark',
    });
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    if (progress.status !== 'active') throw new Error('expected active progress');
    expect(progress).toMatchObject({
      kiloCoveredModelRequests: 1,
      kiloCoveredMicrodollars: 90,
      billedModelRequests: 0,
    });
  });
});

describe('payer rotation stress', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice);
    await seedRequest(db, 'request-b', bob);
    await seedRequest(db, 'request-c', acme);
    for (const id of ['request-a', 'request-b', 'request-c']) await stage(db, id);
    for (const id of ['request-a', 'request-b', 'request-c'])
      await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: id }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
  });

  async function call(
    modelRequestId: string,
    assignmentId: string,
    usageId: string,
    owner: PaidCreditOwner,
    generation: number
  ) {
    const { row } = await payModelRequest(db, { generation, modelRequestId, assignmentId });
    expect(row).toMatchObject({ state: 'admitted' });
    await acceptUsage(db, {
      assignmentId,
      usageId,
      owner,
      microdollars: 10,
      generation,
    });
    return row?.owner_id as string;
  }

  it('refused A continues with B, and refused A+B continues with C', async () => {
    const run = await caseRun(db);

    const first = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    const firstOwner = first?.owner_id as string;
    expect(['alice', 'bob', 'acme']).toContain(firstOwner);
    await db.batch(
      refusePaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
        reason: 'payment_refused',
      })
    );
    const second = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_2,
    });
    expect(second?.owner_id).not.toBe(firstOwner);
    await db.batch(
      refusePaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_2,
        reason: 'payment_refused',
      })
    );
    const third = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: UUID_3,
    });
    expect(third?.owner_id).not.toBe(firstOwner);
    expect(third?.owner_id).not.toBe(second?.owner_id);
    await admitModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: UUID_3,
    });
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({
      state: 'admitted',
      owner_id: third?.owner_id,
    });
    // Refusals leave detached rows (their receipts stay empty); exactly one account is
    // accepted, and it is the one the third selection chose.
    const payers = await readPaidCasePayers(db, key(), run.generation);
    expect(payers.filter(row => row.status === 'accepted').map(row => row.owner_id)).toEqual([
      third?.owner_id,
    ]);
    expect(payers.filter(row => row.status === 'detached')).toHaveLength(2);
  });

  it('rotates A then B across consecutive model requests of one case', async () => {
    const run = await caseRun(db);
    const first = await call(UUID_1, ASSIGNMENT_1, USAGE_1, alice, run.generation);
    const second = await call(UUID_2, ASSIGNMENT_2, USAGE_2, bob, run.generation);
    // Symmetric rotation: the second call goes to a different account than the first.
    expect(second).not.toBe(first);
  });

  it('keeps an admitted call chargeable when the payer pauses afterwards', async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // The receipt must name the account the rotation actually selected.
    const selectedOwner: PaidCreditOwner = {
      ownerType: paid.row?.owner_type ?? 'user',
      ownerId: paid.row?.owner_id as string,
    };
    await db.batch(
      pausePaidBenchmarkRequestStatements(db, {
        requestId: paid.row?.pool_request_id as string,
        reason: 'no_funds',
      })
    );
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: selectedOwner,
      microdollars: 25,
      generation: run.generation,
    });
    const progress = await readPaidBenchmarkProgress(db, {
      requestId: paid.row?.pool_request_id as string,
    });
    if (progress.status !== 'paused') throw new Error('expected paused');
    expect(progress.pendingModelRequests).toBe(0);
    expect(progress.billedModelRequests).toBe(1);
    expect(progress.chargedMicrodollars).toBe(25);
  });

  it('does not let a platform join between selection and admit shift the payer', async () => {
    const run = await caseRun(db);
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    const selectedOwner = selected?.owner_id;
    expect(selectedOwner).toEqual(expect.any(String));
    await db.batch(platformCoverageStatements(db, { key: key() }));
    // The selected pool row may no longer admit; it must never be admitted as the
    // platform's call, so no receipt can be recorded against it.
    await admitModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    const stored = await readPaidModelRequest(db, UUID_1);
    if (stored?.state === 'admitted') {
      expect(stored).toMatchObject({ platform_covered: 0, owner_id: selectedOwner });
    } else {
      expect(stored).toMatchObject({ state: 'selecting' });
    }
    expect(usageOf(sqlite)).toHaveLength(0);
  });

  it('refuses a pool admission when Kilo joined after selection, then reselects as the platform', async () => {
    const run = await caseRun(db);
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    expect(selected?.platform_covered).toBe(0);
    expect(selected?.owner_id).toEqual(expect.any(String));

    // Kilo joins between selection and the permit.
    await db.batch(platformCoverageStatements(db, { key: key() }));
    const refused = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(refused).changed).toBe(false);
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({
      state: 'selecting',
      platform_covered: 0,
    });

    // Re-selecting the same logical request now takes the platform path, and admits once.
    const reselected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
      platformOrganizationId: 'org-benchmark',
    });
    expect(reselected?.platform_covered).toBe(1);
    expect(reselected?.pool_request_id).toBeNull();
    const admitted = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(admitted)).toMatchObject({
      changed: true,
      row: { state: 'admitted', platform_covered: 1 },
    });
    // The second delivery of the same call performs no transition.
    const duplicate = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(duplicate).changed).toBe(false);
  });

  it('detaches an already-eligible payer row on a known refusal', async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // R15 uses the production refusal path (`refusePaidModelRequestStatements`); a real
    // eligible payer row must be detached so the next account can be assigned.
    await db.batch(
      refusePaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: paid.assignmentId,
        reason: 'payment_refused',
      })
    );
    const payers = await readPaidCasePayers(db, key(), run.generation);
    expect(payers).toHaveLength(1);
    expect(payers[0]).toMatchObject({
      owner_id: paid.row?.owner_id,
      status: 'detached',
      reason: 'payment_refused',
    });
    expect(usageOf(sqlite)).toHaveLength(0);
  });

  it('records a platform receipt only for the signed platform organization', async () => {
    const run = await caseRun(db);
    await db.batch(platformCoverageStatements(db, { key: key() }));
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
      platformOrganizationId: 'org-signed',
    });
    expect(paid.row).toMatchObject({ platform_organization_id: 'org-signed' });

    // A different organization cannot claim the call.
    await db.batch(
      acceptPaidAttemptUsageStatements(db, {
        assignmentId: paid.assignmentId,
        usageId: USAGE_1,
        microdollars: 40,
        expected: {
          owner: alice,
          model: MODEL,
          variant: '',
          caseId: CASE,
          generation: run.generation,
          projectId: 'project-1',
          platformOrganizationId: 'org-other',
        },
      })
    );
    expect(usageOf(sqlite)).toHaveLength(0);
    await db.batch(
      acceptPaidAttemptUsageStatements(db, {
        assignmentId: paid.assignmentId,
        usageId: USAGE_1,
        microdollars: 40,
        expected: {
          owner: alice,
          model: MODEL,
          variant: '',
          caseId: CASE,
          generation: run.generation,
          projectId: 'project-1',
          platformOrganizationId: 'org-signed',
        },
      })
    );
    expect(usageOf(sqlite)).toHaveLength(1);
  });

  it('keeps the benchmark executor distinct from the funding actor', async () => {
    const run = await caseRun(db);
    // Production-like inputs: the run snapshot carries the bot executor, the pool request
    // carries the human actor, and the selection call passes no project.
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    const stored = await readPaidModelRequest(db, UUID_1);
    expect(stored).toMatchObject({
      state: 'admitted',
      executor_user_id: 'actor-1',
      project_id: POOL_PROJECT_ID,
    });
    expect(stored?.executor_user_id).not.toBe(paid.row?.pool_request_id);
    expect(await readPoolRequestActorUserId(db, stored?.pool_request_id as string)).toBe('actor-1');
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: { ownerType: paid.row?.owner_type ?? 'user', ownerId: paid.row?.owner_id as string },
      microdollars: 30,
      generation: run.generation,
      projectId: POOL_PROJECT_ID,
    });
    expect(usageOf(sqlite)).toHaveLength(1);
  });

  it('stamps the platform project for a platform-covered call with no pool project', async () => {
    const run = await caseRun(db);
    await db.batch(platformCoverageStatements(db, { key: key() }));
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
      platformOrganizationId: 'org-benchmark',
    });
    expect(paid.row).toMatchObject({
      state: 'admitted',
      platform_covered: 1,
      project_id: PLATFORM_PROJECT_ID,
      pool_request_id: null,
    });
  });

  it('refuses pool admission once the pair is permanently unavailable', async () => {
    const run = await caseRun(db);
    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    expect(selected?.state).toBe('selecting');
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status,
          requested_at, updated_at, platform_requested, user_requested
        ) VALUES ('efficient', ?, '', ?, 1, 'unavailable',
          '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 0, 1)`
      )
      .run(MODEL, ENGINE);
    const refused = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(refused).changed).toBe(false);
    expect(await readPaidModelRequest(db, UUID_1)).toMatchObject({ state: 'selecting' });
  });

  it('does not let another router or older engine permanently block this pair', async () => {
    const run = await caseRun(db);
    await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // A stale verdict on a different router and engine must not block the current pair.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status,
          requested_at, updated_at, platform_requested, user_requested
        ) VALUES ('frontier', ?, '', ?, 3, 'unavailable',
          '2026-11-19T00:00:00.000Z', '2026-11-19T00:00:00.000Z', 0, 1)`
      )
      .run(MODEL, ENGINE);
    const admitted = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(admitted).changed).toBe(true);
    // The current engine's own verdict does block it.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status,
          requested_at, updated_at, platform_requested, user_requested
        ) VALUES ('efficient', ?, '', ?, 1, 'unavailable',
          '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 0, 1)`
      )
      .run(MODEL, ENGINE);
  });

  it('treats an unconfirmed receipt as pending, not as a payment refusal', async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // Pending is scoped to the request that actually owns the admitted call.
    const ownerRequest = paid.row?.pool_request_id as string;
    const progress = await readPaidBenchmarkProgress(db, { requestId: ownerRequest });
    if (progress.status !== 'active') throw new Error('expected active');
    expect(progress.pendingModelRequests).toBe(1);
    // No other request is pended for this owner's call.
    for (const other of ['request-a', 'request-b', 'request-c']) {
      if (other === ownerRequest) continue;
      const otherProgress = await readPaidBenchmarkProgress(db, { requestId: other });
      if (otherProgress.status !== 'active') throw new Error('expected active');
      expect(otherProgress.pendingModelRequests).toBe(0);
    }
    // No receipt yet, so no refusal and no detach: the account stays eligible.
    const payers = await readPaidCasePayers(db, key(), run.generation);
    expect(payers.map(row => row.status)).toEqual(['accepted']);
    expect(usageOf(sqlite)).toHaveLength(0);
  });
});

describe('settlement and cancellation', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
  });

  it('does not settle a case that has no usable result', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        resultUsable: false,
        settlementId: 'settle-1',
      })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'settled', result_usable: 0 });
    const requestCase = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`)
      .get() as Record<string, unknown>;
    expect(requestCase).toEqual({ status: 'queued' });
  });

  it('closes the model request with its accounting receipt and no outbox row', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 75,
      generation: run.generation,
    });
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        resultUsable: true,
        settlementId: 'settle-1',
      })
    );
    // The canonical completion settles the generation and records the accepted usage;
    // it writes no outbox row and never fabricates a charge.
    expect(await caseRun(db)).toMatchObject({ status: 'settled', result_usable: 1 });
    expect(usageOf(sqlite)).toHaveLength(1);
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.charged_microdollars).toBe(75);
    expect(outbox(sqlite)).toHaveLength(0);
  });

  it('preserves a late result after cancellation without recording usage', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await db.batch(
      cancelPaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        reason: 'last payer left',
        transitionId: 'cancel-1',
      })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'cancelled', result_usable: 0 });

    // A late output uses the canonical completion: it may only restore the reuse flag.
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        resultUsable: true,
        settlementId: 'late-1',
      })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'cancelled', result_usable: 1 });
    expect(usageOf(sqlite)).toHaveLength(0);
  });

  it('records a durable cancellation intent and retries it', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await db.batch(
      cancelPaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        reason: 'provider_error',
        transitionId: 'fail-1',
      })
    );
    const cancellation = (
      sqlite.prepare(`SELECT * FROM paid_benchmark_cancellations`).all() as Array<
        Record<string, unknown>
      >
    )[0];
    expect(cancellation).toMatchObject({
      executor_run_id: 'run-1',
      executor_token: 'token-1',
      generation: run.generation,
      status: 'pending',
    });
    expect(await claimPaidCaseCancellations(db, { limit: 10 })).toHaveLength(1);
  });

  it('cancels a case only when its last voluntary payer leaves', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'owner' })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'cancelled' });
    const remaining = await readPaidCasePayers(db, key(), run.generation);
    expect(remaining.filter(row => row.status === 'eligible')).toHaveLength(0);
  });
});

describe('staging reuse and paused reopen', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
  });

  function stageKey(caseId: string): PaidCaseKey {
    return key({ caseId });
  }

  it('never advertises a settled slot without a usable stored result as reused', async () => {
    // A settled generation whose result row is errored: the flag alone is not evidence.
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          platform_covered, result_usable, created_at, updated_at, settled_at
        ) VALUES (?, ?, '', 0, 'case-1', 'settled', 1, 0, 1, 'x', 'x', 'x')`
      )
      .run(ENGINE, MODEL);
    sqlite
      .prepare(
        `INSERT INTO case_results (
          run_id, model, variant, case_id, score, latency_ms, exit_code, rep
        ) VALUES ('run-1', ?, '', 'case-1', 0, 10, 1, 0)`
      )
      .run(MODEL);
    await seedRequest(db, 'request-a', alice);
    await stage(db, 'request-a');
    const row = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual({ status: 'queued' });
  });

  it('never reuses a draw below the case minimum prompt revision', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          platform_covered, result_usable, created_at, updated_at, settled_at
        ) VALUES (?, ?, '', 0, 'case-1', 'settled', 1, 0, 1, 'x', 'x', 'x')`
      )
      .run(ENGINE, MODEL);
    sqlite
      .prepare(
        `INSERT INTO case_results (
          run_id, model, variant, case_id, score, latency_ms, exit_code, rep,
          prompt_revision, error, timed_out
        ) VALUES ('run-1', ?, '', 'case-1', 1, 10, 0, 0, 1, NULL, 0)`
      )
      .run(MODEL);
    await seedRequest(db, 'request-a', alice);
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-a',
        cases: [stageKey(CASE)],
        eligibility: {
          router: 'efficient',
          engineIdentity: ENGINE,
          minimumRevisions: { [CASE]: 3 },
        },
      })
    );
    const row = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual({ status: 'queued' });
  });

  it('never reuses a draw taken before the pair was invalidated', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (
          id, kind, status, started_at, min_accuracy, switch_cost_factor,
          max_concurrency, engine_identity, repetitions, purpose, measurement_revision
        ) VALUES ('source-run', 'decider', 'completed', '2026-01-01T00:00:00.000Z', 0.7, 0.5, 4,
          ?, 1, 'platform', 3)`
      )
      .run(ENGINE);
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          platform_covered, result_usable, created_at, updated_at, settled_at
        ) VALUES (?, ?, '', 0, 'case-1', 'settled', 1, 0, 1, 'x', 'x', 'x')`
      )
      .run(ENGINE, MODEL);
    sqlite
      .prepare(
        `INSERT INTO case_results (
          run_id, model, variant, case_id, score, latency_ms, exit_code, rep,
          prompt_revision, error, timed_out
        ) VALUES ('source-run', ?, '', 'case-1', 1, 10, 0, 0, 3, NULL, 0)`
      )
      .run(MODEL);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status,
          requested_at, updated_at, invalidated_at, platform_requested, user_requested
        ) VALUES ('efficient', ?, '', ?, 1, 'pending', '2026-11-20T00:00:00.000Z',
          '2026-11-20T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 1, 0)`
      )
      .run(MODEL, ENGINE);
    await seedRequest(db, 'request-a', alice);
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-a',
        cases: [stageKey(CASE)],
        eligibility: {
          router: 'efficient',
          engineIdentity: ENGINE,
          minimumRevisions: { [CASE]: 1 },
        },
      })
    );
    const row = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual({ status: 'queued' });
  });

  it('still reuses an older compatible draw above the revision floor', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (
          id, kind, status, started_at, min_accuracy, switch_cost_factor,
          max_concurrency, engine_identity, repetitions, purpose, measurement_revision
        ) VALUES ('source-run', 'decider', 'completed', '2026-01-01T00:00:00.000Z', 0.7, 0.5, 4,
          ?, 1, 'platform', 3)`
      )
      .run(ENGINE);
    sqlite
      .prepare(
        `INSERT INTO benchmark_case_runs (
          engine_identity, model, variant, rep, case_id, status, generation,
          platform_covered, result_usable, created_at, updated_at, settled_at
        ) VALUES (?, ?, '', 0, 'case-1', 'settled', 1, 0, 1, 'x', 'x', 'x')`
      )
      .run(ENGINE, MODEL);
    sqlite
      .prepare(
        `INSERT INTO case_results (
          run_id, model, variant, case_id, score, latency_ms, exit_code, rep,
          prompt_revision, error, timed_out
        ) VALUES ('source-run', ?, '', 'case-1', 1, 10, 0, 0, 4, NULL, 0)`
      )
      .run(MODEL);
    await seedRequest(db, 'request-a', alice);
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-a',
        cases: [stageKey(CASE)],
        eligibility: {
          router: 'efficient',
          engineIdentity: ENGINE,
          minimumRevisions: { [CASE]: 3 },
        },
      })
    );
    const row = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`)
      .get() as Record<string, unknown>;
    expect(row).toEqual({ status: 'reused' });
  });

  it('opens a paused unspent generation only through an explicit reclaim', async () => {
    await seedRequest(db, 'request-a', alice);
    await seedRequest(db, 'request-b', bob);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await db.batch(
      pausePaidUnfundedCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        funderRequestId: 'request-a',
        transitionId: 'stop-1',
      })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'paused' });

    // Without reclaim nothing reopens it, and the display row stays paused.
    expect(await stage(db, 'request-b', key())).toBe('closed');
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-b',
        cases: [stageKey(CASE)],
        reclaim: true,
      })
    );
    expect(await caseRun(db)).toMatchObject({
      status: 'queued',
      generation: run.generation + 1,
      result_usable: 0,
    });
    const reopened = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-b'`)
      .get() as Record<string, unknown>;
    expect(reopened).toEqual({ status: 'queued' });
    // The earlier non-reclaiming stage left A's own display row paused.
    const untouched = sqlite
      .prepare(`SELECT status FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`)
      .get() as Record<string, unknown>;
    expect(untouched).toEqual({ status: 'paused' });
  });

  it('does not reopen a paused generation while its cancellation is unresolved', async () => {
    await seedRequest(db, 'request-a', alice);
    await seedRequest(db, 'request-b', bob);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await db.batch(
      pausePaidUnfundedCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        funderRequestId: 'request-a',
        transitionId: 'stop-1',
      })
    );
    sqlite
      .prepare(
        `INSERT INTO paid_benchmark_cancellations (
          engine_identity, model, variant, rep, case_id, generation, executor_run_id,
          executor_token, status, attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, '', 0, ?, ?, 'run-1', 'token-1', 'pending', 0, 0, 0, 0)`
      )
      .run(ENGINE, MODEL, CASE, run.generation);
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-b',
        cases: [stageKey(CASE)],
        reclaim: true,
      })
    );
    expect(await caseRun(db)).toMatchObject({ status: 'paused' });
  });
});

describe('exact-slot unfunded stop', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice, 1, 10_000_000, 'router-a');
    await seedRequest(db, 'request-b', bob, 1, 10_000_000, 'router-b');
  });

  it('pauses only the exact unfunded slot and keeps a funded sibling active', async () => {
    // A two-case plan, of which only the measured slot is unfunded.
    sqlite
      .prepare(`UPDATE paid_benchmark_requests SET plan_cases = 2 WHERE id = 'request-a'`)
      .run();
    for (const [caseId, requestId] of [
      ['case-1', 'request-a'],
      ['case-2', 'request-a'],
    ] as const)
      await db.batch(enqueuePaidCaseStatements(db, { key: key({ caseId }), requestId }));
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    const results = await db.batch(
      pausePaidUnfundedCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        funderRequestId: 'request-a',
        transitionId: 'stop-1',
      })
    );
    // The funder cannot pay this slot (it is out of funds) but still owns another live
    // case, so the request is kept and only this exact slot stops.
    expect(paidUnfundedStopOutcome(results)).toMatchObject({
      paused: [],
      kept: ['request-a'],
      caseRun: 'paused',
    });
    expect(await caseRun(db)).toMatchObject({ status: 'paused' });
    expect(await caseRun(db)).toMatchObject({
      status: 'paused',
      failure_reason: 'no_funds',
      result_usable: 0,
    });
    // Other cases, the other request and the run are untouched; nothing charged.
    const sibling = sqlite
      .prepare(
        `SELECT status FROM paid_benchmark_request_cases
        WHERE request_id = 'request-a' AND case_id = 'case-2'`
      )
      .get() as Record<string, unknown>;
    expect(sibling).toEqual({ status: 'queued' });
    expect(usageOf(sqlite)).toHaveLength(0);
    expect(sqlite.prepare(`SELECT count(*) c FROM paid_benchmark_cancellations`).get()).toEqual({
      c: 0,
    });
  });

  it('pauses a request whose only case was the stopped slot', async () => {
    await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-a' }));
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    const results = await db.batch(
      pausePaidUnfundedCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        funderRequestId: 'request-a',
        transitionId: 'stop-1',
      })
    );
    expect(paidUnfundedStopOutcome(results)).toMatchObject({
      paused: ['request-a'],
      kept: [],
      caseRun: 'paused',
    });
    expect(await readPaidBenchmarkRequest(db, 'request-a')).toMatchObject({
      status: 'paused',
      pause_reason: 'no_funds',
    });
    // The unrelated funded request on another router is untouched.
    expect(await readPaidBenchmarkRequest(db, 'request-b')).toMatchObject({
      status: 'preparing',
    });
  });

  it('reuses the picker eligibility: another funded payer keeps the slot running', async () => {
    for (const requestId of ['request-a', 'request-b'])
      await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId }));
    for (const requestId of ['request-a', 'request-b'])
      await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    // A payer row exists, so this slot is not "no payer": the stop is a no-op.
    const first = await db.batch(
      pausePaidUnfundedCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        funderRequestId: 'request-a',
        transitionId: 'stop-1',
      })
    );
    expect(paidUnfundedStopOutcome(first).caseRun).toBe('not_running');
    expect(await caseRun(db)).toMatchObject({ status: 'running' });
  });

  it('never pauses a newer generation from a stale executor', async () => {
    await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-a' }));
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    const stale = await db.batch(
      pausePaidUnfundedCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'old-token', generation: run.generation },
        transitionId: 'stop-stale',
      })
    );
    expect(paidUnfundedStopOutcome(stale).caseRun).toBe('not_running');
    expect(await caseRun(db)).toMatchObject({ status: 'running' });
  });
});

describe('platform coverage', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
  });

  it('covers a case the platform claims and never attaches a user afterwards', async () => {
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    const platform = await claim(db, { runId: 'run-1', token: 'token-1', platform: true });
    expect(platform.outcome).toBe('started');
    await seedRequest(db, 'request-a', alice);
    await stage(db, 'request-a');
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));

    const run = await caseRun(db);
    const attached = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
      platformOrganizationId: 'org-benchmark',
    });
    expect(attached.row).toMatchObject({
      state: 'admitted',
      assignment_id: ASSIGNMENT_1,
      platform_covered: 1,
      platform_organization_id: 'org-benchmark',
    });
    expect(await readPaidCasePayers(db, key(), run.generation)).toHaveLength(0);
  });

  it('does not retroactively cover a user row already accepted', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
    });
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 20,
      generation: run.generation,
    });

    await db.batch(platformCoverageStatements(db, { key: key() }));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 1 });
    const rows = await readPaidCasePayers(db, key(), run.generation);
    expect(rows.map(row => row.status)).toEqual(['accepted']);
    expect(sqlite.prepare(`SELECT state FROM paid_model_requests`).get()).toEqual({
      state: 'completed',
    });
    // The latch applies to future requests of the pair, not to this accepted row.
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.charged_microdollars).toBe(20);
  });

  it('cannot cover a case that already settled', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    await db.batch(
      completePaidCaseStatements(db, {
        key: key(),
        generation: { runId: 'run-1', token: 'token-1', generation: run.generation },
        resultUsable: true,
        settlementId: 'settle-1',
      })
    );
    await db.batch(platformCoverageStatements(db, { key: key() }));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 0, status: 'settled' });
  });
});

describe('approved Kilo-covered slots', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice);
    await seedRequest(db, 'request-b', bob);
  });

  it('never permits the owner of an approved-covered slot, even after removal', async () => {
    // Stage A's slot with the quote's approved covered bit; no canonical latch exists.
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-a',
        cases: [{ ...key(), coveredByKilo: true }],
      })
    );
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    expect(
      sqlite
        .prepare(
          `SELECT covered_by_kilo FROM paid_benchmark_request_cases WHERE request_id = 'request-a'`
        )
        .get()
    ).toEqual({ covered_by_kilo: 1 });

    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // Only the other owner's own paid request could pay; A's covered slot cannot.
    expect(selected?.owner_id).not.toBe('alice');
  });

  it('a separate owner paid-approved request may still pay that slot', async () => {
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-a',
        cases: [{ ...key(), coveredByKilo: true }],
      })
    );
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: 'request-b' }));
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-b' }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);

    const selected = await selectModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    expect(selected?.owner_id).toBe('bob');
  });

  it('does not admit a payer whose staged slot is approved covered', async () => {
    await db.batch(
      enqueuePaidCaseBatchStatements(db, {
        requestId: 'request-a',
        cases: [{ ...key(), coveredByKilo: true }],
      })
    );
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
    const run = await caseRun(db);
    // Simulate a stale selection for the covered owner.
    sqlite
      .prepare(
        `INSERT INTO paid_model_requests (
          id, engine_identity, model, variant, rep, case_id, generation, pool_request_id,
          state, assignment_id, owner_type, owner_id, platform_covered, reason,
          api, executor_user_id, project_id, usage_id, created_at, updated_at
        ) VALUES (?, ?, ?, '', 0, ?, ?, 'request-a', 'selecting', ?, 'user', 'alice', 0,
          NULL, 'chat/completions', 'actor-1', ?, ?, ?, ?)`
      )
      .run(
        UUID_1,
        ENGINE,
        MODEL,
        CASE,
        run.generation,
        ASSIGNMENT_1,
        POOL_PROJECT_ID,
        USAGE_1,
        new Date().toISOString(),
        new Date().toISOString()
      );
    const admitted = await db.batch(
      admitPaidModelRequestStatements(db, {
        key: key(),
        generation: run.generation,
        modelRequestId: UUID_1,
        assignmentId: ASSIGNMENT_1,
      })
    );
    expect(paidModelRequestAdmission(admitted).changed).toBe(false);
  });
});

describe('platform membership latch ordering', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  function seedProfile(platformRequested: number, repetitions = 1) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status,
          requested_at, updated_at, platform_requested, user_requested
        ) VALUES ('efficient', ?, '', ?, ?, 'pending',
          '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', ?, 0)
        ON CONFLICT (router, model, variant, engine_identity, repetitions)
        DO UPDATE SET platform_requested = excluded.platform_requested`
      )
      .run(MODEL, ENGINE, repetitions, platformRequested);
  }

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await claim(db, { runId: 'run-1', token: 'token-1' });
  });

  const latch = (db: D1Database, repetitions = 1) =>
    platformCoverageStatements(db, {
      membership: {
        router: 'efficient',
        engineIdentity: ENGINE,
        model: MODEL,
        variant: '',
        repetitions,
      },
    });

  it('latches only while the durable membership still wants the pair', async () => {
    seedProfile(1);
    await db.batch(latch(db));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 1 });
  });

  it('a stale latch after removal does not cover the case', async () => {
    seedProfile(0);
    await db.batch(latch(db));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 0 });
  });

  it('a same-pair row at another repetition count cannot latch this membership', async () => {
    // The only platform_requested row is for 3 repetitions; the synced membership is 1.
    seedProfile(1, 3);
    await db.batch(latch(db, 1));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 0 });
    // The exact membership does latch.
    seedProfile(1, 1);
    await db.batch(latch(db, 1));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 1 });
  });

  it('a member of another router cannot latch this one', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (
          router, model, variant, engine_identity, repetitions, status,
          requested_at, updated_at, platform_requested, user_requested
        ) VALUES ('frontier', ?, '', ?, 1, 'pending',
          '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 1, 0)`
      )
      .run(MODEL, ENGINE);
    await db.batch(latch(db));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 0 });
  });

  it('already-latched coverage survives a later membership removal', async () => {
    seedProfile(1);
    await db.batch(latch(db));
    seedProfile(0);
    await db.batch(latch(db));
    expect(await caseRun(db)).toMatchObject({ platform_covered: 1 });
  });
});

describe('request lifecycle', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
  });

  it('refuses activation until every approved case is staged', async () => {
    await seedRequest(db, 'request-a', alice, 2);
    await stage(db, 'request-a');
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    expect(await readPaidBenchmarkRequest(db, 'request-a')).toMatchObject({
      status: 'preparing',
      plan_cases: 2,
      staged_cases: 1,
    });

    await stage(db, 'request-a', key({ caseId: 'case-2' }));
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    expect(await readPaidBenchmarkRequest(db, 'request-a')).toMatchObject({
      status: 'active',
      staged_cases: 2,
    });
    expect(outbox(sqlite)).toHaveLength(0);
  });

  it('stages a large plan in bounded batches', async () => {
    await seedRequest(db, 'request-a', alice, 60);
    const cases = Array.from({ length: 60 }, (_, index) => key({ caseId: `case-${index}` }));
    for (let offset = 0; offset < cases.length; offset += PAID_CASE_BATCH_LIMIT)
      await db.batch(
        enqueuePaidCaseBatchStatements(db, {
          requestId: 'request-a',
          cases: cases.slice(offset, offset + PAID_CASE_BATCH_LIMIT),
        })
      );
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    expect(await readPaidBenchmarkRequest(db, 'request-a')).toMatchObject({
      status: 'active',
      staged_cases: 60,
    });
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-a', limit: 100 });
    if (progress.status !== 'active') throw new Error('expected active progress');
    expect(progress.cases).toHaveLength(60);
    expect(progress).toMatchObject({ billedModelRequests: 0, kiloCoveredModelRequests: 0 });
  });

  it('distinguishes a billing pause from an owner pause', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'no_funds' })
    );
    const paused = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    if (paused.status !== 'paused') throw new Error('expected paused progress');
    expect(paused.reason).toBe('insufficient funds');
    expect((await readPaidBenchmarkRequest(db, 'request-a'))?.pause_reason).toBe('no_funds');
  });

  it('lists every paused model even when the first case page lacks it', async () => {
    // Two models on one request: the alphabetically later one is off the first page.
    await seedRequest(db, 'request-a', alice, 2);
    for (const model of [MODEL, 'zzz/later-model']) {
      await db.batch(
        enqueuePaidCaseStatements(db, {
          key: { ...key(), model, caseId: `${model}-case` },
          requestId: 'request-a',
        })
      );
    }
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'no_funds' })
    );
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-a', limit: 1 });
    if (progress.status !== 'paused') throw new Error('expected paused progress');
    expect(progress.cases).toHaveLength(1);
    expect(progress.pausedModels).toEqual([MODEL, 'zzz/later-model']);
  });

  it("does not leak another request's paused models", async () => {
    await seedRequest(db, 'request-b', bob);
    await db.batch(
      enqueuePaidCaseStatements(db, {
        key: { ...key(), model: 'only/other-request' },
        requestId: 'request-b',
      })
    );
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-b' }));
    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-b', reason: 'owner' })
    );
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await db.batch(
      pausePaidBenchmarkRequestStatements(db, { requestId: 'request-a', reason: 'no_funds' })
    );
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    if (progress.status !== 'paused') throw new Error('expected paused progress');
    expect(progress.pausedModels).toEqual([MODEL]);
  });

  it('records the pins effect only for a completed request', async () => {
    await seedRequest(db, 'request-a', alice);
    expect(
      (await db.batch([enqueuePaidPoolPinsStatement(db, { requestId: 'request-a' })]))[0].meta
        .changes
    ).toBe(0);

    await enqueue(db, 'request-a');
    await db.batch(completePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await db.batch([enqueuePaidPoolPinsStatement(db, { requestId: 'request-a' })]);
    expect(outbox(sqlite)).toMatchObject([
      { id: 'pins:request-a', kind: 'pins', amount_microdollars: 0 },
    ]);
  });

  it('allows only one live request per saved pool across two simultaneous starts', async () => {
    for (const id of ['request-first', 'request-second']) {
      await createPaidBenchmarkQuote(db, {
        id: `quote-${id}`,
        owner: alice,
        router: 'efficient',
        routerId: 'router-shared',
        poolVersion: 'v1',
        engineIdentity: ENGINE,
        context: '{}',
        plan: '{}',
        estimateMicrodollars: 1_000,
        maximumMicrodollars: 1_000,
        planCases: 1,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    await db.batch(
      startPaidBenchmarkRequestStatements(db, {
        quoteId: 'quote-request-first',
        requestId: 'request-first',
        actorUserId: 'actor-1',
      })
    );
    await db.batch(
      startPaidBenchmarkRequestStatements(db, {
        quoteId: 'quote-request-second',
        requestId: 'request-second',
        actorUserId: 'actor-1',
      })
    );
    expect(await readPaidBenchmarkRequest(db, 'request-first')).toMatchObject({
      status: 'preparing',
    });
    // The second start lost the live-request race: nothing is created for it.
    expect(await readPaidBenchmarkRequest(db, 'request-second')).toBeNull();

    // Idempotent quote replay: the same quote cannot start a second request either.
    await db.batch(
      startPaidBenchmarkRequestStatements(db, {
        quoteId: 'quote-request-first',
        requestId: 'request-first',
        actorUserId: 'actor-1',
      })
    );
    expect(await readPaidBenchmarkRequest(db, 'request-first')).toMatchObject({
      status: 'preparing',
    });
  });

  it('expires a quote and refuses a second start', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await createPaidBenchmarkQuote(db, {
      id: 'quote-expired',
      owner: alice,
      router: 'efficient',
      routerId: 'router-expired',
      poolVersion: 'v1',
      engineIdentity: ENGINE,
      context: '{}',
      plan: '{}',
      estimateMicrodollars: 100,
      maximumMicrodollars: 100,
      planCases: 0,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await db.batch(
      startPaidBenchmarkRequestStatements(db, {
        quoteId: 'quote-expired',
        requestId: 'request-expired',
        actorUserId: 'actor-1',
      })
    );
    expect(await readPaidBenchmarkRequest(db, 'request-expired')).toBeNull();

    await db.batch(
      startPaidBenchmarkRequestStatements(db, {
        quoteId: 'quote-request-a',
        requestId: 'request-again',
        actorUserId: 'actor-1',
      })
    );
    expect(await readPaidBenchmarkRequest(db, 'request-again')).toBeNull();
  });
});

describe('progress', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
  });

  it('reports every case status, bounded pages and a stable cursor', async () => {
    await seedRequest(db, 'request-a', alice, 3);
    for (let rep = 0; rep < 3; rep++)
      await stage(db, 'request-a', key({ caseId: `case-${rep}`, rep }));
    await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));

    const first = await readPaidBenchmarkProgress(db, { requestId: 'request-a', limit: 2 });
    expect(first.status).toBe('active');
    if (first.status !== 'active') throw new Error('expected active progress');
    expect(first.counts).toEqual({
      queued: 3,
      running: 0,
      reused: 0,
      done: 0,
      failed: 0,
      paused: 0,
    });
    expect(first.cases).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await readPaidBenchmarkProgress(db, {
      requestId: 'request-a',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    if (second.status !== 'active') throw new Error('expected active progress');
    expect(second.cases).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('returns empty for an unknown request', async () => {
    expect(await readPaidBenchmarkProgress(db, { requestId: 'missing' })).toEqual({
      status: 'empty',
    });
  });
});

describe('shared case progress attribution', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
    seedChunk(sqlite, { chunkId: 'chunk-1', runId: 'run-1', token: 'token-1', slot: 1 });
    await seedRequest(db, 'request-a', alice);
    await seedRequest(db, 'request-b', bob);
    for (const id of ['request-a', 'request-b'])
      await db.batch(enqueuePaidCaseStatements(db, { key: key(), requestId: id }));
    for (const id of ['request-a', 'request-b'])
      await db.batch(activatePaidBenchmarkRequestStatements(db, { requestId: id }));
    await claim(db, { runId: 'run-1', token: 'token-1' });
  });

  it("does not bill or pend one request for another owner's call", async () => {
    const run = await caseRun(db);
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
    });
    // Alpha paid this call; Bravo shares the case and has an outstanding admitted call of
    // its own, which must not appear in Alpha's pending count and vice versa.
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: { ownerType: paid.row?.owner_type ?? 'user', ownerId: paid.row?.owner_id as string },
      microdollars: 40,
      generation: run.generation,
    });
    const alpha = await readPaidBenchmarkProgress(db, { requestId: 'request-a' });
    const bravo = await readPaidBenchmarkProgress(db, { requestId: 'request-b' });
    if (alpha.status !== 'active' || bravo.status !== 'active')
      throw new Error('expected active progress');

    const owner = paid.row?.owner_id;
    const payer = owner === 'alice' ? alpha : bravo;
    const other = owner === 'alice' ? bravo : alpha;
    expect(payer.billedModelRequests).toBe(1);
    expect(payer.chargedMicrodollars).toBe(40);
    expect(other.billedModelRequests).toBe(0);
    expect(other.chargedMicrodollars).toBe(0);
    expect(other.pendingModelRequests).toBe(0);
  });

  it('still shows genuine live Kilo coverage on a shared case', async () => {
    const run = await caseRun(db);
    await db.batch(platformCoverageStatements(db, { key: key() }));
    const paid = await payModelRequest(db, {
      generation: run.generation,
      modelRequestId: UUID_1,
      assignmentId: ASSIGNMENT_1,
      platformOrganizationId: 'org-benchmark',
    });
    await acceptUsage(db, {
      assignmentId: paid.assignmentId,
      usageId: USAGE_1,
      owner: alice,
      microdollars: 90,
      generation: run.generation,
      projectId: PLATFORM_PROJECT_ID,
      platformOrganizationId: 'org-benchmark',
    });
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-b' });
    if (progress.status !== 'active') throw new Error('expected active progress');
    // Bravo shares this case, so it sees live Kilo coverage without any owner charge.
    expect(progress.kiloCoveredModelRequests).toBe(1);
    expect(progress.kiloCoveredMicrodollars).toBe(90);
    expect(progress.billedModelRequests).toBe(0);
    expect(progress.chargedMicrodollars).toBe(0);
  });

  it('does not show coverage for a case satisfied by a reused historical result', async () => {
    // A reused case is not live coverage, even if some covered receipt exists for it.
    sqlite
      .prepare(
        `UPDATE paid_benchmark_request_cases SET status = 'reused'
        WHERE request_id = 'request-b'`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO paid_attempt_usage (
          usage_id, model_request_id, request_id, engine_identity, model, variant, rep,
          case_id, generation, owner_type, owner_id, microdollars, platform_covered, created_at
        ) VALUES ('hist-1', 'hist', 'request-a', ?, ?, '', 0, ?, 1, 'organization', 'org',
          50, 1, '2026-11-20T00:00:00.000Z')`
      )
      .run(ENGINE, MODEL, CASE);
    const progress = await readPaidBenchmarkProgress(db, { requestId: 'request-b' });
    if (progress.status !== 'active') throw new Error('expected active progress');
    expect(progress.kiloCoveredModelRequests).toBe(0);
    expect(progress.kiloCoveredMicrodollars).toBe(0);
  });
});

describe('pins outbox retry', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    seedRun(sqlite, 'run-1');
  });

  it('retries instead of dead-lettering a bookkeeping intent', async () => {
    await seedRequest(db, 'request-a', alice);
    await enqueue(db, 'request-a');
    await db.batch(completePaidBenchmarkRequestStatements(db, { requestId: 'request-a' }));
    await db.batch([enqueuePaidPoolPinsStatement(db, { requestId: 'request-a' })]);

    const [pins] = await claimPaidBillingOutbox(db, { limit: 10 });
    expect(pins).toMatchObject({ kind: 'pins', amount_microdollars: 0 });
    await failPaidBillingOutbox(db, { id: pins.id, error: 'controller down' });
    expect(await claimPaidBillingOutbox(db, { limit: 10 })).toEqual([]);

    await markPaidBillingOutboxDelivered(db, { ids: [pins.id] });
    expect(await claimPaidBillingOutbox(db, { limit: 10 })).toEqual([]);
  });
});
