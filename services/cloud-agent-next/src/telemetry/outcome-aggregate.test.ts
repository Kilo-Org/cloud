import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cloud_agent_session_runs, cloud_agent_sessions } from '@kilocode/db/schema';

const { getPgDbMock, loggerMock } = vi.hoisted(() => ({
  getPgDbMock: vi.fn(),
  loggerMock: {
    withFields: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../db/pg.js', () => ({ getPgDb: getPgDbMock }));
vi.mock('../logger.js', () => ({ logger: loggerMock }));

import {
  AGENT_EXECUTION_METRIC,
  AGENT_FAILURE_METRIC,
  AGENT_SETUP_FAILURE_METRIC,
  COLLECTION_METRIC,
  PRODUCT_ORIGINS,
  assembleExecutionHeadlines,
  assembleFailureRows,
  assembleSetupFailureRows,
  executionOutcomeWindow,
  readOutcomeAggregate,
  runCloudAgentOutcomeCollection,
  type OutcomeGeneration,
  type OutcomeRole,
  type ProductOrigin,
  type RunCountRow,
  type SessionSetupFailureRow,
} from './outcome-aggregate.js';

const window = { start: '2026-02-01T00:00:00.000Z', end: '2026-02-01T00:05:00.000Z' };
const retentionCutoffIso = '2025-11-03T00:10:00.000Z';

type QueryResult = unknown[] | Error;

function makeDb(results: QueryResult[]) {
  const selects: Array<Record<string, unknown>> = [];
  let transactionConfig: unknown;
  const tx = {
    select(fields: Record<string, unknown>) {
      selects.push(fields);
      const result = results.shift();
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        groupBy: () => chain,
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown): unknown {
          if (result instanceof Error) return reject(result);
          return resolve(result ?? []);
        },
      };
      return chain;
    },
  };
  const db = {
    transaction: vi.fn(
      async (operation: (transaction: typeof tx) => Promise<unknown>, config: unknown) => {
        transactionConfig = config;
        return operation(tx);
      }
    ),
  };
  return {
    db,
    selects,
    config: () => transactionConfig,
  };
}

function runRow(input: {
  generation: OutcomeGeneration;
  role: OutcomeRole;
  origin: ProductOrigin;
  status: 'completed' | 'failed' | 'interrupted' | 'queued' | 'accepted';
  responsibility?: string;
  runCount: number;
  failureStage?: string;
  failureCode?: string;
  failureReason?: string;
}): RunCountRow {
  return {
    generation: input.generation,
    role: input.role,
    origin: input.origin,
    status: input.status,
    responsibility: (input.responsibility ?? 'unknown') as RunCountRow['responsibility'],
    failureStage: input.failureStage ?? 'unknown',
    failureCode: input.failureCode ?? 'unclassified',
    failureReason: input.failureReason ?? 'unclassified',
    runCount: input.runCount,
  };
}

function setupRow(input: {
  generation: OutcomeGeneration;
  origin: ProductOrigin;
  failureStage: string;
  failureCode: string;
  failureCount: number;
}): SessionSetupFailureRow {
  return {
    generation: input.generation,
    origin: input.origin,
    failureStage: input.failureStage,
    failureCode: input.failureCode,
    failureCount: input.failureCount,
  };
}

const usageDb = () => getWorkerDb('postgres://unused:unused@localhost:0/unused');

beforeEach(() => {
  vi.clearAllMocks();
  loggerMock.withFields.mockReturnValue(loggerMock);
});

describe('execution outcome window', () => {
  it('closes the 5-minute bucket two minutes before now', () => {
    expect(executionOutcomeWindow(new Date('2026-02-01T00:10:00.000Z'))).toEqual({
      start: '2026-02-01T00:00:00.000Z',
      end: '2026-02-01T00:05:00.000Z',
    });
  });

  it('advances one bucket only after the allowance crosses the next boundary', () => {
    expect(executionOutcomeWindow(new Date('2026-02-01T00:11:59.999Z'))).toEqual({
      start: '2026-02-01T00:00:00.000Z',
      end: '2026-02-01T00:05:00.000Z',
    });
    expect(executionOutcomeWindow(new Date('2026-02-01T00:12:00.000Z'))).toEqual({
      start: '2026-02-01T00:05:00.000Z',
      end: '2026-02-01T00:10:00.000Z',
    });
  });

  it('uses the scheduled slot for the window but wall time for observedAt', async () => {
    getPgDbMock.mockReturnValue(makeDb([[], []]).db);

    await runCloudAgentOutcomeCollection(
      {} as never,
      new Date('2026-02-01T00:17:20.000Z'),
      Date.parse('2026-02-01T00:10:42.000Z')
    );

    expect(loggerMock.withFields.mock.calls[0]?.[0]).toMatchObject({
      observedAt: '2026-02-01T00:17:20.000Z',
      windowStart: '2026-02-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:05:00.000Z',
    });
  });
});

describe('execution headline assembly', () => {
  it('emits every generation, role and origin with explicit zeros', () => {
    const headlines = assembleExecutionHeadlines([]);
    expect(headlines).toHaveLength(12);
    expect(headlines.map(row => `${row.generation}/${row.role}/${row.productOrigin}`)).toEqual([
      'legacy/initial/code-review',
      'legacy/initial/other',
      'legacy/initial/unknown',
      'legacy/follow_up/code-review',
      'legacy/follow_up/other',
      'legacy/follow_up/unknown',
      'control/initial/code-review',
      'control/initial/other',
      'control/initial/unknown',
      'control/follow_up/code-review',
      'control/follow_up/other',
      'control/follow_up/unknown',
    ]);
    for (const headline of headlines) {
      expect(headline).toMatchObject({
        completed: 0,
        platformFailed: 0,
        providerFailed: 0,
        userFailed: 0,
        unknownFailed: 0,
        interrupted: 0,
      });
    }
  });

  it('sums each responsibility bucket and leaves interrupted outside the failure fields', () => {
    const headlines = assembleExecutionHeadlines([
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'code-review',
        status: 'completed',
        runCount: 3,
      }),
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'code-review',
        status: 'failed',
        responsibility: 'platform',
        runCount: 2,
        failureStage: 'pre_dispatch',
        failureCode: 'sandbox_connect_failed',
        failureReason: 'sandbox_connectivity',
      }),
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'code-review',
        status: 'failed',
        responsibility: 'provider',
        runCount: 1,
        failureStage: 'agent_activity',
        failureCode: 'assistant_error',
        failureReason: 'provider_unavailable',
      }),
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'code-review',
        status: 'interrupted',
        responsibility: 'user',
        runCount: 4,
        failureStage: 'interruption',
        failureCode: 'user_interrupt',
        failureReason: 'user_interrupt',
      }),
    ]);

    const target = headlines.find(
      row =>
        row.generation === 'legacy' && row.role === 'initial' && row.productOrigin === 'code-review'
    );
    expect(target).toMatchObject({
      completed: 3,
      platformFailed: 2,
      providerFailed: 1,
      userFailed: 0,
      unknownFailed: 0,
      interrupted: 4,
    });
  });
});

