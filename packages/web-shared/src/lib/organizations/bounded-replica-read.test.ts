import { describe, test, expect, afterEach } from '@jest/globals';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  BOUNDED_READ_LOCK_TIMEOUT_MS,
  BOUNDED_READ_STATEMENT_TIMEOUT_MS,
  isBoundedReadError,
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

    const result = await withBoundedReplicaRead(async tx => {
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
    await withBoundedReplicaRead(async () => undefined);
    const rows = await readDb.execute(sql`select current_setting('statement_timeout') as value`);
    expect(rows.rows[0]).not.toEqual({ value: '10s' });
  });

  test('recognizes a real statement timeout wrapped by Drizzle', async () => {
    const error = await withBoundedReplicaRead(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = 50`);
      return tx.execute(sql`select pg_sleep(2)`);
    }).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).not.toBeNull();
    expect(isBoundedReadError(error)).toBe(true);
  });
});

describe('isBoundedReadError', () => {
  test.each(['57014', '55P03', '40001'])('accepts SQLSTATE %s, also under .cause', code => {
    expect(isBoundedReadError({ code })).toBe(true);
    expect(isBoundedReadError(new Error('wrapped', { cause: { code } }))).toBe(true);
    expect(
      isBoundedReadError(new Error('outer', { cause: new Error('mid', { cause: { code } }) }))
    ).toBe(true);
  });

  test('rejects other errors', () => {
    expect(isBoundedReadError(new Error('boom'))).toBe(false);
    expect(isBoundedReadError({ code: '23505' })).toBe(false);
    expect(isBoundedReadError(null)).toBe(false);
    expect(isBoundedReadError('57014')).toBe(false);
  });

  test('terminates on a cyclic cause chain', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(isBoundedReadError(error)).toBe(false);
  });
});
