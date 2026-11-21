import { describe, test, expect } from '@jest/globals';
import { NextResponse } from 'next/server';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { db, readDb, sql } from '@kilocode/web-shared/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import {
  boundedGatewayReplicaRead,
  GATEWAY_REPLICA_LOCK_TIMEOUT_MS,
  GATEWAY_REPLICA_STATEMENT_TIMEOUT_MS,
  GatewayReplicaReadUnavailableError,
  gatewayReplicaReadBoundsSql,
  gatewayReplicaReader,
  replicaReadUnavailableResponse,
  withReplicaReadUnavailableResponse,
} from './gateway-replica-read';
import { boundedReadErrorSqlState } from '@kilocode/web-shared/lib/organizations/bounded-replica-read';

function pgError(code: string, message = 'pg error'): Error {
  return Object.assign(new Error(message), { code });
}

async function sqlStateOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error('expected the read to fail');
    },
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(GatewayReplicaReadUnavailableError);
  return (error as GatewayReplicaReadUnavailableError).sqlState;
}

describe('boundedReadErrorSqlState', () => {
  test.each([
    ['57014', 'canceling statement due to statement timeout'],
    ['55P03', 'canceling statement due to lock timeout'],
    ['40001', 'canceling statement due to conflict with recovery'],
  ])('classifies SQLSTATE %s', (code, message) => {
    expect(boundedReadErrorSqlState(pgError(code, message))).toBe(code);
  });

  test("classifies a pg error wrapped in Drizzle's DrizzleQueryError cause", () => {
    const wrapped = new DrizzleQueryError('select 1', [], pgError('57014'));
    expect(boundedReadErrorSqlState(wrapped)).toBe('57014');
  });

  test('classifies a pg error several causes deep', () => {
    const wrapped = new Error('outer', {
      cause: new DrizzleQueryError('select 1', [], pgError('55P03')),
    });
    expect(boundedReadErrorSqlState(wrapped)).toBe('55P03');
  });

  test.each([
    ['unique violation', pgError('23505')],
    ['connection error', pgError('ECONNREFUSED')],
    ['wrapped other SQLSTATE', new DrizzleQueryError('select 1', [], pgError('42P01'))],
    ['error without code', new Error('boom')],
    ['undefined', undefined],
  ])('ignores %s', (_label, error) => {
    expect(boundedReadErrorSqlState(error)).toBeNull();
  });
});

describe('replica read unavailable response', () => {
  test('is a retryable 503 in the gateway error shape', async () => {
    const response = replicaReadUnavailableResponse();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(await response.json()).toEqual({
      error: 'Service Unavailable',
      error_type: 'temporarily_unavailable',
      message: 'The service is temporarily unavailable. Please retry in a few seconds.',
    });
  });

  test('wrapped handler answers a bounded read failure with the 503', async () => {
    const handler = withReplicaReadUnavailableResponse(async () => {
      throw new GatewayReplicaReadUnavailableError('balance', '57014', pgError('57014'));
    });
    const response = await handler();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
  });

  test('wrapped handler rethrows other errors unchanged', async () => {
    const failure = pgError('57014');
    const handler = withReplicaReadUnavailableResponse(async () => {
      throw failure;
    });
    await expect(handler()).rejects.toBe(failure);
  });

  test('wrapped handler passes its response and arguments through', async () => {
    const handler = withReplicaReadUnavailableResponse(async (status: number) =>
      NextResponse.json({ ok: true }, { status })
    );
    expect((await handler(201)).status).toBe(201);
  });
});

