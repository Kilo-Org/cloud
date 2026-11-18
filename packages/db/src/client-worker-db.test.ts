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
    const done = typeof values === 'function' ? (values as QueryCallback) : callback;
    if (!done) return Promise.resolve(result);
    queueMicrotask(() => done(null, result));
    return undefined;
  }

  end(callback?: () => void): void {
    this.ended = true;
    this._ending = true;
    this._queryable = false;
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
