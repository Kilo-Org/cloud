import { describe, expect, it, vi } from 'vitest';

const drizzleMocks = vi.hoisted(() => ({
  db: undefined as unknown,
  migrate: vi.fn(),
}));

const dbClientMocks = vi.hoisted(() => ({
  getWorkerDb: vi.fn(),
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

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: dbClientMocks.getWorkerDb,
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

describe('SessionIngestDO emitSessionMetrics cost persist ordering', () => {
  /**
   * Pins: Postgres total_cost_microdollars persist runs before the unguarded
   * O11Y.ingestSessionMetrics RPC. An O11Y rejection must not skip the persist.
   */
  function makeAlarmHarness(options: { totalCostDollars: number; o11yImpl: () => Promise<void> }) {
    const operations: string[] = [];
    const meta = new Map<string, string | null>([
      ['kiloUserId', 'usr_cost'],
      ['sessionId', 'ses_cost'],
      ['closeReason', 'completed'],
      ['ingestVersion', '3'],
    ]);

    const itemData = JSON.stringify({
      role: 'assistant',
      time: { created: 1000 },
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: options.totalCostDollars,
    });
    const ingestItemRows = [{ item_type: 'message', item_data: itemData }];

    type EqCondition = { queryChunks?: unknown[] };
    /** Walk nested drizzle queryChunks (eq / and) and collect string Param values. */
    const collectBoundStringParams = (condition: unknown, out: string[] = []): string[] => {
      const chunks = (condition as EqCondition | undefined)?.queryChunks ?? [];
      for (const chunk of chunks) {
        if (chunk == null || typeof chunk !== 'object') continue;
        const value = (chunk as { value?: unknown }).value;
        if (typeof value === 'string') {
          out.push(value);
          continue;
        }
        // Nested SQL (e.g. and(eq(...), eq(...))) embeds child conditions as chunks.
        if ('queryChunks' in (chunk as object)) {
          collectBoundStringParams(chunk, out);
        }
      }
      return out;
    };
    const extractEqValue = (condition: unknown): string | undefined => {
      return collectBoundStringParams(condition)[0];
    };

    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn((condition: unknown) => {
        // Stash eq-bound key for .get(); .all() paths ignore it.
        (selectQuery as { _key?: string })._key = extractEqValue(condition);
        return selectQuery;
      }),
      orderBy: vi.fn(() => selectQuery),
      get: vi.fn(() => {
        const key = (selectQuery as { _key?: string })._key;
        if (key === 'metricsEmitted') {
          const value = meta.get('metricsEmitted');
          return value === undefined ? undefined : { value };
        }
        if (key === 'model') {
          return undefined;
        }
        // alarm() loads meta via select().from().where(inArray(...)).all()
        // — handled by all() below. get() for other keys:
        if (key !== undefined && meta.has(key)) {
          return { value: meta.get(key) };
        }
        return undefined;
      }),
      all: vi.fn(() => {
        // alarm meta load: returns rows with key/value
        // emitSessionMetrics item load: returns item_type/item_data rows
        // Distinguish by whether the last where bound a single eq key used for items.
        // Simpler: track call site via select columns shape.
        return (selectQuery as { _allKind?: 'meta' | 'items' })._allKind === 'items'
          ? ingestItemRows
          : [...meta.entries()].map(([key, value]) => ({ key, value }));
      }),
    };

    const originalSelect = vi.fn((columns?: unknown) => {
      if (
        columns &&
        typeof columns === 'object' &&
        'item_type' in (columns as Record<string, unknown>)
      ) {
        (selectQuery as { _allKind?: 'meta' | 'items' })._allKind = 'items';
      } else if (
        columns &&
        typeof columns === 'object' &&
        'item_data' in (columns as Record<string, unknown>) &&
        !('item_type' in (columns as Record<string, unknown>))
      ) {
        // model lookup: select({ item_data }).from().where(eq item_id 'model').get()
        (selectQuery as { _allKind?: 'meta' | 'items' })._allKind = undefined;
      } else if (
        columns &&
        typeof columns === 'object' &&
        'value' in (columns as Record<string, unknown>)
      ) {
        // metricsEmitted check
        (selectQuery as { _allKind?: 'meta' | 'items' })._allKind = undefined;
      } else {
        // bare select() for alarm meta
        (selectQuery as { _allKind?: 'meta' | 'items' })._allKind = 'meta';
      }
      return selectQuery;
    });

    const db = {
      select: originalSelect,
      insert: vi.fn(() => ({
        values: vi.fn((values: { key?: string; value?: string | null }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            run: vi.fn(() => {
              if (values.key !== undefined) {
                meta.set(values.key, values.value ?? null);
                operations.push(`meta:${values.key}:${values.value}`);
              }
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
    };
    drizzleMocks.db = db;

    let persistedMicrodollars: number | undefined;
    let pgWhereCondition: unknown;
    let pgWhereBoundParams: string[] = [];
    /**
     * Record persist only when the drizzle chain is AWAITED (via .then), not when
     * .where() is merely invoked. A build-now-await-later refactor must fail this test.
     */
    const pgWhere = vi.fn((condition: unknown) => {
      pgWhereCondition = condition;
      pgWhereBoundParams = collectBoundStringParams(condition);
      return {
        then(
          onFulfilled?: ((value: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null
        ) {
          operations.push('persist:total_cost_microdollars');
          return Promise.resolve(undefined).then(onFulfilled, onRejected);
        },
      };
    });
    const pgSet = vi.fn((set: { total_cost_microdollars?: number }) => {
      persistedMicrodollars = set.total_cost_microdollars;
      return { where: pgWhere };
    });
    const pgUpdate = vi.fn(() => ({ set: pgSet }));
    dbClientMocks.getWorkerDb.mockReset();
    dbClientMocks.getWorkerDb.mockReturnValue({ update: pgUpdate });

    const ingestSessionMetrics = vi.fn(async () => {
      operations.push('o11y:ingestSessionMetrics');
      return options.o11yImpl();
    });

    const deleteAlarm = vi.fn(async () => {
      operations.push('deleteAlarm');
    });
    const state = {
      storage: { setAlarm: vi.fn(), deleteAlarm },
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;

    const env = {
      SESSION_INGEST_R2: { delete: vi.fn() },
      HYPERDRIVE: { connectionString: 'postgres://test' },
      O11Y: { ingestSessionMetrics },
    } as never;

    return {
      durableObject: new SessionIngestDO(state, env),
      operations,
      ingestSessionMetrics,
      pgSet,
      pgWhere,
      getWorkerDb: dbClientMocks.getWorkerDb,
      get persistedMicrodollars() {
        return persistedMicrodollars;
      },
      get pgWhereCondition() {
        return pgWhereCondition;
      },
      get pgWhereBoundParams() {
        return pgWhereBoundParams;
      },
      meta,
      deleteAlarm,
    };
  }

  it('persists total_cost_microdollars before O11Y when O11Y rejects', async () => {
    const o11yError = new Error('o11y unavailable');
    const harness = makeAlarmHarness({
      totalCostDollars: 0.15,
      o11yImpl: async () => {
        throw o11yError;
      },
    });

    await expect(harness.durableObject.alarm()).rejects.toThrow('o11y unavailable');

    expect(harness.getWorkerDb).toHaveBeenCalledWith('postgres://test');
    expect(harness.pgSet).toHaveBeenCalledWith({ total_cost_microdollars: 150_000 });
    expect(harness.persistedMicrodollars).toBe(150_000);
    expect(harness.pgWhere).toHaveBeenCalledTimes(1);
    // where() must bind both session_id and kilo_user_id (and(...) nests eq chunks).
    expect(harness.pgWhereBoundParams).toEqual(expect.arrayContaining(['ses_cost', 'usr_cost']));
    expect(harness.ingestSessionMetrics).toHaveBeenCalledTimes(1);
    expect(harness.ingestSessionMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        kiloUserId: 'usr_cost',
        sessionId: 'ses_cost',
        ingestVersion: 3,
        totalCost: 0.15,
        terminationReason: 'completed',
      })
    );

    // Ordering: persist must precede the unguarded O11Y RPC.
    const persistIdx = harness.operations.indexOf('persist:total_cost_microdollars');
    const o11yIdx = harness.operations.indexOf('o11y:ingestSessionMetrics');
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(o11yIdx).toBeGreaterThanOrEqual(0);
    expect(persistIdx).toBeLessThan(o11yIdx);

    // Rejection propagates out of alarm(); metricsEmitted must not be marked.
    expect(harness.operations).not.toContain('meta:metricsEmitted:true');
    expect(harness.operations).not.toContain('deleteAlarm');
    expect(harness.meta.get('metricsEmitted')).toBeUndefined();
  });
});
