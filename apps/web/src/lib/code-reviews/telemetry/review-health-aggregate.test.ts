import fs from 'node:fs';
import path from 'node:path';
import { getWorkerDb } from '@kilocode/db/client';
import {
  REVIEW_COLLECTION_METRIC,
  REVIEW_OPEN_METRIC,
  REVIEW_OUTCOME_METRIC,
  REVIEW_REASON_METRIC,
  REVIEW_START_METRIC,
  assembleReviewOutcome,
  classifyReviewReason,
  collectCodeReviewOpenStock,
  collectCodeReviewOutcome,
  reviewOpenCountsQuery,
  reviewOutcomeStatusQuery,
  reviewStartedLatencyQuery,
  reviewTerminalMissingOutcomeTimeQuery,
  reviewWindow,
  REVIEW_BUCKET_MINUTES,
  type ReviewWindow,
} from './review-health-aggregate';

jest.mock('@/lib/drizzle', () => ({ db: {} }));

const window: ReviewWindow = {
  start: '2026-02-01T00:05:00.000Z',
  end: '2026-02-01T00:10:00.000Z',
};

const expectedEnvironment = process.env.VERCEL_ENV ?? null;

const zeroLatency = {
  startedSampleCount: 0,
  startedWithinFiveMinutes: 0,
  p95WaitMs: null,
};

const zeroOpenCounts = {
  pendingCount: 0,
  pendingOverFiveMinutes: 0,
  oldestPendingAgeMs: null,
  staleQueuedClaimCount: 0,
  runningOverNinetyMinutes: 0,
};

const usageDb = () => getWorkerDb('postgres://unused:unused@localhost:0/unused');

type FakeResults = {
  statusRows?: unknown[] | Error;
  latencyRow?: unknown;
  openCounts?: unknown;
  terminalMissing?: number;
};

function fakeDatabase(results: FakeResults) {
  return {
    select(selection: Record<string, unknown>) {
      const isTerminalMissing = 'terminalMissingOutcomeTime' in selection;
      const isLatency = 'startedSampleCount' in selection;
      const chain: {
        hasGroup: boolean;
        from: () => unknown;
        where: () => unknown;
        groupBy: () => unknown;
        then: (
          resolve: (value: unknown[]) => unknown,
          reject: (reason: unknown) => unknown
        ) => unknown;
      } = {
        hasGroup: false,
        from: () => chain,
        where: () => chain,
        groupBy: () => {
          chain.hasGroup = true;
          return chain;
        },
        then: (resolve, reject) => {
          if (chain.hasGroup) {
            if (results.statusRows instanceof Error) return reject(results.statusRows);
            return resolve(results.statusRows ?? []);
          }
          if (isTerminalMissing) {
            return resolve([{ terminalMissingOutcomeTime: results.terminalMissing ?? 0 }]);
          }
          const value = isLatency ? results.latencyRow : results.openCounts;
          if (value instanceof Error) return reject(value);
          return resolve([value]);
        },
      };
      return chain;
    },
  };
}

const outcomeRow = (input: { status: string; terminalReason: string | null; rowCount: number }) =>
  input;

describe('review outcome assembly', () => {
  it('classifies benign, system and unknown and collapses unrecognized into one bounded row', () => {
    const { headline, reasons } = assembleReviewOutcome([
      outcomeRow({ status: 'completed', terminalReason: null, rowCount: 2 }),
      outcomeRow({ status: 'failed', terminalReason: 'model_not_found', rowCount: 1 }),
      outcomeRow({ status: 'failed', terminalReason: 'sandbox_error', rowCount: 1 }),
      outcomeRow({ status: 'cancelled', terminalReason: 'superseded', rowCount: 1 }),
      outcomeRow({ status: 'failed', terminalReason: null, rowCount: 1 }),
      outcomeRow({ status: 'failed', terminalReason: 'unrecognized_reason', rowCount: 1 }),
      outcomeRow({ status: 'interrupted', terminalReason: 'unknown', rowCount: 1 }),
    ]);

    expect(headline).toEqual({ completed: 2, failed: 4, cancelled: 1, interrupted: 1 });
    expect(reasons).toEqual([
      { reason: 'model_not_found', reasonClass: 'benign', count: 1 },
      { reason: 'sandbox_error', reasonClass: 'system', count: 1 },
      { reason: 'superseded', reasonClass: 'benign', count: 1 },
      { reason: 'unknown', reasonClass: 'unknown', count: 1 },
      { reason: 'unrecognized', reasonClass: 'unknown', count: 2 },
    ]);
    const classSum = reasons.reduce((sum, row) => sum + row.count, 0);
    expect(classSum).toBe(headline.failed + headline.cancelled + headline.interrupted);
    const benign = reasons
      .filter(row => row.reasonClass === 'benign')
      .reduce((sum, row) => sum + row.count, 0);
    const system = reasons
      .filter(row => row.reasonClass === 'system')
      .reduce((sum, row) => sum + row.count, 0);
    const unknown = reasons
      .filter(row => row.reasonClass === 'unknown')
      .reduce((sum, row) => sum + row.count, 0);
    expect({ benign, system, unknown }).toEqual({ benign: 2, system: 1, unknown: 3 });
  });

  it('does not count a status outside the four terminals', () => {
    const { headline, reasons } = assembleReviewOutcome([
      outcomeRow({ status: 'completed', terminalReason: null, rowCount: 1 }),
      outcomeRow({ status: 'pending', terminalReason: null, rowCount: 5 }),
      outcomeRow({ status: 'still_queued', terminalReason: null, rowCount: 3 }),
      outcomeRow({ status: 'completed', terminalReason: null, rowCount: 4 }),
    ]);

    expect(headline).toEqual({ completed: 5, failed: 0, cancelled: 0, interrupted: 0 });
    expect(reasons).toEqual([]);
  });

  it('returns explicit zeros and no reasons for a zero window', () => {
    const { headline, reasons } = assembleReviewOutcome([]);
    expect(headline).toEqual({ completed: 0, failed: 0, cancelled: 0, interrupted: 0 });
    expect(reasons).toEqual([]);
  });

  it('keeps literal unknown out of system and out of a merged unrecognized row', () => {
    expect(classifyReviewReason('unknown')).toBe('unknown');
    expect(classifyReviewReason('unrecognized')).toBe('unknown');
    expect(classifyReviewReason('model_not_found')).toBe('benign');
    expect(classifyReviewReason('superseded')).toBe('benign');
    expect(classifyReviewReason('sandbox_error')).toBe('system');
  });
});

