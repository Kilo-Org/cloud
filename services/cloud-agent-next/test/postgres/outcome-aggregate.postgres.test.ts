import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { eq } from 'drizzle-orm';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';
import type { CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { logger } from '../../src/logger.js';
import { createCloudAgentReportStore } from '../../src/telemetry/report-store.js';
import {
  AGENT_EXECUTION_METRIC,
  COLLECTION_METRIC,
  assembleExecutionHeadlines,
  assembleFailureRows,
  assembleSetupFailureRows,
  readOutcomeAggregate,
  runCloudAgentOutcomeCollection,
  type AgentExecutionHeadline,
  type OutcomeAggregate,
  type OutcomeGeneration,
  type OutcomeRole,
  type OutcomeWindow,
  type ProductOrigin,
} from '../../src/telemetry/outcome-aggregate.js';
import { sessionPlaneFromId } from '../../src/session-plane.js';

const { getPgDbMock } = vi.hoisted(() => ({ getPgDbMock: vi.fn() }));

vi.mock('../../src/db/pg.js', () => ({ getPgDb: getPgDbMock }));

const AGGREGATE_RETENTION_CUTOFF = '2026-01-01T00:00:00.000Z';
const WINDOW_BASE = Date.UTC(2026, 1, 1, 0, 0, 0, 0);

let windowOffsetMinutes = 0;
let connectionString: string;
let reader: WorkerDb;
let writer: ReturnType<typeof createDrizzleClient>;
let store: ReturnType<typeof createCloudAgentReportStore>;
let writerStore: ReturnType<typeof createCloudAgentReportStore>;
const trackedSessionIds: string[] = [];

function requirePostgresUrl(): string {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('Set POSTGRES_URL to a migrated test database');
  return url;
}

function nextWindow(): OutcomeWindow {
  const start = new Date(WINDOW_BASE + windowOffsetMinutes * 60_000).toISOString();
  windowOffsetMinutes += 30;
  return { start, end: new Date(Date.parse(start) + 10 * 60_000).toISOString() };
}

const uniqueKiloSessionId = () => `ses_${randomUUID().replace(/-/g, '').slice(0, 26)}`;
const uniqueMessageId = () => `msg_${randomUUID().replace(/-/g, '')}`;
const uniqueSessionId = (plane: 'agent' | 'workspace') => `${plane}_${randomUUID()}`;

function report(
  sessionId: string,
  run: CloudAgentRunStateReport['run'],
  anchor?: { kiloSessionId: string; initialMessageId: string; reportingCreatedAt: string }
): CloudAgentRunStateReport {
  return {
    version: 1,
    type: 'run.state',
    occurredAt: run.terminalAt ?? run.queuedAt ?? new Date().toISOString(),
    session: { cloudAgentSessionId: sessionId, ...anchor },
    run,
  };
}

function completedRun(messageId: string, terminalAt: string): CloudAgentRunStateReport['run'] {
  return { messageId, status: 'completed', queuedAt: terminalAt, terminalAt };
}

function platformFailedRun(messageId: string, terminalAt: string): CloudAgentRunStateReport['run'] {
  return {
    messageId,
    status: 'failed',
    queuedAt: terminalAt,
    terminalAt,
    failureStage: 'pre_dispatch',
    failureCode: 'sandbox_connect_failed',
    failureResponsibility: 'platform',
    failureReason: 'sandbox_connectivity',
  };
}

function unclassifiedFailedRun(
  messageId: string,
  terminalAt: string
): CloudAgentRunStateReport['run'] {
  return {
    messageId,
    status: 'failed',
    queuedAt: terminalAt,
    terminalAt,
    failureStage: 'unknown',
    failureCode: 'unclassified',
  };
}

async function createSession(
  sessionId: string,
  occurredAt: string,
  initialMessageId = uniqueMessageId(),
  productOrigin?: 'code-review' | 'other'
): Promise<string> {
  trackedSessionIds.push(sessionId);
  await store.createSessionReport({
    cloudAgentSessionId: sessionId,
    kiloSessionId: uniqueKiloSessionId(),
    initialMessageId,
    occurredAt,
    productOrigin,
  });
  return initialMessageId;
}

async function saveReport(
  sessionId: string,
  run: CloudAgentRunStateReport['run'],
  now: string,
  anchor?: { kiloSessionId: string; initialMessageId: string; reportingCreatedAt: string }
): Promise<void> {
  trackedSessionIds.push(sessionId);
  await store.saveReport(report(sessionId, run, anchor), now);
}

async function insertSession(
  sessionId: string,
  createdAt: string,
  productOrigin?: 'code-review' | 'other'
): Promise<string> {
  trackedSessionIds.push(sessionId);
  const initialMessageId = uniqueMessageId();
  await writer.db.insert(cloud_agent_sessions).values({
    cloud_agent_session_id: sessionId,
    kilo_session_id: uniqueKiloSessionId(),
    initial_message_id: initialMessageId,
    created_at: createdAt,
    product_origin: productOrigin ?? null,
  });
  return initialMessageId;
}

async function insertRun(values: {
  cloudAgentSessionId: string;
  messageId: string;
  status: 'completed' | 'failed' | 'interrupted';
  terminalAt: string | null;
  failureStage?: string;
  failureCode?: string;
  failureResponsibility?: string;
  failureReason?: string;
}): Promise<void> {
  await writer.db.insert(cloud_agent_session_runs).values({
    cloud_agent_session_id: values.cloudAgentSessionId,
    message_id: values.messageId,
    status: values.status,
    queued_at: values.terminalAt,
    terminal_at: values.terminalAt,
    failure_stage: values.failureStage ?? null,
    failure_code: values.failureCode ?? null,
    failure_responsibility: values.failureResponsibility ?? null,
    failure_reason: values.failureReason ?? null,
  });
}

async function aggregate(
  window: OutcomeWindow,
  retentionCutoff = AGGREGATE_RETENTION_CUTOFF
): Promise<OutcomeAggregate> {
  return readOutcomeAggregate(reader, { window, retentionCutoff });
}

function headline(
  result: OutcomeAggregate,
  generation: OutcomeGeneration,
  role: OutcomeRole,
  productOrigin: ProductOrigin
): AgentExecutionHeadline {
  const found = assembleExecutionHeadlines(result.runCounts).find(
    row => row.generation === generation && row.role === role && row.productOrigin === productOrigin
  );
  if (!found) throw new Error('missing headline');
  return found;
}

function createBarrier() {
  let signal!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => {
    signal = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return { reached, released, signal, release };
}

function pauseAfterQuery(
  builder: object,
  barrier: { signal: () => void; released: Promise<void> }
): object {
  return new Proxy(builder, {
    get(target, property) {
      if (property === 'then') {
        return (
          onFulfilled: (value: unknown) => unknown,
          onRejected: (reason: unknown) => unknown
        ) =>
          (target as PromiseLike<unknown>).then(async value => {
            barrier.signal();
            await barrier.released;
            return onFulfilled(value);
          }, onRejected);
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        pauseAfterQuery((value as (...a: unknown[]) => object).apply(target, args), barrier);
    },
  });
}

function withQ1Barrier(
  db: WorkerDb,
  barrier: { signal: () => void; released: Promise<void> }
): WorkerDb {
  return new Proxy(db, {
    get(target, property) {
      if (property !== 'transaction') return Reflect.get(target, property, target);
      const transaction = Reflect.get(target, property, target) as (
        operation: (tx: unknown) => Promise<unknown>,
        options?: unknown
      ) => Promise<unknown>;
      return (operation: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        let firstQuery = true;
        return transaction.call(
          target,
          (tx: unknown) =>
            operation(
              new Proxy(tx as object, {
                get(txTarget, txProperty) {
                  const txValue = Reflect.get(txTarget, txProperty, txTarget);
                  if (txProperty !== 'select' || typeof txValue !== 'function') return txValue;
                  return (...args: unknown[]) => {
                    const builder = (txValue as (...a: unknown[]) => object).apply(txTarget, args);
                    if (!firstQuery) return builder;
                    firstQuery = false;
                    return pauseAfterQuery(builder, barrier);
                  };
                },
              })
            ),
          options
        );
      };
    },
  }) as WorkerDb;
}

function failAtQuery(
  db: WorkerDb,
  ordinal: number,
  error: Error
): { db: WorkerDb; state: { selectCalls: number } } {
  const state = { selectCalls: 0 };
  const instrumented = new Proxy(db, {
    get(target, property) {
      if (property !== 'transaction') return Reflect.get(target, property, target);
      const transaction = Reflect.get(target, property, target) as (
        operation: (tx: unknown) => Promise<unknown>,
        options?: unknown
      ) => Promise<unknown>;
      return (operation: (tx: unknown) => Promise<unknown>, options?: unknown) => {
        let selects = 0;
        return transaction.call(
          target,
          (tx: unknown) =>
            operation(
              new Proxy(tx as object, {
                get(txTarget, txProperty) {
                  const txValue = Reflect.get(txTarget, txProperty, txTarget);
                  if (txProperty !== 'select' || typeof txValue !== 'function') return txValue;
                  return (...args: unknown[]) => {
                    selects += 1;
                    state.selectCalls += 1;
                    if (selects === ordinal) throw error;
                    return (txValue as (...a: unknown[]) => object).apply(txTarget, args);
                  };
                },
              })
            ),
          options
        );
      };
    },
  }) as WorkerDb;
  return { db: instrumented, state };
}

beforeAll(() => {
  connectionString = requirePostgresUrl();
  reader = getWorkerDb(connectionString);
  writer = createDrizzleClient({ connectionString, ssl: false });
  store = createCloudAgentReportStore(reader);
  writerStore = createCloudAgentReportStore(writer.db);
});

afterEach(async () => {
  const ids = trackedSessionIds.splice(0);
  if (ids.length === 0) return;
  for (const id of ids) {
    await writer.db
      .delete(cloud_agent_sessions)
      .where(eq(cloud_agent_sessions.cloud_agent_session_id, id));
  }
});

afterAll(async () => {
  await writer.pool.end();
  const readerPool = (reader as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await readerPool?.end();
});

describe('cloud agent outcome aggregate against PostgreSQL', () => {
  it('counts a run whose terminal_at equals the window start and excludes the window end', async () => {
    const window = nextWindow();
    const startSession = uniqueSessionId('agent');
    await saveReport(
      startSession,
      completedRun(await createSession(startSession, window.start), window.start),
      window.end
    );

    const endSession = uniqueSessionId('agent');
    await saveReport(
      endSession,
      completedRun(await createSession(endSession, window.start), window.end),
      window.end
    );

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').completed).toBe(1);
  });

  it('merges duplicate and out-of-order snapshots into one terminal turn', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);

    await saveReport(
      sessionId,
      { messageId: initial, status: 'queued', queuedAt: window.start },
      window.end
    );
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);
    await saveReport(
      sessionId,
      { messageId: initial, status: 'queued', queuedAt: window.start },
      window.end
    );
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);

    const rows = await writer.db
      .select({ messageId: cloud_agent_session_runs.message_id })
      .from(cloud_agent_session_runs)
      .where(eq(cloud_agent_session_runs.cloud_agent_session_id, sessionId));
    expect(rows).toHaveLength(1);

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').platformFailed).toBe(1);
    expect(assembleFailureRows(result.runCounts)).toHaveLength(1);
  });

  it('counts a run with null responsibility as unknown', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, unclassifiedFailedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').unknownFailed).toBe(1);
    expect(headline(result, 'legacy', 'initial', 'unknown').platformFailed).toBe(0);
    expect(assembleFailureRows(result.runCounts)[0]?.responsibility).toBe('unknown');
  });

  it('emits the unclassified sentinels for a failed run with no classification', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(
      sessionId,
      { messageId: initial, status: 'failed', queuedAt: window.start, terminalAt: window.start },
      window.end
    );

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').unknownFailed).toBe(1);
    expect(assembleFailureRows(result.runCounts)).toEqual([
      {
        generation: 'legacy',
        role: 'initial',
        productOrigin: 'unknown',
        responsibility: 'unknown',
        stage: 'unknown',
        code: 'unclassified',
        reason: 'unclassified',
        count: 1,
      },
    ]);
  });

  it('counts an unexpected responsibility text value as unknown', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await insertSession(sessionId, window.start);
    await insertRun({
      cloudAgentSessionId: sessionId,
      messageId: initial,
      status: 'failed',
      terminalAt: window.start,
      failureStage: 'agent_activity',
      failureCode: 'assistant_error',
      failureResponsibility: 'provider_retired',
      failureReason: 'assistant_unknown',
    });

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').unknownFailed).toBe(1);
    expect(headline(result, 'legacy', 'initial', 'unknown').providerFailed).toBe(0);
    expect(assembleFailureRows(result.runCounts)[0]?.responsibility).toBe('unknown');
  });

  it('labels the run whose message_id matches initial_message_id as initial and others as follow-up', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);
    await saveReport(sessionId, platformFailedRun(uniqueMessageId(), window.start), window.end);

    const missingInitialSession = uniqueSessionId('agent');
    await createSession(missingInitialSession, window.start);
    await saveReport(
      missingInitialSession,
      platformFailedRun(uniqueMessageId(), window.start),
      window.end
    );

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').platformFailed).toBe(1);
    expect(headline(result, 'legacy', 'follow_up', 'unknown').platformFailed).toBe(2);
  });

  it('classifies the first admitted run of an anchor-created control-plane parent as initial', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('workspace');
    const initial = uniqueMessageId();
    await saveReport(sessionId, completedRun(initial, window.start), window.end, {
      kiloSessionId: uniqueKiloSessionId(),
      initialMessageId: initial,
      reportingCreatedAt: window.start,
    });

    const result = await aggregate(window);
    expect(headline(result, 'control', 'initial', 'unknown').completed).toBe(1);
  });

  it('keeps an interrupted turn out of the failure rows even when it carries a responsibility', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(
      sessionId,
      {
        messageId: initial,
        status: 'interrupted',
        queuedAt: window.start,
        terminalAt: window.start,
        failureStage: 'interruption',
        failureCode: 'user_interrupt',
        failureResponsibility: 'user',
        failureReason: 'user_interrupt',
      },
      window.end
    );
    await saveReport(sessionId, completedRun(uniqueMessageId(), window.start), window.end);

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').interrupted).toBe(1);
    expect(headline(result, 'legacy', 'initial', 'unknown').userFailed).toBe(0);
    expect(headline(result, 'legacy', 'follow_up', 'unknown').completed).toBe(1);
    expect(assembleFailureRows(result.runCounts)).toEqual([]);
  });

  it('retains only sessions created strictly after the retention cutoff', async () => {
    const window = nextWindow();
    const cutoff = '2026-01-15T00:00:00.000Z';
    const atCutoff = uniqueSessionId('agent');
    const older = uniqueSessionId('agent');
    const newer = uniqueSessionId('agent');

    await insertSession(atCutoff, cutoff);
    await insertSession(older, new Date(Date.parse(cutoff) - 1000).toISOString());
    await insertSession(newer, new Date(Date.parse(cutoff) + 1000).toISOString());
    for (const sessionId of [atCutoff, older, newer]) {
      await insertRun({
        cloudAgentSessionId: sessionId,
        messageId: uniqueMessageId(),
        status: 'completed',
        terminalAt: window.start,
      });
    }

    const result = await aggregate(window, cutoff);
    expect(headline(result, 'legacy', 'follow_up', 'unknown').completed).toBe(1);
  });

  it('splits generations by the workspace_ prefix in agreement with sessionPlaneFromId', async () => {
    const window = nextWindow();
    const sessionIds = [
      uniqueSessionId('workspace'),
      uniqueSessionId('agent'),
      'workspace',
      `Workspace_${randomUUID()}`,
      'agent_',
      '',
    ];

    for (const sessionId of sessionIds) {
      const initial = await insertSession(sessionId, window.start);
      await insertRun({
        cloudAgentSessionId: sessionId,
        messageId: initial,
        status: 'completed',
        terminalAt: window.start,
      });
    }

    const result = await aggregate(window);
    const expectedLegacy = sessionIds.filter(id => sessionPlaneFromId(id) === 'legacy').length;
    const expectedControl = sessionIds.filter(id => sessionPlaneFromId(id) === 'control').length;
    expect(expectedControl).toBe(1);
    expect(headline(result, 'legacy', 'initial', 'unknown').completed).toBe(expectedLegacy);
    expect(headline(result, 'control', 'initial', 'unknown').completed).toBe(expectedControl);
  });

  it('returns zero headlines for a window with no terminal turns', async () => {
    const window = nextWindow();
    const result = await aggregate(window);

    const headlines = assembleExecutionHeadlines(result.runCounts);
    expect(headlines).toHaveLength(12);
    expect(headlines.every(row => row.completed === 0 && row.interrupted === 0)).toBe(true);
  });

  it('reports a session setup failure grouped by its origin and never with a role', async () => {
    const window = nextWindow();
    const reviewSession = uniqueSessionId('agent');
    await createSession(reviewSession, window.start, uniqueMessageId(), 'code-review');
    await store.recordSessionFailure({
      cloudAgentSessionId: reviewSession,
      occurredAt: window.start,
      failure: { stage: 'registration', code: 'do_registration_rejected' },
    });
    const unknownSession = uniqueSessionId('agent');
    await createSession(unknownSession, window.start);
    await store.recordSessionFailure({
      cloudAgentSessionId: unknownSession,
      occurredAt: window.start,
      failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
    });

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').completed).toBe(0);
    const rows = assembleSetupFailureRows(result.sessionSetupFailures);
    expect(rows).toEqual([
      {
        generation: 'legacy',
        productOrigin: 'code-review',
        stage: 'registration',
        code: 'do_registration_rejected',
        count: 1,
      },
      {
        generation: 'legacy',
        productOrigin: 'unknown',
        stage: 'transport',
        code: 'do_rpc_outcome_unknown',
        count: 1,
      },
    ]);
    for (const row of rows) expect(row).not.toHaveProperty('role');
  });

  it('counts a pre-dispatch platform failure without a dispatch acceptance fact', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'unknown').platformFailed).toBe(1);
  });

  it('excludes queued and failed rows with no terminal_at', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await insertSession(sessionId, window.start);
    await insertRun({
      cloudAgentSessionId: sessionId,
      messageId: initial,
      status: 'completed',
      terminalAt: null,
    });
    await insertRun({
      cloudAgentSessionId: sessionId,
      messageId: uniqueMessageId(),
      status: 'failed',
      terminalAt: null,
      failureStage: 'pre_dispatch',
      failureCode: 'sandbox_connect_failed',
      failureResponsibility: 'platform',
      failureReason: 'sandbox_connectivity',
    });

    const result = await aggregate(window);
    expect(result.runCounts).toEqual([]);
    expect(headline(result, 'legacy', 'initial', 'unknown').completed).toBe(0);
    expect(headline(result, 'legacy', 'initial', 'unknown').platformFailed).toBe(0);
  });

  it('labels stored origins as their stored value and null as unknown', async () => {
    const window = nextWindow();
    const reviewSession = uniqueSessionId('agent');
    const otherSession = uniqueSessionId('agent');
    const unknownSession = uniqueSessionId('agent');
    const reviewInitial = await createSession(
      reviewSession,
      window.start,
      uniqueMessageId(),
      'code-review'
    );
    const otherInitial = await createSession(
      otherSession,
      window.start,
      uniqueMessageId(),
      'other'
    );
    const unknownInitial = await createSession(unknownSession, window.start);
    await saveReport(reviewSession, completedRun(reviewInitial, window.start), window.end);
    await saveReport(otherSession, completedRun(otherInitial, window.start), window.end);
    await saveReport(unknownSession, completedRun(unknownInitial, window.start), window.end);

    const result = await aggregate(window);
    expect(headline(result, 'legacy', 'initial', 'code-review').completed).toBe(1);
    expect(headline(result, 'legacy', 'initial', 'other').completed).toBe(1);
    expect(headline(result, 'legacy', 'initial', 'unknown').completed).toBe(1);
  });

  it('serializes real query results to JSON without a BigInt error', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(typeof headline(result, 'legacy', 'initial', 'unknown').platformFailed).toBe('number');
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result)).runCounts[0].runCount).toBe(1);
  });

  it('excludes a run failure and a setup failure committed after the first query in one snapshot', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);

    const barrier = createBarrier();
    const inflight = readOutcomeAggregate(withQ1Barrier(reader, barrier), {
      window,
      retentionCutoff: AGGREGATE_RETENTION_CUTOFF,
    });
    try {
      await barrier.reached;
      await writerStore.saveReport(
        report(sessionId, platformFailedRun(initial, window.start)),
        window.end
      );
      await writerStore.recordSessionFailure({
        cloudAgentSessionId: sessionId,
        occurredAt: window.start,
        failure: { stage: 'registration', code: 'do_registration_rejected' },
      });

      const committedRuns = await writer.db
        .select({ messageId: cloud_agent_session_runs.message_id })
        .from(cloud_agent_session_runs)
        .where(eq(cloud_agent_session_runs.cloud_agent_session_id, sessionId));
      expect(committedRuns).toHaveLength(1);
      const [committedSession] = await writer.db
        .select({ failureAt: cloud_agent_sessions.failure_at })
        .from(cloud_agent_sessions)
        .where(eq(cloud_agent_sessions.cloud_agent_session_id, sessionId));
      expect(Date.parse(committedSession.failureAt ?? '')).toBe(Date.parse(window.start));

      barrier.release();
      const inflightResult = await inflight;
      expect(inflightResult.runCounts).toEqual([]);
      expect(inflightResult.sessionSetupFailures).toEqual([]);
    } finally {
      barrier.release();
    }

    const after = await aggregate(window);
    expect(headline(after, 'legacy', 'initial', 'unknown').platformFailed).toBe(1);
    expect(assembleSetupFailureRows(after.sessionSetupFailures)).toEqual([
      {
        generation: 'legacy',
        productOrigin: 'unknown',
        stage: 'registration',
        code: 'do_registration_rejected',
        count: 1,
      },
    ]);
  });

  it('rejects the second query and emits one failed collection row with no counts', async () => {
    const window = nextWindow();
    const injected = new Error('injected outcome setup failure');
    const instrumented = failAtQuery(reader, 2, injected);

    await expect(
      readOutcomeAggregate(instrumented.db, {
        window,
        retentionCutoff: AGGREGATE_RETENTION_CUTOFF,
      })
    ).rejects.toThrow('injected outcome setup failure');
    expect(instrumented.state.selectCalls).toBe(2);

    const errorMock = vi.fn();
    const infoMock = vi.fn();
    const withFieldsSpy = vi
      .spyOn(logger, 'withFields')
      .mockReturnValue({ info: infoMock, error: errorMock } as never);
    getPgDbMock.mockReturnValue(instrumented.db);
    let records: Record<string, unknown>[] = [];
    try {
      await runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'));
      records = withFieldsSpy.mock.calls.map(([fields]) => fields as Record<string, unknown>);
    } finally {
      getPgDbMock.mockReset();
      withFieldsSpy.mockRestore();
    }

    expect(records).toEqual([
      {
        metric: COLLECTION_METRIC,
        collector: AGENT_EXECUTION_METRIC,
        observedAt: '2026-02-01T00:10:00.000Z',
        status: 'failed',
      },
    ]);
    expect(infoMock).not.toHaveBeenCalled();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});