describe('boundedGatewayReplicaRead', () => {
  test('sends the SET LOCAL bounds on the connection and transaction of the read', async () => {
    const statements: { client: unknown; text: string }[] = [];
    const pool = readDb.$client;
    const connect = pool.connect.bind(pool);
    const connectSpy = jest.spyOn(pool, 'connect').mockImplementation((async () => {
      const client = await connect();
      const query = client.query.bind(client) as (config: unknown, ...rest: unknown[]) => unknown;
      const recordingQuery = (config: unknown, ...rest: unknown[]) => {
        const text = typeof config === 'string' ? config : (config as { text: string }).text;
        statements.push({ client, text });
        return query(config, ...rest);
      };
      const release = client.release.bind(client);
      Object.assign(client, {
        query: recordingQuery,
        release: (error?: Error | boolean) => {
          Object.assign(client, { query, release });
          release(error);
        },
      });
      return client;
    }) as typeof pool.connect);
    try {
      await boundedGatewayReplicaRead('balance', tx =>
        tx.select({ id: organizations.id }).from(organizations).limit(1)
      );
    } finally {
      connectSpy.mockRestore();
    }

    expect(statements.map(statement => statement.text)).toEqual([
      'begin read only',
      gatewayReplicaReadBoundsSql,
      expect.stringMatching(/^select "id" from "organizations"/),
      'commit',
    ]);
    expect(new Set(statements.map(statement => statement.client)).size).toBe(1);
    expect(gatewayReplicaReadBoundsSql).toBe(
      `SET LOCAL statement_timeout = '${GATEWAY_REPLICA_STATEMENT_TIMEOUT_MS}ms'; ` +
        `SET LOCAL lock_timeout = '${GATEWAY_REPLICA_LOCK_TIMEOUT_MS}ms'`
    );
  });

  test('the read sees the bounds, and they end with its transaction', async () => {
    const inside = await boundedGatewayReplicaRead('balance', async tx => {
      const { rows } = await tx.execute<{ statement_timeout: string; lock_timeout: string }>(
        sql`select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout`
      );
      return rows[0];
    });
    expect(inside).toMatchObject({ statement_timeout: '3s', lock_timeout: '1s' });

    const { rows } = await readDb.execute<{ statement_timeout: string; lock_timeout: string }>(
      sql`select current_setting('statement_timeout') as statement_timeout, current_setting('lock_timeout') as lock_timeout`
    );
    expect(rows[0].statement_timeout).not.toBe('3s');
    expect(rows[0].lock_timeout).not.toBe('1s');
  });

  test('passes the isolation level through and keeps the transaction read only', async () => {
    const settings = await gatewayReplicaReader('organization-group-policy')(
      async tx => {
        const { rows } = await tx.execute<{ isolation: string; read_only: string }>(
          sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`
        );
        return rows[0];
      },
      { isolationLevel: 'repeatable read' }
    );
    expect(settings).toEqual({ isolation: 'repeatable read', read_only: 'on' });
  });

  test('propagates errors that are not bound failures unchanged', async () => {
    await expect(
      boundedGatewayReplicaRead('balance', async tx => {
        await tx.execute(sql`select * from table_that_does_not_exist`);
      })
    ).rejects.not.toBeInstanceOf(GatewayReplicaReadUnavailableError);
  });

  test('cancels a statement that runs past statement_timeout', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const startedAt = Date.now();
    try {
      const sqlState = await sqlStateOf(
        boundedGatewayReplicaRead('balance', async tx => {
          await tx.execute(sql`select pg_sleep(10)`);
        })
      );
      expect(sqlState).toBe('57014');
      expect(Date.now() - startedAt).toBeLessThan(8_000);
      expect(warn).toHaveBeenCalledWith('AI gateway replica read hit its bound', {
        operation: 'balance',
        sqlState: '57014',
      });
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  test('gives up on a lock held by another connection after lock_timeout', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseLock = () => {};
    const lockReleased = new Promise<void>(resolve => {
      releaseLock = resolve;
    });
    let lockTaken = () => {};
    const lockHeld = new Promise<void>(resolve => {
      lockTaken = resolve;
    });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`lock table organizations in access exclusive mode`);
      lockTaken();
      await lockReleased;
    });
    try {
      await lockHeld;
      const startedAt = Date.now();
      const sqlState = await sqlStateOf(
        boundedGatewayReplicaRead('organization-group-policy', tx =>
          tx.select({ id: organizations.id }).from(organizations).limit(1)
        )
      );
      expect(sqlState).toBe('55P03');
      expect(Date.now() - startedAt).toBeLessThan(GATEWAY_REPLICA_STATEMENT_TIMEOUT_MS);
    } finally {
      releaseLock();
      await holder;
      warn.mockRestore();
    }
  }, 15_000);

  test('a handler whose bounded read times out answers 503', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handler = withReplicaReadUnavailableResponse(async () => {
        await boundedGatewayReplicaRead('auth', tx => tx.execute(sql`select pg_sleep(10)`));
        return NextResponse.json({ ok: true });
      });
      const response = await handler();
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('2');
    } finally {
      warn.mockRestore();
    }
  }, 15_000);
});
