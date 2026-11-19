import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { getWorkerDb, workerTransactionBoundsSql } from './client';

type QueryCallback = (error: Error | null, result: unknown) => void;

/**
 * Stands in for the connection that pg-pool creates, so these tests run the real pool and
 * drizzle transaction code and observe the statements that reach the connection.
 */
class RecordingClient extends EventEmitter {
  static created: RecordingClient[] = [];
  /** Emitted on close, as the Workers socket does when pg closes it. */
  static closeError: Error | undefined;
  /** Rejects statements that start with this text, as Hyperdrive does when its pool is full. */
  static failingStatement: { prefix: string; error: Error } | undefined;
  readonly queries: string[] = [];
  ended = false;
  _queryable = true;
  _ending = false;

  constructor() {
    super();
    RecordingClient.created.push(this);
  }

  connect(callback: (error?: Error) => void): void {
    callback();
  }

  query(
    config: string | { text: string },
    values?: unknown,
    callback?: QueryCallback
  ): Promise<unknown> | undefined {
    const text = typeof config === 'string' ? config : config.text;
    this.queries.push(text);
    const result = { command: 'SELECT', rowCount: 0, rows: [], fields: [] };
    const failing = RecordingClient.failingStatement;
    const error = failing && text.startsWith(failing.prefix) ? failing.error : null;
    const done = typeof values === 'function' ? (values as QueryCallback) : callback;
    if (!done) return error ? Promise.reject(error) : Promise.resolve(result);
    queueMicrotask(() => done(error, result));
    return undefined;
  }

  end(callback?: () => void): void {
    this.ended = true;
    this._ending = true;
    this._queryable = false;
    if (RecordingClient.closeError) this.emit('error', RecordingClient.closeError);
    callback?.();
  }
}

function recordingWorkerDb() {
  return getWorkerDb('postgres://worker.example/db', {
    Client: RecordingClient as unknown as new () => pg.ClientBase,
  });
}

beforeEach(() => {
  RecordingClient.created = [];
  RecordingClient.closeError = undefined;
  RecordingClient.failingStatement = undefined;
});

describe('getWorkerDb transaction bounds', () => {
  it('sends the lock and idle bounds in the same statement as BEGIN', async () => {
    const db = recordingWorkerDb();

    await db.transaction(async tx => {
      await tx.execute(sql`select 1`);
    });

    expect(RecordingClient.created).toHaveLength(1);
    expect(RecordingClient.created[0]?.queries).toEqual([
      `begin; ${workerTransactionBoundsSql}`,
      'select 1',
      'commit',
    ]);
  });

  it('keeps the transaction options that drizzle adds to BEGIN', async () => {
    const db = recordingWorkerDb();

    await db.transaction(async tx => tx.execute(sql`select 1`), {
      isolationLevel: 'read committed',
    });

    expect(RecordingClient.created[0]?.queries[0]).toBe(
      `begin isolation level read committed; ${workerTransactionBoundsSql}`
    );
  });

  it('leaves statements outside a transaction unchanged', async () => {
    const db = recordingWorkerDb();

    await db.execute(sql`select 1`);

    expect(RecordingClient.created[0]?.queries).toEqual(['select 1']);
  });
});

describe('getWorkerDb connection lifetime', () => {
  it('closes the connection when a query releases it', async () => {
    const db = recordingWorkerDb();

    await db.execute(sql`select 1`);

    expect(RecordingClient.created.map(client => client.ended)).toEqual([true]);
    expect(db.$client.totalCount).toBe(0);
  });

  it('closes the connection when a transaction commits', async () => {
    const db = recordingWorkerDb();

    await db.transaction(async tx => tx.execute(sql`select 1`));

    expect(RecordingClient.created.map(client => client.ended)).toEqual([true]);
    expect(db.$client.totalCount).toBe(0);
  });

  it('closes the connection when a transaction rolls back', async () => {
    const db = recordingWorkerDb();

    await expect(
      db.transaction(async tx => {
        await tx.execute(sql`select 1`);
        throw new Error('caller failure');
      })
    ).rejects.toThrow('caller failure');

    expect(RecordingClient.created[0]?.queries.at(-1)).toBe('rollback');
    expect(RecordingClient.created.map(client => client.ended)).toEqual([true]);
    expect(db.$client.totalCount).toBe(0);
  });

  it('reports a connection failure inside a transaction instead of throwing it', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = recordingWorkerDb();
    const failure = new Error('terminating connection due to idle-in-transaction timeout');

    await db.transaction(async () => {
      expect(() => RecordingClient.created[0]?.emit('error', failure)).not.toThrow();
    });

    expect(warn).toHaveBeenCalledWith('Worker database connection failed', {
      error: failure.message,
    });
    warn.mockRestore();
  });

  it('ignores the error that a connection emits when the pool closes it after use', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    RecordingClient.closeError = new Error('Stream was cancelled.');
    const db = recordingWorkerDb();

    await db.execute(sql`select 1`);
    await db.transaction(async tx => tx.execute(sql`select 2`));

    expect(RecordingClient.created.map(client => client.ended)).toEqual([true, true]);
    expect(db.$client.totalCount).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('releases the connection when BEGIN fails, so later queries on the client run', async () => {
    const db = recordingWorkerDb();
    const failure = new Error('Failed to acquire a connection from the pool.');
    RecordingClient.failingStatement = { prefix: 'begin', error: failure };

    await expect(db.transaction(async tx => tx.execute(sql`select 1`))).rejects.toMatchObject({
      cause: failure,
    });

    expect(RecordingClient.created.map(client => client.ended)).toEqual([true]);
    expect(db.$client.totalCount).toBe(0);

    RecordingClient.failingStatement = undefined;
    await db.execute(sql`select 2`);

    expect(RecordingClient.created.map(client => client.queries)).toEqual([
      [`begin; ${workerTransactionBoundsSql}`],
      ['select 2'],
    ]);
    expect(db.$client.totalCount).toBe(0);
  });

  it('bounds the wait for a connection by default and lets the caller shorten it', () => {
    expect(recordingWorkerDb().$client.options.connectionTimeoutMillis).toBe(15_000);
    expect(
      getWorkerDb('postgres://worker.example/db', { connectionTimeoutMillis: 2_500 }).$client
        .options.connectionTimeoutMillis
    ).toBe(2_500);
  });

  it('uses a new connection for each later query on the same client', async () => {
    const db = recordingWorkerDb();

    await db.execute(sql`select 1`);
    await db.execute(sql`select 2`);

    expect(RecordingClient.created.map(client => client.queries)).toEqual([
      ['select 1'],
      ['select 2'],
    ]);
    expect(db.$client.totalCount).toBe(0);
  });
});