describe('review window', () => {
  it('closes the 5-minute bucket after a two-minute reporting allowance', () => {
    expect(reviewWindow(new Date('2026-02-01T00:10:00.000Z'))).toEqual({
      start: '2026-02-01T00:00:00.000Z',
      end: '2026-02-01T00:05:00.000Z',
    });
    expect(reviewWindow(new Date('2026-02-01T00:12:00.000Z'))).toEqual({
      start: '2026-02-01T00:05:00.000Z',
      end: '2026-02-01T00:10:00.000Z',
    });
  });

  it('keeps the Vercel cron cadence equal to the bucket width', () => {
    const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
      crons: { path: string; schedule: string }[];
    };
    const cronSchedule = config.crons.find(
      cron => cron.path === '/api/cron/code-review-outcome-aggregate'
    )?.schedule;
    expect(cronSchedule).toBe(`*/${REVIEW_BUCKET_MINUTES} * * * *`);
  });
});

describe('review SQL allowlist', () => {
  it('queries only cloud_agent_code_reviews and never the attempts table', () => {
    const databases = [
      reviewOutcomeStatusQuery(usageDb() as never, window).toSQL(),
      reviewStartedLatencyQuery(usageDb() as never, window).toSQL(),
      reviewOpenCountsQuery(usageDb() as never).toSQL(),
      reviewTerminalMissingOutcomeTimeQuery(usageDb() as never).toSQL(),
    ];

    for (const query of databases) {
      expect(query.sql).not.toContain('cloud_agent_code_review_attempts');
    }
  });

  it('matches the terminal-missing index predicate in the WHERE clause', () => {
    const query = reviewTerminalMissingOutcomeTimeQuery(usageDb() as never).toSQL();

    expect(query.sql).toMatch(/"status" in \(\$\d+, \$\d+, \$\d+, \$\d+\)/);
    expect(query.sql).toMatch(/"completed_at" is null/);
  });

  it('restricts the open-stock scan to non-terminal statuses in the WHERE clause', () => {
    const query = reviewOpenCountsQuery(usageDb() as never).toSQL();

    expect(query.sql).toMatch(/"status" in \(\$\d+, \$\d+, \$\d+\)/);
  });
});