describe('failure breakdown assembly', () => {
  it('keeps only non-zero failed groups and never a queued or interrupted row', () => {
    const rows = assembleFailureRows([
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'other',
        status: 'failed',
        responsibility: 'platform',
        runCount: 1,
        failureStage: 'pre_dispatch',
        failureCode: 'sandbox_connect_failed',
        failureReason: 'sandbox_connectivity',
      }),
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'other',
        status: 'failed',
        responsibility: 'platform',
        runCount: 0,
        failureStage: 'pre_dispatch',
        failureCode: 'sandbox_connect_failed',
        failureReason: 'sandbox_connectivity',
      }),
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'other',
        status: 'interrupted',
        responsibility: 'user',
        runCount: 7,
        failureStage: 'interruption',
        failureCode: 'user_interrupt',
        failureReason: 'user_interrupt',
      }),
      runRow({
        generation: 'legacy',
        role: 'initial',
        origin: 'other',
        status: 'completed',
        runCount: 5,
      }),
    ]);

    expect(rows).toEqual([
      {
        generation: 'legacy',
        role: 'initial',
        productOrigin: 'other',
        responsibility: 'platform',
        stage: 'pre_dispatch',
        code: 'sandbox_connect_failed',
        reason: 'sandbox_connectivity',
        count: 1,
      },
    ]);
  });

  it('matches the responsibility sum to the headline for the same cell', () => {
    const runCounts: RunCountRow[] = [
      runRow({
        generation: 'control',
        role: 'follow_up',
        origin: 'unknown',
        status: 'failed',
        responsibility: 'provider',
        runCount: 3,
        failureStage: 'agent_activity',
        failureCode: 'assistant_error',
        failureReason: 'provider_unavailable',
      }),
      runRow({
        generation: 'control',
        role: 'follow_up',
        origin: 'unknown',
        status: 'failed',
        responsibility: 'unknown',
        runCount: 2,
        failureStage: 'agent_activity',
        failureCode: 'assistant_error',
        failureReason: 'assistant_unknown',
      }),
    ];

    const headline = assembleExecutionHeadlines(runCounts).find(
      row =>
        row.generation === 'control' && row.role === 'follow_up' && row.productOrigin === 'unknown'
    );
    const failures = assembleFailureRows(runCounts);
    expect(headline?.providerFailed).toBe(3);
    expect(headline?.unknownFailed).toBe(2);
    expect(failures.reduce((sum, row) => sum + row.count, 0)).toBe(
      (headline?.platformFailed ?? 0) +
        (headline?.providerFailed ?? 0) +
        (headline?.userFailed ?? 0) +
        (headline?.unknownFailed ?? 0)
    );
  });
});

