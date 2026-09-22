import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient, getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { eq } from 'drizzle-orm';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';
import type { CloudAgentRunStateReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { logger } from '../../src/logger.js';
import { createCloudAgentReportStore } from '../../src/telemetry/report-store.js';
import {
  readOutcomeAggregate,
  runCloudAgentOutcomeCollection,
  type GenerationOutcome,
  type OutcomeWindow,
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
  return { windowMinutes: 10, start, end: new Date(Date.parse(start) + 10 * 60_000).toISOString() };
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

function providerFailedRun(
  messageId: string,
  terminalAt: string,
  failureReason: NonNullable<
    CloudAgentRunStateReport['run']['failureReason']
  > = 'provider_unavailable'
): CloudAgentRunStateReport['run'] {
  return {
    messageId,
    status: 'failed',
    queuedAt: terminalAt,
    terminalAt,
    failureStage: 'agent_activity',
    failureCode: 'assistant_error',
    failureResponsibility: 'provider',
    failureReason,
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
  initialMessageId = uniqueMessageId()
): Promise<string> {
  trackedSessionIds.push(sessionId);
  await store.createSessionReport({
    cloudAgentSessionId: sessionId,
    kiloSessionId: uniqueKiloSessionId(),
    initialMessageId,
    occurredAt,
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

async function insertSession(sessionId: string, createdAt: string): Promise<string> {
  trackedSessionIds.push(sessionId);
  const initialMessageId = uniqueMessageId();
  await writer.db.insert(cloud_agent_sessions).values({
    cloud_agent_session_id: sessionId,
    kilo_session_id: uniqueKiloSessionId(),
    initial_message_id: initialMessageId,
    created_at: createdAt,
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
): Promise<GenerationOutcome[]> {
  return readOutcomeAggregate(reader, { window, retentionCutoff });
}

function legacy(generations: GenerationOutcome[]): GenerationOutcome {
  return generations[0];
}

function control(generations: GenerationOutcome[]): GenerationOutcome {
  return generations[1];
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
    expect(legacy(result).totals.completed).toBe(1);
    expect(legacy(result).runRowsObserved).toBe(true);
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
    expect(legacy(result).totals.platformFailed).toBe(1);
    expect(legacy(result).totals.allFailed).toBe(1);
    expect(legacy(result).distinctPlatformAffectedSessions).toBe(1);
  });

  it('counts a run with null responsibility as unknown in both the run count and the distinct sessions', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, unclassifiedFailedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(legacy(result).totals.unknownFailed).toBe(1);
    expect(legacy(result).totals.allFailed).toBe(1);
    expect(legacy(result).distinctUnknownAffectedSessions).toBe(1);
  });

  it('emits the unclassified failure-code sentinel for a failed run with no classification', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(
      sessionId,
      { messageId: initial, status: 'failed', queuedAt: window.start, terminalAt: window.start },
      window.end
    );

    const result = await aggregate(window);
    expect(legacy(result).totals.failureStages).toEqual([{ stage: 'unknown', count: 1 }]);
    expect(legacy(result).totals.failureStageCodes).toEqual([
      {
        stage: 'unknown',
        code: 'unclassified',
        responsibility: 'unknown',
        reason: 'unclassified',
        count: 1,
      },
    ]);
  });

  it('counts one distinct platform-affected session across many failing turns', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);
    await saveReport(sessionId, platformFailedRun(uniqueMessageId(), window.start), window.end);
    await saveReport(sessionId, platformFailedRun(uniqueMessageId(), window.start), window.end);

    const result = await aggregate(window);
    expect(legacy(result).totals.platformFailed).toBe(3);
    expect(legacy(result).distinctPlatformAffectedSessions).toBe(1);
  });

  it('counts one distinct provider-affected session across many failing turns', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, providerFailedRun(initial, window.start), window.end);
    await saveReport(sessionId, providerFailedRun(uniqueMessageId(), window.start), window.end);
    await saveReport(sessionId, providerFailedRun(uniqueMessageId(), window.start), window.end);

    const result = await aggregate(window);
    expect(legacy(result).totals.providerFailed).toBe(3);
    expect(legacy(result).totals.unknownFailed).toBe(0);
    expect(legacy(result).distinctProviderAffectedSessions).toBe(1);
    expect(legacy(result).distinctUnknownAffectedSessions).toBe(0);
  });

  it('keeps the same stage, code and responsibility separate per failure reason', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, providerFailedRun(initial, window.start), window.end);
    await saveReport(
      sessionId,
      providerFailedRun(uniqueMessageId(), window.start, 'request_timeout'),
      window.end
    );

    const result = await aggregate(window);
    expect(legacy(result).totals.providerFailed).toBe(2);
    expect(legacy(result).totals.failureStages).toEqual([{ stage: 'agent_activity', count: 2 }]);
    expect(legacy(result).totals.failureStageCodes).toEqual([
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'provider',
        reason: 'provider_unavailable',
        count: 1,
      },
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'provider',
        reason: 'request_timeout',
        count: 1,
      },
    ]);
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
    expect(legacy(result).initial.platformFailed).toBe(1);
    expect(legacy(result).followUp.platformFailed).toBe(2);
    expect(legacy(result).totals.platformFailed).toBe(3);
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
    expect(control(result).totals.completed).toBe(1);
    expect(control(result).initial.completed).toBe(1);
    expect(control(result).runRowsObserved).toBe(true);
  });

  it('reports interrupted turns separately from settled and failed turns', async () => {
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
    expect(legacy(result).totals.completed).toBe(1);
    expect(legacy(result).totals.interrupted).toBe(1);
    expect(legacy(result).totals.settled).toBe(1);
    expect(legacy(result).totals.allFailed).toBe(0);
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
    expect(legacy(result).totals.unknownFailed).toBe(1);
    expect(legacy(result).totals.providerFailed).toBe(0);
    expect(legacy(result).totals.allFailed).toBe(1);
    expect(legacy(result).distinctUnknownAffectedSessions).toBe(1);
    expect(legacy(result).distinctProviderAffectedSessions).toBe(0);
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
    await insertRun({
      cloudAgentSessionId: atCutoff,
      messageId: uniqueMessageId(),
      status: 'completed',
      terminalAt: window.start,
    });
    await insertRun({
      cloudAgentSessionId: older,
      messageId: uniqueMessageId(),
      status: 'completed',
      terminalAt: window.start,
    });
    await insertRun({
      cloudAgentSessionId: newer,
      messageId: uniqueMessageId(),
      status: 'completed',
      terminalAt: window.start,
    });

    const result = await aggregate(window, cutoff);
    expect(legacy(result).totals.completed).toBe(1);
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
    expect(legacy(result).totals.completed).toBe(expectedLegacy);
    expect(control(result).totals.completed).toBe(expectedControl);
  });

  it('returns null shares for a window with no settled turns', async () => {
    const window = nextWindow();
    const result = await aggregate(window);

    expect(result.map(entry => entry.generation)).toEqual(['legacy', 'control']);
    expect(legacy(result).runRowsObserved).toBe(false);
    expect(control(result).runRowsObserved).toBe(false);
    expect(legacy(result).totals.settled).toBe(0);
    expect(legacy(result).totals.platformFailureShare).toBeNull();
    expect(legacy(result).totals.unknownClassificationShare).toBeNull();
    expect(control(result).totals.platformFailureShare).toBeNull();
    expect(control(result).totals.unknownClassificationShare).toBeNull();
  });

  it('reports session setup failures separately from run outcomes', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await store.recordSessionFailure({
      cloudAgentSessionId: sessionId,
      occurredAt: window.start,
      failure: { stage: 'registration', code: 'do_registration_rejected' },
    });
    await saveReport(sessionId, completedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(legacy(result).sessionSetupFailures).toEqual([
      { stage: 'registration', code: 'do_registration_rejected', count: 1 },
    ]);
    expect(legacy(result).sessionSetupFailureCount).toBe(1);
    expect(legacy(result).totals.completed).toBe(1);
    expect(legacy(result).totals.settled).toBe(1);
  });

  it('counts a pre-dispatch platform failure without a dispatch acceptance fact', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(legacy(result).totals.platformFailed).toBe(1);
    expect(legacy(result).totals.settled).toBe(1);
    expect(legacy(result).distinctPlatformAffectedSessions).toBe(1);
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
    expect(legacy(result).runRowsObserved).toBe(false);
    expect(legacy(result).totals.completed).toBe(0);
    expect(legacy(result).totals.platformFailed).toBe(0);
  });

  it('serializes real query results to JSON without a BigInt error', async () => {
    const window = nextWindow();
    const sessionId = uniqueSessionId('agent');
    const initial = await createSession(sessionId, window.start);
    await saveReport(sessionId, platformFailedRun(initial, window.start), window.end);

    const result = await aggregate(window);
    expect(typeof legacy(result).totals.platformFailed).toBe('number');
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(JSON.parse(JSON.stringify(result))[0].totals.platformFailed).toBe(1);
  });

  it('excludes a run failure and a setup failure committed after Q1 in one snapshot', async () => {
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

      // Both commits are visible to a separate client before Q2/Q3 are released,
      // so a READ COMMITTED transaction would observe them in Q2 (distinct
      // platform sessions) and Q3 (session setup failures). Only the snapshot
      // taken at Q1 can keep the in-flight evaluation at zero.
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
      const generations = await inflight;
      expect(legacy(generations).totals.platformFailed).toBe(0);
      expect(legacy(generations).distinctPlatformAffectedSessions).toBe(0);
      expect(legacy(generations).sessionSetupFailureCount).toBe(0);
    } finally {
      barrier.release();
    }

    const after = await aggregate(window);
    expect(legacy(after).totals.platformFailed).toBe(1);
    expect(legacy(after).distinctPlatformAffectedSessions).toBe(1);
    expect(legacy(after).sessionSetupFailures).toEqual([
      { stage: 'registration', code: 'do_registration_rejected', count: 1 },
    ]);
    expect(legacy(after).sessionSetupFailureCount).toBe(1);
  });

  it('rejects and emits one failed record when a later query fails after an earlier one succeeded', async () => {
    const window = nextWindow();
    const injected = new Error('injected outcome Q3 failure');
    const instrumented = failAtQuery(reader, 3, injected);

    await expect(
      readOutcomeAggregate(instrumented.db, {
        window,
        retentionCutoff: AGGREGATE_RETENTION_CUTOFF,
      })
    ).rejects.toThrow('injected outcome Q3 failure');
    expect(instrumented.state.selectCalls).toBe(3);

    // The same max:1 connection answers the next query, so the failed
    // transaction released the connection rather than leaving it unusable.
    const healthy = await aggregate(window);
    expect(legacy(healthy).runRowsObserved).toBe(false);

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

    expect(records).toHaveLength(1);
    expect(records[0].collectionStatus).toBe('failed');
    expect(records[0].failureKind).toBe('db_query_failed');
    expect(records[0].generations).toBeUndefined();
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(infoMock).not.toHaveBeenCalled();
  });
});
