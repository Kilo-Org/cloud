import { describe, expect, it, vi } from 'vitest';

const drizzleMocks = vi.hoisted(() => ({
  db: undefined as unknown,
  migrate: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(state: unknown, env: unknown) {
      this.ctx = state;
      this.env = env;
    }
  },
}));

vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => drizzleMocks.db),
}));

vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({
  migrate: drizzleMocks.migrate,
}));

import { SessionIngestDO, ingestOrderCursor } from './SessionIngestDO';

describe('SessionIngestDO ingest ordering', () => {
  it('uses ingested_at with id only as a tie-breaker for cursor progression', () => {
    expect(ingestOrderCursor({ ingested_at: 100, id: 7 })).toEqual({ ingestedAt: 100, id: 7 });
    expect(ingestOrderCursor({ ingested_at: null, id: 3 })).toEqual({ ingestedAt: null, id: 3 });
  });

  it('applies same-batch lifecycle markers in payload order', async () => {
    const operations: string[] = [];
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery),
      get: vi.fn(() => undefined),
    };
    const db = {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key?: string; value?: string | null; item_id?: string }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            run: vi.fn(() => {
              if (values.key === 'closeReason') {
                operations.push(`meta:${values.key}:${values.value}`);
              }
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          run: vi.fn(() => operations.push('delete:closeReason')),
        })),
      })),
    };
    drizzleMocks.db = db;

    const state = {
      storage: {
        setAlarm: vi.fn(async () => {
          operations.push('alarm');
        }),
      },
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const env = { SESSION_INGEST_R2: { delete: vi.fn() } } as never;

    const durableObject = new SessionIngestDO(state, env);
    await durableObject.ingest(
      [
        { type: 'session_close', data: { reason: 'completed' } },
        { type: 'session_open', data: {} },
      ],
      'usr_order',
      'ses_order',
      1,
      1
    );

    expect(operations).toEqual([
      'meta:closeReason:completed',
      'alarm',
      'delete:closeReason',
      'alarm',
    ]);
  });

  it('does not overwrite newer metadata after orphaned R2 cleanup yields', async () => {
    const operations: string[] = [];
    const metaValues = new Map<string, string | null>();
    const getResults = [
      undefined,
      undefined,
      undefined,
      undefined,
      { ingested_at: 0, item_data_r2_key: 'items/old' },
      undefined,
    ];
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery),
      get: vi.fn(() => getResults.shift()),
    };
    const db = {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key?: string; value?: string | null; item_id?: string }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            run: vi.fn(() => {
              if (values.key) {
                metaValues.set(values.key, values.value ?? null);
                operations.push(`meta:${values.key}:${values.value}`);
              }
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({ run: vi.fn() })),
      })),
    };
    drizzleMocks.db = db;

    const waitUntilPromises: Promise<unknown>[] = [];
    const state = {
      storage: { setAlarm: vi.fn() },
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        operations.push('waitUntil');
        waitUntilPromises.push(promise);
      }),
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const deleteObject = vi.fn(async () => {
      operations.push('r2Delete');
      // Simulate a newer interleaved ingest updating metadata while stale ingest
      // would have been awaiting R2 cleanup in the old implementation.
      metaValues.set('title', 'Newer');
    });
    const env = {
      SESSION_INGEST_R2: {
        delete: deleteObject,
      },
      NOTIFICATIONS: { sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })) },
    } as never;

    const durableObject = new SessionIngestDO(state, env);
    const result = await durableObject.ingest(
      [{ type: 'session', data: { title: 'Hello' } }],
      'usr_meta',
      'ses_meta',
      1,
      1,
      { session: 'items/new' }
    );
    await Promise.all(waitUntilPromises);

    expect(result).toMatchObject({
      accepted: true,
      changes: [{ name: 'title', value: 'Hello' }],
    });
    expect(deleteObject).toHaveBeenCalledWith(['items/old']);
    expect(operations.indexOf('meta:title:Hello')).toBeLessThan(operations.indexOf('r2Delete'));
    expect(metaValues.get('title')).toBe('Newer');
  });

  it('does not report metadata changes when lifecycle side effects fail', async () => {
    const metaWrites: string[] = [];
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery),
      get: vi.fn(() => undefined),
    };
    const db = {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key?: string; value?: string | null; item_id?: string }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            run: vi.fn(() => {
              if (values.key) {
                metaWrites.push(`${values.key}:${values.value}`);
              }
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({ run: vi.fn() })),
      })),
    };
    drizzleMocks.db = db;

    const state = {
      storage: {
        setAlarm: vi.fn(async () => {
          throw new Error('alarm failed');
        }),
      },
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const env = { SESSION_INGEST_R2: { delete: vi.fn() } } as never;

    const durableObject = new SessionIngestDO(state, env);
    await expect(
      durableObject.ingest(
        [
          { type: 'session', data: { title: 'Hello' } },
          { type: 'session_close', data: { reason: 'completed' } },
        ],
        'usr_meta',
        'ses_meta',
        1,
        1
      )
    ).rejects.toThrow('alarm failed');

    expect(metaWrites).toContain('closeReason:completed');
    expect(metaWrites).not.toContain('title:Hello');
  });
});

