// Counters attach to the real pool only outside the test environment, so the pool
// is stubbed here and the gauges are driven directly. The stub is built inside the
// factory because `jest.mock` is hoisted above this file's own declarations, so
// referencing an outer const here throws "Cannot access before initialization".
jest.mock('@/lib/drizzle', () => ({
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0, on: jest.fn() },
}));

import { beforeEach, describe, expect, test } from '@jest/globals';

import {
  isTransactionBeginFailure,
  readPoolLeakStats,
  recordTransactionBeginFailure,
  __resetPoolLeakCountersForTest,
} from './db-pool-leak-probe';

const { pool: mockPool } = jest.requireMock<{
  pool: { totalCount: number; idleCount: number };
}>('@/lib/drizzle');

function drizzleError(message: string, cause?: unknown) {
  const error = new Error(message);
  error.name = 'DrizzleQueryError';
  if (cause !== undefined) (error as unknown as { cause: unknown }).cause = cause;
  return error;
}

beforeEach(() => {
  __resetPoolLeakCountersForTest();
  mockPool.totalCount = 0;
  mockPool.idleCount = 0;
});

describe('isTransactionBeginFailure', () => {
  // BEGIN takes no parameters, which is what makes matching the message safe here
  // and unsafe for every other statement in this path.
  test.each([
    'Failed query: begin',
    'Failed query: begin\nparams: ',
    'Failed query: BEGIN',
    '  Failed query: begin isolation level serializable',
  ])('recognises %j', message => {
    expect(isTransactionBeginFailure(drizzleError(message))).toBe(true);
  });

  test('recognises a begin failure nested in the cause chain', () => {
    expect(
      isTransactionBeginFailure(drizzleError('wrapper', drizzleError('Failed query: begin')))
    ).toBe(true);
  });

  // These must not be counted as leaks: the statement failed inside the
  // try/finally, so drizzle released the client.
  test.each([
    'Failed query: WITH microdollar_usage_ins AS (...) params: 3f5826e7,You are Kilo',
    'Failed query: commit',
    'Failed query: rollback',
    'Failed query: select 1',
    'Connection terminated unexpectedly',
  ])('does not match %j', message => {
    expect(isTransactionBeginFailure(drizzleError(message))).toBe(false);
  });

  test('does not match a statement that merely mentions begin', () => {
    expect(isTransactionBeginFailure(drizzleError('Failed query: select * from beginnings'))).toBe(
      false
    );
  });

  test('does not throw on null or a primitive', () => {
    expect(isTransactionBeginFailure(null)).toBe(false);
    expect(isTransactionBeginFailure('nope')).toBe(false);
  });
});

describe('readPoolLeakStats', () => {
  test('derives checked_out from the pool gauges', () => {
    mockPool.totalCount = 10;
    mockPool.idleCount = 3;
    expect(readPoolLeakStats().checked_out).toBe(7);
  });

  test('reports min_checked_out as null until a pool event is seen', () => {
    expect(readPoolLeakStats().min_checked_out).toBeNull();
  });

  test('counts begin failures, the per-leak unit', () => {
    recordTransactionBeginFailure();
    recordTransactionBeginFailure();
    expect(readPoolLeakStats().begin_failures).toBe(2);
  });

  test('reports outstanding as acquires minus releases', () => {
    const stats = readPoolLeakStats();
    expect(stats.outstanding).toBe(stats.acquires - stats.releases);
  });

  test('exposes uptime so a low-water mark can be read against instance age', () => {
    expect(readPoolLeakStats().instance_uptime_ms).toBeGreaterThanOrEqual(0);
  });
});
