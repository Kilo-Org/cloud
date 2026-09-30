import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
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

import { COVERAGE_LABEL } from './outcome-aggregate.js';
import {
  OPEN_STOCK_CONTRACT_VERSION,
  OPEN_STOCK_LIMITATIONS,
  OPEN_STOCK_METRIC,
  assembleOpenStock,
  readOpenStock,
  runCloudAgentOpenStockCollection,
  type OpenStockQueryRow,
} from './open-stock.js';

const retentionCutoffIso = '2025-11-03T00:10:00.000Z';
const now = '2026-02-01T00:10:00.000Z';

type QueryResult = OpenStockQueryRow[] | Error;

function queryRow(
  input: Partial<OpenStockQueryRow> & {
    generation: OpenStockQueryRow['generation'];
    status: OpenStockQueryRow['status'];
  }
): OpenStockQueryRow {
  return {
    turns: 0,
    sessions: 0,
    oldestQueuedEpochMs: null,
    oldestAcceptedEpochMs: null,
    queuedMissingAgeTurns: 0,
    acceptedMissingAgeTurns: 0,
    ...input,
  };
}

function makeDb(result: QueryResult) {
  const state: {
    fields?: Record<string, unknown>;
    where?: unknown;
    groupBy?: unknown[];
  } = {};

  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (arg: unknown) => {
      state.where = arg;
      return chain;
    },
    groupBy: (...args: unknown[]) => {
      state.groupBy = args;
      return chain;
    },
    then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown): unknown {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    },
  };

  const db = {
    select: (fields: Record<string, unknown>) => {
      state.fields = fields;
      return chain;
    },
  };

  return { db, state };
}

const usageDb = () => getWorkerDb('postgres://unused:unused@localhost:0/unused');

function renderSelect(fields: Record<string, unknown>) {
  return usageDb()
    .select(fields as never)
    .from(cloud_agent_session_runs)
    .innerJoin(
      cloud_agent_sessions,
      eq(
        cloud_agent_sessions.cloud_agent_session_id,
        cloud_agent_session_runs.cloud_agent_session_id
      )
    )
    .toSQL();
}

function renderWhere(where: unknown, groupBy: unknown[]) {
  return usageDb()
    .select({ marker: sql`1` })
    .from(cloud_agent_session_runs)
    .innerJoin(
      cloud_agent_sessions,
      eq(
        cloud_agent_sessions.cloud_agent_session_id,
        cloud_agent_session_runs.cloud_agent_session_id
      )
    )
    .where(where as SQL)
    .groupBy(...(groupBy as SQL[]))
    .toSQL();
}

beforeEach(() => {
  vi.clearAllMocks();
  loggerMock.withFields.mockReturnValue(loggerMock);
});

describe('cloud agent open stock assembly', () => {
  it('reports both generations as empty stock with null ages', () => {
    const generations = assembleOpenStock([], now);

    expect(generations.map(entry => entry.generation)).toEqual(['legacy', 'control']);
    for (const entry of generations) {
      expect(entry).toEqual({
        generation: entry.generation,
        queuedTurns: 0,
        queuedSessions: 0,
        acceptedTurns: 0,
        acceptedSessions: 0,
        oldestQueuedAgeMs: null,
        oldestAcceptedAgeMs: null,
        queuedMissingAgeTurns: 0,
        acceptedMissingAgeTurns: 0,
      });
    }
  });

  it('preserves queued counts and the missing-age count without inventing an age', () => {
    const generations = assembleOpenStock(
      [
        queryRow({
          generation: 'legacy',
          status: 'queued',
          turns: 3,
          sessions: 2,
          oldestQueuedEpochMs: null,
          queuedMissingAgeTurns: 3,
        }),
      ],
      now
    );

    const legacy = generations[0];
    expect(legacy.queuedTurns).toBe(3);
    expect(legacy.queuedSessions).toBe(2);
    expect(legacy.oldestQueuedAgeMs).toBeNull();
    expect(legacy.queuedMissingAgeTurns).toBe(3);
    expect(legacy.acceptedTurns).toBe(0);
    expect(legacy.oldestAcceptedAgeMs).toBeNull();
  });

  it('derives queued and accepted ages from their own timestamps', () => {
    const queuedEpochMs = Date.parse('2026-02-01T00:00:00.000Z');
    const acceptedEpochMs = Date.parse('2026-01-31T23:55:00.000Z');
    const generations = assembleOpenStock(
      [
        queryRow({
          generation: 'legacy',
          status: 'queued',
          turns: 1,
          sessions: 1,
          oldestQueuedEpochMs: queuedEpochMs,
        }),
        queryRow({
          generation: 'legacy',
          status: 'accepted',
          turns: 2,
          sessions: 2,
          oldestAcceptedEpochMs: acceptedEpochMs,
        }),
      ],
      now
    );

    const legacy = generations[0];
    expect(legacy.oldestQueuedAgeMs).toBe(Date.parse(now) - queuedEpochMs);
    expect(legacy.oldestAcceptedAgeMs).toBe(Date.parse(now) - acceptedEpochMs);
    expect(legacy.oldestAcceptedAgeMs).not.toBe(legacy.oldestQueuedAgeMs);
  });
});