describe('setup failure assembly', () => {
  it('keeps generation and origin but never a role, and does not join the headline', () => {
    const rows = assembleSetupFailureRows([
      setupRow({
        generation: 'legacy',
        origin: 'code-review',
        failureStage: 'registration',
        failureCode: 'do_registration_rejected',
        failureCount: 2,
      }),
      setupRow({
        generation: 'legacy',
        origin: 'unknown',
        failureStage: 'registration',
        failureCode: 'do_registration_rejected',
        failureCount: 0,
      }),
    ]);

    expect(rows).toEqual([
      {
        generation: 'legacy',
        productOrigin: 'code-review',
        stage: 'registration',
        code: 'do_registration_rejected',
        count: 2,
      },
    ]);
    expect(rows[0]).not.toHaveProperty('role');
  });
});

describe('cloud agent outcome aggregate wiring', () => {
  it('runs two queries on one read-only repeatable-read transaction', async () => {
    const fake = makeDb([[], []]);

    const aggregate = await readOutcomeAggregate(fake.db as never, {
      window,
      retentionCutoff: retentionCutoffIso,
    });

    expect(fake.db.transaction).toHaveBeenCalledTimes(1);
    expect(fake.config()).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(fake.selects).toHaveLength(2);
    expect(aggregate).toEqual({ runCounts: [], sessionSetupFailures: [] });
  });

  it('derives the generation prefix, role, origin label and unknown bucket from exact SQL predicates', async () => {
    const fake = makeDb([[], []]);
    await readOutcomeAggregate(fake.db as never, { window, retentionCutoff: retentionCutoffIso });

    const [runSelect, setupSelect] = fake.selects;
    const render = (expression: SQL) =>
      usageDb()
        .select({ expression })
        .from(cloud_agent_session_runs)
        .innerJoin(
          cloud_agent_sessions,
          eq(
            cloud_agent_sessions.cloud_agent_session_id,
            cloud_agent_session_runs.cloud_agent_session_id
          )
        )
        .toSQL();

    const role = render(runSelect.role as SQL);
    expect(role.sql).toMatch(
      /"cloud_agent_session_runs"\."message_id" = "cloud_agent_sessions"\."initial_message_id"/
    );

    const generation = render(runSelect.generation as SQL);
    expect(generation.sql).toMatch(
      /left\("cloud_agent_session_runs"\."cloud_agent_session_id", \$1\) = \$2/
    );
    expect(generation.params).toEqual([10, 'workspace_']);

    const responsibility = render(runSelect.responsibility as SQL);
    expect(responsibility.sql).toContain('"failure_responsibility" is null');
    expect(responsibility.sql).toContain(
      `"failure_responsibility" not in ('platform', 'provider', 'user')`
    );

    const origin = render(runSelect.origin as SQL);
    expect(origin.sql).toContain(`"cloud_agent_sessions"."product_origin" = 'code-review'`);
    expect(origin.sql).toContain(`then 'code-review'`);
    expect(origin.sql).toContain(`"cloud_agent_sessions"."product_origin" = 'other'`);
    expect(origin.sql).not.toContain('codeReview');

    const code = render(runSelect.failureCode as SQL);
    expect(code.sql).toContain('coalesce("cloud_agent_session_runs"."failure_code", ');
    expect(code.sql).toContain("'unclassified'");

    const reason = render(runSelect.failureReason as SQL);
    expect(reason.sql).toContain('coalesce("cloud_agent_session_runs"."failure_reason", ');

    const setupGeneration = render(setupSelect.generation as SQL);
    expect(setupGeneration.sql).toMatch(
      /left\("cloud_agent_sessions"\."cloud_agent_session_id", \$1\) = \$2/
    );
    expect(setupSelect).not.toHaveProperty('role');
    expect(setupSelect).not.toHaveProperty('status');
  });

  it('rejects when the second query fails after the first succeeds', async () => {
    const fake = makeDb([[], new Error('setup query failed')]);

    await expect(
      readOutcomeAggregate(fake.db as never, { window, retentionCutoff: retentionCutoffIso })
    ).rejects.toThrow('setup query failed');
    expect(fake.selects).toHaveLength(2);
  });
});

