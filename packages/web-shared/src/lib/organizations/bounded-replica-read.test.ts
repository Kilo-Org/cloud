import { describe, test, expect, afterEach } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  BOUNDED_READ_LOCK_TIMEOUT_MS,
  BOUNDED_READ_STATEMENT_TIMEOUT_MS,
  BoundedReplicaReadError,
  classifyBoundedReadError,
  withBoundedReplicaRead,
} from './bounded-replica-read';

describe('withBoundedReplicaRead', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('runs on the read replica and sets both bounds before the read', async () => {
    const statements: string[] = [];
    const transaction = readDb.transaction.bind(readDb) as (
      run: (tx: Parameters<Parameters<typeof readDb.transaction>[0]>[0]) => Promise<unknown>
    ) => Promise<unknown>;
    const spy = jest.spyOn(readDb, 'transaction').mockImplementation(
      run =>
        transaction(async tx => {
          const execute = tx.execute.bind(tx);
          jest.spyOn(tx, 'execute').mockImplementation(query => {
            statements.push(
              typeof query === 'string' ? query : new PgDialect().sqlToQuery(query.getSQL()).sql
            );
            return execute(query);
          });
          return run(tx);
        }) as never
    );

    const result = await withBoundedReplicaRead('agent_interactions', async tx => {
      statements.push('read');
      const rows = await tx.execute(
        sql`select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout`
      );
      return rows.rows[0];
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(statements.slice(0, 3)).toEqual([
      `SET LOCAL statement_timeout = ${BOUNDED_READ_STATEMENT_TIMEOUT_MS}`,
      `SET LOCAL lock_timeout = ${BOUNDED_READ_LOCK_TIMEOUT_MS}`,
      'read',
    ]);
    expect(result).toEqual({ statement_timeout: '10s', lock_timeout: '2s' });
  });

  test('does not leak the bounds to the connection after the transaction', async () => {
    await withBoundedReplicaRead('members', async () => undefined);
    const rows = await readDb.execute(sql`select current_setting('statement_timeout') as value`);
    expect(rows.rows[0]).not.toEqual({ value: '10s' });
  });

  test('recognizes a real statement timeout wrapped by Drizzle', async () => {
    await expect(
      withBoundedReplicaRead('agent_interactions', async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = 50`);
        return tx.execute(sql`select pg_sleep(2)`);
      })
    ).rejects.toMatchObject({
      diagnostics: {
        sqlstate: '57014',
        reason: 'statement_timeout',
        query: 'agent_interactions',
        replica: 'primary',
        elapsedMs: expect.any(Number),
      },
    });
  });

  test('propagates unrecognized failures unchanged', async () => {
    const error = new Error('unexpected');
    await expect(
      withBoundedReplicaRead('members', async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });

  test('wraps an expected failure without attaching its raw cause', async () => {
    const error = new Error('Failed query: private SQL and params', { cause: { code: '55P03' } });
    const result = withBoundedReplicaRead('members', async () => {
      throw error;
    });
    await expect(result).rejects.toBeInstanceOf(BoundedReplicaReadError);
    await expect(result).rejects.toHaveProperty('message', 'Bounded replica read did not complete');
    await expect(result).rejects.not.toHaveProperty('cause');
  });
});

describe('classifyBoundedReadError', () => {
  test.each([
    ['57014', 'canceling statement due to statement timeout', 'statement_timeout'],
    ['57014', 'canceling statement due to user request', 'query_canceled'],
    ['55P03', 'canceling statement due to lock timeout', 'lock_timeout'],
    ['55P03', 'could not obtain lock', 'lock_not_available'],
    ['40001', 'canceling statement due to conflict with recovery', 'replica_recovery_conflict'],
    ['40001', 'could not serialize access', 'serialization_failure'],
  ])('classifies %s: %s through wrapped causes', (code, message, reason) => {
    const cause = new Error('Failed query', { cause: { code, message } });
    expect(classifyBoundedReadError(new Error('outer', { cause }))).toEqual({
      sqlstate: code,
      reason,
    });
  });

  test('rejects other errors', () => {
    expect(classifyBoundedReadError(new Error('boom'))).toBeUndefined();
    expect(classifyBoundedReadError({ code: '23505' })).toBeUndefined();
    expect(classifyBoundedReadError(null)).toBeUndefined();
    expect(classifyBoundedReadError('57014')).toBeUndefined();
  });

  test('terminates on a cyclic cause chain', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(classifyBoundedReadError(error)).toBeUndefined();
  });
});