describe('review collection wiring', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function loggedRecords(): Record<string, unknown>[] {
    return logSpy.mock.calls.map(([line]) => JSON.parse(line as string));
  }

  it('logs one outcome and one start for the closed bucket and no reason rows', async () => {
    const database = fakeDatabase({ statusRows: [], latencyRow: zeroLatency });

    const status = await collectCodeReviewOutcome(
      new Date('2026-02-01T00:12:00.000Z'),
      database as never
    );

    expect(status).toBe('complete');
    expect(logSpy).toHaveBeenCalledTimes(2);
    const records = loggedRecords();
    expect(records.map(record => record.metric)).toEqual([
      REVIEW_OUTCOME_METRIC,
      REVIEW_START_METRIC,
    ]);
    for (const record of records) {
      expect(record.observedAt).toBe('2026-02-01T00:12:00.000Z');
      expect(record.windowStart).toBe('2026-02-01T00:05:00.000Z');
      expect(record.windowEnd).toBe('2026-02-01T00:10:00.000Z');
    }
    const outcome = records[0];
    expect(outcome).toMatchObject({ completed: 0, failed: 0, cancelled: 0, interrupted: 0 });
    expect(outcome).not.toHaveProperty('reason');
    expect(outcome).not.toHaveProperty('reasonClass');
    expect(outcome).not.toHaveProperty('windowMinutes');
    const start = records[1];
    expect(start).toMatchObject({ started: 0, startedWithinFiveMinutes: 0, p95WaitMs: null });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs the outcome row and only a review_reason breakdown when reasons are present', async () => {
    const database = fakeDatabase({
      statusRows: [
        outcomeRow({ status: 'failed', terminalReason: 'sandbox_error', rowCount: 2 }),
        outcomeRow({ status: 'cancelled', terminalReason: 'model_not_found', rowCount: 1 }),
      ],
      latencyRow: zeroLatency,
    });

    const status = await collectCodeReviewOutcome(
      new Date('2026-02-01T00:10:00.000Z'),
      database as never
    );

    expect(status).toBe('complete');
    const records = loggedRecords();
    expect(records.map(record => record.metric)).toEqual([
      REVIEW_OUTCOME_METRIC,
      REVIEW_REASON_METRIC,
      REVIEW_REASON_METRIC,
      REVIEW_START_METRIC,
    ]);
    const outcome = records[0];
    expect(outcome).toMatchObject({ failed: 2, cancelled: 1, completed: 0, interrupted: 0 });
    expect(outcome).not.toHaveProperty('reasonCounts');
    expect(records[1]).toMatchObject({
      reason: 'model_not_found',
      reasonClass: 'benign',
      count: 1,
      observedAt: '2026-02-01T00:10:00.000Z',
    });
    expect(records[2]).toMatchObject({
      reason: 'sandbox_error',
      reasonClass: 'system',
      count: 2,
    });
  });

  it('still logs the start row and one outcome collection error when the status query throws', async () => {
    const database = fakeDatabase({ statusRows: new Error('boom'), latencyRow: zeroLatency });

    const status = await collectCodeReviewOutcome(
      new Date('2026-02-01T00:10:00.000Z'),
      database as never
    );

    expect(status).toBe('failed');
    const records = loggedRecords();
    expect(records.map(record => record.metric)).toEqual([REVIEW_START_METRIC]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const error = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(error).toEqual({
      metric: REVIEW_COLLECTION_METRIC,
      collector: REVIEW_OUTCOME_METRIC,
      environment: expectedEnvironment,
      observedAt: '2026-02-01T00:10:00.000Z',
      status: 'failed',
    });
  });

  it('still logs the outcome row and one start collection error when the latency query throws', async () => {
    const database = fakeDatabase({ statusRows: [], latencyRow: new Error('boom') });

    const status = await collectCodeReviewOutcome(
      new Date('2026-02-01T00:10:00.000Z'),
      database as never
    );

    expect(status).toBe('failed');
    const records = loggedRecords();
    expect(records.map(record => record.metric)).toEqual([REVIEW_OUTCOME_METRIC]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const error = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(error).toEqual({
      metric: REVIEW_COLLECTION_METRIC,
      collector: REVIEW_START_METRIC,
      environment: expectedEnvironment,
      observedAt: '2026-02-01T00:10:00.000Z',
      status: 'failed',
    });
  });

  it('emits a renamed open-stock snapshot with explicit zeros', async () => {
    const database = fakeDatabase({ openCounts: zeroOpenCounts, terminalMissing: 0 });

    const status = await collectCodeReviewOpenStock(
      new Date('2026-02-01T00:10:00.000Z'),
      database as never
    );

    expect(status).toBe('complete');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(record).toEqual({
      metric: REVIEW_OPEN_METRIC,
      environment: expectedEnvironment,
      observedAt: '2026-02-01T00:10:00.000Z',
      pending: 0,
      pendingOverFiveMinutes: 0,
      oldestPendingAgeMs: null,
      staleQueued: 0,
      runningOverNinetyMinutes: 0,
      missingCompletedAt: 0,
    });
    expect(record).not.toHaveProperty('windowStart');
    expect(record).not.toHaveProperty('pendingCount');
  });

  it('emits one review_open collection error and no open row when a query throws', async () => {
    const database = fakeDatabase({ openCounts: new Error('boom') });

    const status = await collectCodeReviewOpenStock(
      new Date('2026-02-01T00:10:00.000Z'),
      database as never
    );

    expect(status).toBe('failed');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const record = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(record).toEqual({
      metric: REVIEW_COLLECTION_METRIC,
      collector: REVIEW_OPEN_METRIC,
      environment: expectedEnvironment,
      observedAt: '2026-02-01T00:10:00.000Z',
      status: 'failed',
    });
  });
});
