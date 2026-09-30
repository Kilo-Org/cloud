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
  AGGREGATE_METRIC,
  OUTCOME_AGGREGATE_LIMITATIONS,
  OUTCOME_WINDOW_MINUTES,
  assembleGenerationAggregates,
  readOutcomeAggregate,
  runCloudAgentOutcomeCollection,
  type OutcomeGeneration,
  type OutcomeRole,
  type OutcomeWindow,
} from './outcome-aggregate.js';

const window: OutcomeWindow = {
  windowMinutes: 5,
  start: '2026-02-01T00:05:00.000Z',
  end: '2026-02-01T00:10:00.000Z',
};
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
  status: 'completed' | 'failed' | 'interrupted';
  responsibility?: string;
  runCount: number;
  failureStage?: string;
  failureCode?: string;
  failureReason?: string;
}) {
  return {
    generation: input.generation,
    role: input.role,
    status: input.status,
    responsibility: input.responsibility ?? 'unknown',
    failureStage: input.failureStage ?? 'unknown',
    failureCode: input.failureCode ?? 'unclassified',
    failureReason: input.failureReason ?? 'unclassified',
    runCount: input.runCount,
  };
}

const usageDb = () => getWorkerDb('postgres://unused:unused@localhost:0/unused');

beforeEach(() => {
  vi.clearAllMocks();
  loggerMock.withFields.mockReturnValue(loggerMock);
});