describe('cloud agent open stock query shape', () => {
  it('narrows to non-terminal queued/accepted runs of retained sessions', async () => {
    const fake = makeDb([]);
    await readOpenStock(fake.db as never, { retentionCutoff: retentionCutoffIso });

    const fields = fake.state.fields as Record<string, unknown>;
    const selectSql = renderSelect(fields);
    const whereSql = renderWhere(fake.state.where, fake.state.groupBy ?? []);

    expect(selectSql.params).toEqual([10, 'workspace_']);
    expect(selectSql.sql).toMatch(
      /left\("cloud_agent_session_runs"\."cloud_agent_session_id", \$1\) = \$2/
    );
    expect(selectSql.sql).toContain(
      'count(distinct "cloud_agent_session_runs"."cloud_agent_session_id"))::int'
    );
    expect(selectSql.sql).toContain('extract(epoch from');
    expect(selectSql.sql).toContain('::double precision');
    expect(selectSql.sql).toContain(
      `count(*) filter (where "cloud_agent_session_runs"."status" = 'queued' and "cloud_agent_session_runs"."queued_at" is null)`
    );
    expect(selectSql.sql).toContain(
      `count(*) filter (where "cloud_agent_session_runs"."status" = 'accepted' and "cloud_agent_session_runs"."dispatch_accepted_at" is null)`
    );

    expect(whereSql.sql).toContain('"status" in ($1, $2)');
    expect(whereSql.sql).toContain('"terminal_at" is null');
    expect(whereSql.sql).toContain('created_at" > $3');
    expect(whereSql.sql).toContain('group by 1, 2');
    expect(whereSql.params).toEqual(['queued', 'accepted', retentionCutoffIso]);
  });
});

describe('runCloudAgentOpenStockCollection emission', () => {
  it('emits one complete record with the stock envelope and two generations', async () => {
    getPgDbMock.mockReturnValue(makeDb([]).db);

    await runCloudAgentOpenStockCollection({} as never, new Date(now));

    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).not.toHaveBeenCalled();
    const record = loggerMock.withFields.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.metric).toBe(OPEN_STOCK_METRIC);
    expect(record.logTag).toBe(OPEN_STOCK_METRIC);
    expect(record.contractVersion).toBe(OPEN_STOCK_CONTRACT_VERSION);
    expect(record.service).toBe('cloud-agent-next');
    expect(record.environment).toBeNull();
    expect(record.evaluationId).toBe(`${OPEN_STOCK_METRIC}:${now}`);
    expect(record.collectionTimestamp).toBe(now);
    expect(typeof record.queryElapsedMs).toBe('number');
    expect(record.coverage).toBe(COVERAGE_LABEL);
    expect(record.retentionCutoff).toBe(retentionCutoffIso);
    expect(record.expectedGenerations).toEqual(['legacy', 'control']);
    expect(record.limitations).toEqual([...OPEN_STOCK_LIMITATIONS]);
    expect(record.collectionStatus).toBe('complete');
    expect(record.generations).toHaveLength(2);
    expect(record.windowMinutes).toBeUndefined();
    expect(record.windowStart).toBeUndefined();
    expect(record.windowEnd).toBeUndefined();
    expect(record.reportingDelayMs).toBeUndefined();
  });

  it('emits exactly one failed record with no generations when the query rejects', async () => {
    getPgDbMock.mockReturnValue(makeDb(new Error('stock query failed')).db);

    await expect(
      runCloudAgentOpenStockCollection({} as never, new Date(now))
    ).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).not.toHaveBeenCalled();
    const record = loggerMock.withFields.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(record.collectionStatus).toBe('failed');
    expect(record.failureKind).toBe('db_query_failed');
    expect(record.generations).toBeUndefined();
    expect(record.limitations).toEqual([...OPEN_STOCK_LIMITATIONS]);
  });

  it('emits a failed record when the database binding throws', async () => {
    getPgDbMock.mockImplementation(() => {
      throw new Error('HYPERDRIVE binding missing');
    });

    await expect(
      runCloudAgentOpenStockCollection({} as never, new Date(now))
    ).resolves.toBeUndefined();

    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).not.toHaveBeenCalled();
    const record = loggerMock.withFields.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(record.collectionStatus).toBe('failed');
    expect(record.failureKind).toBe('db_query_failed');
    expect(record.generations).toBeUndefined();
  });
});
