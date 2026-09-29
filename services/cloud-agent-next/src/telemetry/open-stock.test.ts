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

import { AGENT_OPEN_METRIC, COLLECTION_METRIC } from './outcome-aggregate.js';
import {
  assembleOpenStock,
  readOpenStock,
  runCloudAgentOpenStockCollection,
  type OpenStockQueryRow,
} from './open-stock.js';

const retentionCutoffIso = '2025-11-03T00:10:00.000Z';
const observedAt = '2026-02-01T00:10:00.000Z';

type QueryResult = OpenStockQueryRow[] | Error;

function queryRow(
  input: Partial<OpenStockQueryRow> & {
    generation: OpenStockQueryRow['generation'];
    status: OpenStockQueryRow['status'];
  }
): OpenStockQueryRow {
  return {
    turns: 0,
    origin: 'unknown',
    oldestQueuedEpochMs: null,
    oldestAcceptedEpochMs: null,
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
  it('emits six generation-by-origin cells including zeros', () => {
    const cells = assembleOpenStock([], observedAt);
    expect(cells).toHaveLength(6);
    expect(cells.map(cell => `${cell.generation}/${cell.productOrigin}`)).toEqual([
      'legacy/code-review',
      'legacy/other',
      'legacy/unknown',
      'control/code-review',
      'control/other',
      'control/unknown',
    ]);
    for (const cell of cells) {
      expect(cell).toMatchObject({
        queuedTurns: 0,
        acceptedTurns: 0,
        oldestQueuedAgeMs: null,
        oldestAcceptedAgeMs: null,
      });
    }
  });

  it('keeps a null age when the cell has no timestamp but still counts the turn', () => {
    const cells = assembleOpenStock(
      [
        queryRow({
          generation: 'legacy',
          status: 'queued',
          turns: 3,
          origin: 'code-review',
          oldestQueuedEpochMs: null,
        }),
      ],
      observedAt
    );

    const cell = cells.find(
      entry => entry.generation === 'legacy' && entry.productOrigin === 'code-review'
    );
    expect(cell?.queuedTurns).toBe(3);
    expect(cell?.oldestQueuedAgeMs).toBeNull();
  });

  it('derives each age from that cell own minimum timestamp, not another origin', () => {
    const queuedEpochMs = Date.parse('2026-02-01T00:00:00.000Z');
    const acceptedEpochMs = Date.parse('2026-01-31T23:55:00.000Z');
    const otherEpochMs = Date.parse('2026-01-31T00:00:00.000Z');
    const cells = assembleOpenStock(
      [
        queryRow({
          generation: 'legacy',
          status: 'queued',
          origin: 'code-review',
          turns: 1,
          oldestQueuedEpochMs: queuedEpochMs,
        }),
        queryRow({
          generation: 'legacy',
          status: 'accepted',
          origin: 'code-review',
          turns: 2,
          oldestAcceptedEpochMs: acceptedEpochMs,
        }),
        queryRow({
          generation: 'legacy',
          status: 'queued',
          origin: 'other',
          turns: 4,
          oldestQueuedEpochMs: otherEpochMs,
        }),
      ],
      observedAt
    );

    const review = cells.find(
      entry => entry.generation === 'legacy' && entry.productOrigin === 'code-review'
    );
    const other = cells.find(
      entry => entry.generation === 'legacy' && entry.productOrigin === 'other'
    );
    expect(review?.oldestQueuedAgeMs).toBe(Date.parse(observedAt) - queuedEpochMs);
    expect(review?.oldestAcceptedAgeMs).toBe(Date.parse(observedAt) - acceptedEpochMs);
    expect(other?.oldestQueuedAgeMs).toBe(Date.parse(observedAt) - otherEpochMs);
    expect(other?.oldestQueuedAgeMs).not.toBe(review?.oldestQueuedAgeMs);
  });
});

describe('cloud agent open stock query shape', () => {
  it('narrows to non-terminal queued/accepted runs of retained sessions without session or age-missing counters', async () => {
    const fake = makeDb([]);
    await readOpenStock(fake.db as never, { retentionCutoff: retentionCutoffIso });

    const fields = fake.state.fields as Record<string, unknown>;
    const selectSql = renderSelect(fields);
    const whereSql = renderWhere(fake.state.where, fake.state.groupBy ?? []);

    expect(selectSql.params).toEqual([10, 'workspace_']);
    expect(selectSql.sql).toMatch(
      /left\("cloud_agent_session_runs"\."cloud_agent_session_id", \$1\) = \$2/
    );
    expect(selectSql.sql).toContain('count(*)::int');
    expect(selectSql.sql).toContain('extract(epoch from');
    expect(selectSql.sql).toContain('::double precision');
    expect(selectSql.sql).not.toContain('count(distinct');
    expect(selectSql.sql).not.toContain('queuedMissingAgeTurns');
    expect(selectSql.sql).not.toContain('acceptedMissingAgeTurns');

    expect(whereSql.sql).toContain('"status" in ($1, $2)');
    expect(whereSql.sql).toContain('"terminal_at" is null');
    expect(whereSql.sql).toContain('created_at" > $3');
    expect(whereSql.sql).toContain('group by 1, 2, 3');
    expect(whereSql.params).toEqual(['queued', 'accepted', retentionCutoffIso]);
  });
});

describe('runCloudAgentOpenStockCollection emission', () => {
  it('emits exactly six agent_open rows including zeros', async () => {
    getPgDbMock.mockReturnValue(makeDb([]).db);

    await runCloudAgentOpenStockCollection({} as never, new Date(observedAt));

    expect(loggerMock.info).toHaveBeenCalledTimes(6);
    expect(loggerMock.error).not.toHaveBeenCalled();
    const records = loggerMock.withFields.mock.calls.map(
      ([fields]) => fields as Record<string, unknown>
    );
    expect(records).toHaveLength(6);
    for (const record of records) {
      expect(record.metric).toBe(AGENT_OPEN_METRIC);
      expect(record.observedAt).toBe(observedAt);
      expect(record.queuedTurns).toBe(0);
      expect(record.acceptedTurns).toBe(0);
      expect(record.oldestQueuedAgeMs).toBeNull();
      expect(record.oldestAcceptedAgeMs).toBeNull();
      expect(record).not.toHaveProperty('environment');
      expect(record).not.toHaveProperty('sessions');
      expect(record).not.toHaveProperty('windowStart');
      expect(record).not.toHaveProperty('windowEnd');
      expect(record).not.toHaveProperty('role');
    }
  });

  it('logs one agent_open collection row and no count rows when the query rejects', async () => {
    getPgDbMock.mockReturnValue(makeDb(new Error('stock query failed')).db);

    await expect(
      runCloudAgentOpenStockCollection({} as never, new Date(observedAt))
    ).resolves.toBeUndefined();

    expect(loggerMock.info).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const record = loggerMock.withFields.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record).toEqual({
      metric: COLLECTION_METRIC,
      collector: AGENT_OPEN_METRIC,
      observedAt,
      status: 'failed',
    });
  });

  it('logs one agent_open collection row when the database binding throws', async () => {
    getPgDbMock.mockImplementation(() => {
      throw new Error('HYPERDRIVE binding missing');
    });

    await expect(
      runCloudAgentOpenStockCollection({} as never, new Date(observedAt))
    ).resolves.toBeUndefined();

    expect(loggerMock.info).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const record = loggerMock.withFields.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.metric).toBe(COLLECTION_METRIC);
    expect(record.collector).toBe(AGENT_OPEN_METRIC);
  });
});