describe('cloud agent outcome aggregate assembly', () => {
  it('reports both generations and both roles as zero-row results with null shares', () => {
    const generations = assembleGenerationAggregates([], [], []);

    expect(generations.map(entry => entry.generation)).toEqual(['legacy', 'control']);
    for (const entry of generations) {
      expect(entry.runRowsObserved).toBe(false);
      expect(entry.initial.settled).toBe(0);
      expect(entry.followUp.settled).toBe(0);
      expect(entry.totals.settled).toBe(0);
      expect(entry.totals.allFailed).toBe(0);
      expect(entry.totals.providerFailed).toBe(0);
      expect(entry.totals.platformFailureShare).toBeNull();
      expect(entry.totals.unknownClassificationShare).toBeNull();
      expect(entry.totals.unknownSettledShare).toBeNull();
      expect(entry.distinctPlatformAffectedSessions).toBe(0);
      expect(entry.distinctProviderAffectedSessions).toBe(0);
      expect(entry.distinctUnknownAffectedSessions).toBe(0);
      expect(entry.sessionSetupFailures).toEqual([]);
      expect(entry.sessionSetupFailureCount).toBe(0);
    }
  });

  it('treats an unknown responsibility bucket as unknownFailed and computes shares', () => {
    const generations = assembleGenerationAggregates(
      [
        runRow({ generation: 'legacy', role: 'initial', status: 'completed', runCount: 3 }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'unknown',
          runCount: 1,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
        }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'platform',
          runCount: 1,
          failureStage: 'pre_dispatch',
          failureCode: 'sandbox_connect_failed',
        }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'interrupted',
          runCount: 4,
        }),
      ],
      [
        {
          generation: 'legacy',
          distinctPlatformAffectedSessions: 1,
          distinctProviderAffectedSessions: 0,
          distinctUnknownAffectedSessions: 1,
        },
      ],
      []
    );

    const legacy = generations[0];
    expect(legacy.runRowsObserved).toBe(true);
    expect(legacy.initial.completed).toBe(3);
    expect(legacy.initial.unknownFailed).toBe(1);
    expect(legacy.initial.platformFailed).toBe(1);
    expect(legacy.initial.interrupted).toBe(4);
    expect(legacy.initial.allFailed).toBe(2);
    expect(legacy.initial.settled).toBe(5);
    expect(legacy.initial.platformFailureShare).toBeCloseTo(1 / 5);
    expect(legacy.initial.unknownClassificationShare).toBeCloseTo(1 / 2);
    expect(legacy.initial.failureStages).toEqual([
      { stage: 'agent_activity', count: 1 },
      { stage: 'pre_dispatch', count: 1 },
    ]);
    expect(legacy.initial.failureStageCodes).toEqual([
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'unknown',
        reason: 'unclassified',
        count: 1,
      },
      {
        stage: 'pre_dispatch',
        code: 'sandbox_connect_failed',
        responsibility: 'platform',
        reason: 'unclassified',
        count: 1,
      },
    ]);
    expect(legacy.distinctPlatformAffectedSessions).toBe(1);
    expect(legacy.distinctUnknownAffectedSessions).toBe(1);
  });

  it('keeps the same failure stage and code separate per responsibility bucket', () => {
    const generations = assembleGenerationAggregates(
      [
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'platform',
          runCount: 2,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
        }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'user',
          runCount: 3,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
        }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'unknown',
          runCount: 1,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
        }),
      ],
      [],
      []
    );

    const legacy = generations[0];
    expect(legacy.initial.failureStageCodes).toEqual([
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'platform',
        reason: 'unclassified',
        count: 2,
      },
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'unknown',
        reason: 'unclassified',
        count: 1,
      },
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'user',
        reason: 'unclassified',
        count: 3,
      },
    ]);
    expect(legacy.initial.platformFailed).toBe(2);
    expect(legacy.initial.userFailed).toBe(3);
    expect(legacy.initial.unknownFailed).toBe(1);
    expect(legacy.initial.allFailed).toBe(
      legacy.initial.failureStageCodes.reduce((sum, entry) => sum + entry.count, 0)
    );
  });

  it('counts a provider responsibility as providerFailed without inflating unknownFailed', () => {
    const generations = assembleGenerationAggregates(
      [
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'provider',
          runCount: 2,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          failureReason: 'provider_unavailable',
        }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'unknown',
          runCount: 1,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          failureReason: 'assistant_unknown',
        }),
      ],
      [
        {
          generation: 'legacy',
          distinctPlatformAffectedSessions: 0,
          distinctProviderAffectedSessions: 1,
          distinctUnknownAffectedSessions: 1,
        },
      ],
      []
    );

    const legacy = generations[0];
    expect(legacy.initial.providerFailed).toBe(2);
    expect(legacy.initial.unknownFailed).toBe(1);
    expect(legacy.initial.platformFailed).toBe(0);
    expect(legacy.initial.userFailed).toBe(0);
    expect(legacy.initial.allFailed).toBe(3);
    expect(legacy.distinctProviderAffectedSessions).toBe(1);
    expect(legacy.distinctUnknownAffectedSessions).toBe(1);
    expect(legacy.initial.failureStageCodes).toEqual([
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'provider',
        reason: 'provider_unavailable',
        count: 2,
      },
      {
        stage: 'agent_activity',
        code: 'assistant_error',
        responsibility: 'unknown',
        reason: 'assistant_unknown',
        count: 1,
      },
    ]);
  });

  it('keeps the same stage, code and responsibility separate per failure reason', () => {
    const generations = assembleGenerationAggregates(
      [
        runRow({
          generation: 'legacy',
          role: 'initial',
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
          status: 'failed',
          responsibility: 'provider',
          runCount: 4,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          failureReason: 'request_timeout',
        }),
      ],
      [],
      []
    );

    const legacy = generations[0];
    expect(legacy.initial.failureStageCodes).toEqual([
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
        count: 4,
      },
    ]);
    expect(legacy.initial.failureStages).toEqual([{ stage: 'agent_activity', count: 5 }]);
    expect(legacy.initial.providerFailed).toBe(5);
  });

  it('computes unknownSettledShare over settled while unknownClassificationShare stays over allFailed', () => {
    const generations = assembleGenerationAggregates(
      [
        runRow({ generation: 'legacy', role: 'initial', status: 'completed', runCount: 4 }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'unknown',
          runCount: 1,
          failureStage: 'agent_activity',
          failureCode: 'assistant_error',
          failureReason: 'assistant_unknown',
        }),
        runRow({
          generation: 'legacy',
          role: 'initial',
          status: 'failed',
          responsibility: 'platform',
          runCount: 1,
          failureStage: 'pre_dispatch',
          failureCode: 'sandbox_connect_failed',
          failureReason: 'sandbox_connectivity',
        }),
      ],
      [],
      []
    );

    const legacy = generations[0];
    expect(legacy.initial.allFailed).toBe(
      legacy.initial.platformFailed +
        legacy.initial.providerFailed +
        legacy.initial.userFailed +
        legacy.initial.unknownFailed
    );
    expect(legacy.initial.settled).toBe(6);
    expect(legacy.initial.unknownSettledShare).toBeCloseTo(1 / 6);
    expect(legacy.initial.unknownClassificationShare).toBeCloseTo(1 / 2);
  });

  it('separates initial runs from follow-up runs and recomputes totals from summed counts', () => {
    const generations = assembleGenerationAggregates(
      [
        runRow({
          generation: 'control',
          role: 'initial',
          status: 'failed',
          responsibility: 'platform',
          runCount: 1,
          failureStage: 'pre_dispatch',
          failureCode: 'sandbox_connect_failed',
        }),
        runRow({
          generation: 'control',
          role: 'follow_up',
          status: 'failed',
          responsibility: 'platform',
          runCount: 2,
          failureStage: 'pre_dispatch',
          failureCode: 'sandbox_connect_failed',
        }),
        runRow({ generation: 'control', role: 'follow_up', status: 'completed', runCount: 1 }),
      ],
      [],
      []
    );

    const control = generations[1];
    expect(control.generation).toBe('control');
    expect(control.initial.platformFailed).toBe(1);
    expect(control.initial.completed).toBe(0);
    expect(control.followUp.platformFailed).toBe(2);
    expect(control.followUp.completed).toBe(1);
    expect(control.totals.platformFailed).toBe(3);
    expect(control.totals.completed).toBe(1);
    expect(control.totals.settled).toBe(4);
    expect(control.totals.platformFailureShare).toBeCloseTo(3 / 4);
    expect(control.totals.failureStages).toEqual([{ stage: 'pre_dispatch', count: 3 }]);
  });

  it('reports session setup failures separately from settled runs', () => {
    const generations = assembleGenerationAggregates(
      [],
      [],
      [
        {
          generation: 'legacy',
          failureStage: 'initial_admission',
          failureCode: 'initial_queue_full',
          failureCount: 2,
        },
        {
          generation: 'legacy',
          failureStage: 'registration',
          failureCode: 'do_registration_rejected',
          failureCount: 1,
        },
      ]
    );

    const legacy = generations[0];
    expect(legacy.totals.settled).toBe(0);
    expect(legacy.sessionSetupFailures).toEqual([
      { stage: 'initial_admission', code: 'initial_queue_full', count: 2 },
      { stage: 'registration', code: 'do_registration_rejected', count: 1 },
    ]);
    expect(legacy.sessionSetupFailureCount).toBe(3);
  });
});