describe('SessionIngestDO session-ready push', () => {
  // Stateful db mock: meta rows and item rows persist across ingest() calls so
  // once-only semantics (`sessionReadyNotified`) behave like real SQLite.
  function makeHarness() {
    const rows = new Map<string, Record<string, unknown>>();

    // eq(column, value) embeds the bound value as a Param chunk; that value is
    // the meta key or item_id being queried.
    const extractConditionKey = (condition: unknown): string | undefined => {
      const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
      for (const chunk of chunks) {
        const value = (chunk as { value?: unknown } | null)?.value;
        if (typeof value === 'string') return value;
      }
      return undefined;
    };

    let queriedKey: string | undefined;
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn((condition: unknown) => {
        queriedKey = extractConditionKey(condition);
        return selectQuery;
      }),
      get: vi.fn(() => (queriedKey === undefined ? undefined : rows.get(queriedKey))),
    };
    const db = {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key?: string; value?: string | null; item_id?: string }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            run: vi.fn(() => {
              if (values.key !== undefined) {
                rows.set(values.key, { value: values.value ?? null });
              } else if (values.item_id !== undefined) {
                rows.set(values.item_id, values);
              }
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
    };
    drizzleMocks.db = db;

    const waitUntilPromises: Promise<unknown>[] = [];
    const state = {
      storage: { setAlarm: vi.fn() },
      waitUntil: vi.fn((promise: Promise<unknown>) => waitUntilPromises.push(promise)),
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const sendSessionReadyNotification = vi.fn(async () => ({ dispatched: true }));
    const env = {
      SESSION_INGEST_R2: { delete: vi.fn() },
      NOTIFICATIONS: { sendSessionReadyNotification },
    } as never;

    return {
      durableObject: new SessionIngestDO(state, env),
      sendSessionReadyNotification,
      rows,
      settle: () => Promise.all(waitUntilPromises),
    };
  }

  it('pushes on first claim and never again', async () => {
    const { durableObject, sendSessionReadyNotification, settle } = makeHarness();

    durableObject.claimSessionReadyPush('usr_push', 'ses_push', 'My title');
    await settle();

    expect(sendSessionReadyNotification).toHaveBeenCalledTimes(1);
    expect(sendSessionReadyNotification).toHaveBeenCalledWith({
      userId: 'usr_push',
      cliSessionId: 'ses_push',
      title: 'My title',
    });

    // Re-claims (CLI reconnect, UserConnectionDO eviction) must not re-push.
    durableObject.claimSessionReadyPush('usr_push', 'ses_push', 'My title');
    await settle();

    expect(sendSessionReadyNotification).toHaveBeenCalledTimes(1);
  });

  it('forwards an undefined title when none is supplied', async () => {
    const { durableObject, sendSessionReadyNotification, settle } = makeHarness();

    durableObject.claimSessionReadyPush('usr_push', 'ses_push');
    await settle();

    expect(sendSessionReadyNotification).toHaveBeenCalledTimes(1);
    expect(sendSessionReadyNotification).toHaveBeenCalledWith({
      userId: 'usr_push',
      cliSessionId: 'ses_push',
      title: undefined,
    });
  });

  it('never pushes for a deleted session', async () => {
    const { durableObject, sendSessionReadyNotification, rows, settle } = makeHarness();
    rows.set('deleted', { value: 'true' });

    durableObject.claimSessionReadyPush('usr_push', 'ses_gone');
    await settle();

    expect(sendSessionReadyNotification).not.toHaveBeenCalled();
  });

  it('reports a deleted ingest and cleans up caller R2 references', async () => {
    const { durableObject, rows } = makeHarness();
    rows.set('deleted', { value: 'true' });
    const deleteObject = vi.mocked(
      (
        durableObject as unknown as {
          env: { SESSION_INGEST_R2: { delete: ReturnType<typeof vi.fn> } };
        }
      ).env.SESSION_INGEST_R2.delete
    );

    const result = await durableObject.ingest(
      [{ type: 'message', data: { id: 'msg_deleted' } }],
      'usr_deleted',
      'ses_deleted',
      1,
      1,
      { 'message/msg_deleted': 'items/deleted' }
    );

    expect(result).toEqual({ accepted: false, reason: 'deleted', changes: [] });
    expect(deleteObject).toHaveBeenCalledWith(['items/deleted']);
  });

  it('does not push from ingest, even for a parentless session record', async () => {
    const { durableObject, sendSessionReadyNotification, settle } = makeHarness();

    await durableObject.ingest(
      [
        { type: 'kilo_meta', data: { platform: 'cli' } },
        { type: 'session', data: { title: 'Main' } },
      ],
      'usr_push',
      'ses_main',
      1,
      1
    );
    await settle();

    expect(sendSessionReadyNotification).not.toHaveBeenCalled();
  });
});