describe('runCloudAgentOutcomeCollection emission', () => {
  it('emits exactly 12 zero agent_execution rows for one closed bucket and no failure rows', async () => {
    getPgDbMock.mockReturnValue(makeDb([[], []]).db);

    await runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'));

    expect(loggerMock.info).toHaveBeenCalledTimes(12);
    expect(loggerMock.error).not.toHaveBeenCalled();
    const records = loggerMock.withFields.mock.calls.map(
      ([fields]) => fields as Record<string, unknown>
    );
    expect(records).toHaveLength(12);
    for (const record of records) {
      expect(record.metric).toBe(AGENT_EXECUTION_METRIC);
      expect(record.observedAt).toBe('2026-02-01T00:10:00.000Z');
      expect(record.windowStart).toBe('2026-02-01T00:00:00.000Z');
      expect(record.windowEnd).toBe('2026-02-01T00:05:00.000Z');
      expect(record).toMatchObject({
        completed: 0,
        platformFailed: 0,
        providerFailed: 0,
        userFailed: 0,
        unknownFailed: 0,
        interrupted: 0,
      });
      expect(record).not.toHaveProperty('environment');
      expect(record).not.toHaveProperty('settled');
      expect(record).not.toHaveProperty('generations');
    }
  });

  it('logs one matching agent_failure row and keeps zero breakdowns omitted', async () => {
    getPgDbMock.mockReturnValue(
      makeDb([
        [
          runRow({
            generation: 'legacy',
            role: 'initial',
            origin: 'code-review',
            status: 'failed',
            responsibility: 'platform',
            runCount: 1,
            failureStage: 'pre_dispatch',
            failureCode: 'sandbox_connect_failed',
            failureReason: 'sandbox_connectivity',
          }),
          runRow({
            generation: 'legacy',
            role: 'initial',
            origin: 'other',
            status: 'failed',
            responsibility: 'platform',
            runCount: 0,
            failureStage: 'pre_dispatch',
            failureCode: 'sandbox_connect_failed',
            failureReason: 'sandbox_connectivity',
          }),
        ],
        [],
      ]).db
    );

    await runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'));

    const records = loggerMock.withFields.mock.calls.map(
      ([fields]) => fields as Record<string, unknown>
    );
    const headline = records.find(
      record =>
        record.metric === AGENT_EXECUTION_METRIC &&
        record.generation === 'legacy' &&
        record.role === 'initial' &&
        record.productOrigin === 'code-review'
    );
    expect(headline?.platformFailed).toBe(1);
    const failureRows = records.filter(record => record.metric === AGENT_FAILURE_METRIC);
    expect(failureRows).toHaveLength(1);
    expect(failureRows[0]).toEqual({
      metric: AGENT_FAILURE_METRIC,
      observedAt: '2026-02-01T00:10:00.000Z',
      windowStart: '2026-02-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:05:00.000Z',
      generation: 'legacy',
      role: 'initial',
      productOrigin: 'code-review',
      responsibility: 'platform',
      stage: 'pre_dispatch',
      code: 'sandbox_connect_failed',
      reason: 'sandbox_connectivity',
      count: 1,
    });
  });

  it('emits a setup failure without a role and does not add it to the headline', async () => {
    getPgDbMock.mockReturnValue(
      makeDb([
        [
          runRow({
            generation: 'legacy',
            role: 'initial',
            origin: 'code-review',
            status: 'completed',
            runCount: 3,
          }),
        ],
        [
          setupRow({
            generation: 'legacy',
            origin: 'code-review',
            failureStage: 'registration',
            failureCode: 'do_registration_rejected',
            failureCount: 1,
          }),
        ],
      ]).db
    );

    await runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'));

    const records = loggerMock.withFields.mock.calls.map(
      ([fields]) => fields as Record<string, unknown>
    );
    const setupRows = records.filter(record => record.metric === AGENT_SETUP_FAILURE_METRIC);
    expect(setupRows).toHaveLength(1);
    expect(setupRows[0]).toEqual({
      metric: AGENT_SETUP_FAILURE_METRIC,
      observedAt: '2026-02-01T00:10:00.000Z',
      windowStart: '2026-02-01T00:00:00.000Z',
      windowEnd: '2026-02-01T00:05:00.000Z',
      generation: 'legacy',
      productOrigin: 'code-review',
      stage: 'registration',
      code: 'do_registration_rejected',
      count: 1,
    });
    const headlines = records.filter(record => record.metric === AGENT_EXECUTION_METRIC);
    expect(headlines).toHaveLength(12);
    const headline = headlines.find(
      record =>
        record.generation === 'legacy' &&
        record.role === 'initial' &&
        record.productOrigin === 'code-review'
    );
    expect(headline?.completed).toBe(3);
    expect(headline?.platformFailed).toBe(0);
  });

  it('logs one collection row and no counts when the second query throws', async () => {
    getPgDbMock.mockReturnValue(makeDb([[], new Error('setup query failed')]).db);

    await expect(
      runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'))
    ).resolves.toBeUndefined();

    expect(loggerMock.info).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const record = loggerMock.withFields.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record).toEqual({
      metric: COLLECTION_METRIC,
      collector: AGENT_EXECUTION_METRIC,
      observedAt: '2026-02-01T00:10:00.000Z',
      status: 'failed',
    });
  });
});

describe('product origin vocabulary', () => {
  it('uses stored labels in the documented order', () => {
    expect([...PRODUCT_ORIGINS]).toEqual(['code-review', 'other', 'unknown']);
  });
});