describe('cloud agent outcome aggregate wiring', () => {
  it('runs all three queries sequentially on one read-only repeatable-read transaction', async () => {
    const fake = makeDb([
      [runRow({ generation: 'legacy', role: 'initial', status: 'completed', runCount: 1 })],
      [],
      [],
    ]);

    const generations = await readOutcomeAggregate(fake.db as never, {
      window,
      retentionCutoff: retentionCutoffIso,
    });

    expect(fake.db.transaction).toHaveBeenCalledTimes(1);
    expect(fake.config()).toEqual({ isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(fake.selects).toHaveLength(3);
    expect(generations).toHaveLength(2);
  });

  it('derives the generation prefix, initial role and unknown bucket from exact SQL predicates', async () => {
    const fake = makeDb([[], [], []]);
    await readOutcomeAggregate(fake.db as never, { window, retentionCutoff: retentionCutoffIso });

    const [runSelect, distinctSelect] = fake.selects;
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

    const distinctUnknown = render(distinctSelect.distinctUnknownAffectedSessions as SQL);
    expect(distinctUnknown.sql).toContain(
      'count(distinct "cloud_agent_session_runs"."cloud_agent_session_id") filter (where'
    );
    expect(distinctUnknown.sql).toContain('"failure_responsibility" is null');
    expect(distinctUnknown.sql).toContain(
      `"failure_responsibility" not in ('platform', 'provider', 'user')`
    );
    expect(distinctUnknown.sql).toContain('::int');

    const distinctProvider = render(distinctSelect.distinctProviderAffectedSessions as SQL);
    expect(distinctProvider.sql).toContain(
      'count(distinct "cloud_agent_session_runs"."cloud_agent_session_id") filter (where "cloud_agent_session_runs"."failure_responsibility" = \'provider\')'
    );
    expect(distinctProvider.sql).toContain('::int');

    const failureReason = render(runSelect.failureReason as SQL);
    expect(failureReason.sql).toContain('coalesce("cloud_agent_session_runs"."failure_reason", ');
    expect(failureReason.sql).toContain("'unclassified'");

    const distinctPlatform = render(distinctSelect.distinctPlatformAffectedSessions as SQL);
    expect(distinctPlatform.sql).toContain(
      'count(distinct "cloud_agent_session_runs"."cloud_agent_session_id") filter (where "cloud_agent_session_runs"."failure_responsibility" = \'platform\')'
    );
    expect(distinctPlatform.sql).toContain('::int');
  });

  it('rejects when a later query fails after an earlier query succeeded', async () => {
    const fake = makeDb([
      [runRow({ generation: 'legacy', role: 'initial', status: 'completed', runCount: 1 })],
      [],
      new Error('outcome q3 failed'),
    ]);

    await expect(
      readOutcomeAggregate(fake.db as never, { window, retentionCutoff: retentionCutoffIso })
    ).rejects.toThrow('outcome q3 failed');
    expect(fake.selects).toHaveLength(3);
  });
});

describe('runCloudAgentOutcomeCollection emission', () => {
  it('emits one complete record per window and no failed record', async () => {
    getPgDbMock.mockReturnValue(
      makeDb([
        [
          runRow({
            generation: 'legacy',
            role: 'initial',
            status: 'failed',
            responsibility: 'provider',
            runCount: 2,
            failureStage: 'agent_activity',
            failureCode: 'assistant_error',
            failureReason: 'provider_unavailable',
          }),
        ],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
      ]).db
    );

    await runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'));

    expect(loggerMock.info).toHaveBeenCalledTimes(OUTCOME_WINDOW_MINUTES.length);
    expect(loggerMock.error).not.toHaveBeenCalled();
    const record = loggerMock.withFields.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.metric).toBe(AGGREGATE_METRIC);
    expect(record.logTag).toBe(AGGREGATE_METRIC);
    expect(record.collectionStatus).toBe('complete');
    expect(record.limitations).toEqual([...OUTCOME_AGGREGATE_LIMITATIONS]);
    const generations = record.generations as Array<{
      totals: { providerFailed: number; failureStageCodes: unknown[] };
    }>;
    expect(generations.length).toBe(2);
    expect(generations[0]?.totals.failureStageCodes).toContainEqual({
      stage: 'agent_activity',
      code: 'assistant_error',
      responsibility: 'provider',
      reason: 'provider_unavailable',
      count: 2,
    });
    expect(generations[0]?.totals.providerFailed).toBe(2);
  });

  it('emits exactly one failed record with no counts when a query fails', async () => {
    getPgDbMock.mockReturnValue(
      makeDb([
        [runRow({ generation: 'legacy', role: 'initial', status: 'completed', runCount: 1 })],
        [],
        new Error('outcome q3 failed'),
      ]).db
    );

    await expect(
      runCloudAgentOutcomeCollection({} as never, new Date('2026-02-01T00:10:00.000Z'))
    ).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).not.toHaveBeenCalled();
    const record = loggerMock.withFields.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(record.collectionStatus).toBe('failed');
    expect(record.failureKind).toBe('db_query_failed');
    expect(record.generations).toBeUndefined();
    expect(record.windowMinutes).toBe(OUTCOME_WINDOW_MINUTES[0]);
    expect(record.collectionTimestamp).toBe('2026-02-01T00:10:00.000Z');
    expect(record.windowEnd).toBe('2026-02-01T00:08:00.000Z');
  });
});
