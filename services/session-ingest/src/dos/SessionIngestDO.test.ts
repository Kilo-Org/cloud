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

    let persistedSet: Record<string, unknown> | undefined;
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
          operations.push('persist:live_session_columns');
          return Promise.resolve(undefined).then(onFulfilled, onRejected);
        },
      };
    });
    const pgSet = vi.fn((set: Record<string, unknown>) => {
      persistedSet = set;
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
      get persistedSet() {
        return persistedSet;
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

  it('persists total_cost_microdollars via persistLiveSessionColumns before O11Y when O11Y rejects', async () => {
    const o11yError = new Error('o11y unavailable');
    const harness = makeAlarmHarness({
      totalCostDollars: 0.15,
      o11yImpl: async () => {
        throw o11yError;
      },
    });

    await expect(harness.durableObject.alarm()).rejects.toThrow('o11y unavailable');

    expect(harness.getWorkerDb).toHaveBeenCalledWith('postgres://test');
    expect(harness.pgSet).toHaveBeenCalledTimes(1);
    const setArg = harness.persistedSet!;
    // Close path: cost only (no last_activity_at).
    expect(setArg).toHaveProperty('total_cost_microdollars');
    expect(setArg).not.toHaveProperty('last_activity_at');
    // CASE guard binds the cost value; SQL shape asserted via stringified chunks.
    const costSql = sqlFragmentText(setArg.total_cost_microdollars);
    expect(costSql).toMatch(/CASE/i);
    expect(costSql).toContain('150000');
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
    const persistIdx = harness.operations.indexOf('persist:live_session_columns');
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

/** Walk nested drizzle queryChunks and collect bound Param values (string | number). */
function collectBoundParams(
  condition: unknown,
  out: Array<string | number> = []
): Array<string | number> {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  for (const chunk of chunks) {
    if (chunk == null || typeof chunk !== 'object') continue;
    const value = (chunk as { value?: unknown }).value;
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(value);
      continue;
    }
    if ('queryChunks' in (chunk as object)) {
      collectBoundParams(chunk, out);
    }
  }
  return out;
}

/** Flatten drizzle SQL fragment chunks to a debug string (literals + bound params). */
function sqlFragmentText(fragment: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (node == null || depth > 12) return;
    if (typeof node === 'string') {
      parts.push(node);
      return;
    }
    if (typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (typeof node !== 'object') return;
    const value = (node as { value?: unknown }).value;
    // StringChunk: value is string[]; Param: value is scalar; nested SQL: queryChunks
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
    } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      parts.push(...(value as string[]));
    }
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const c of chunks) walk(c, depth + 1);
    }
  };
  walk(fragment);
  return parts.join(' ');
}

function sqlContainsCase(sqlFragment: unknown): boolean {
  return /CASE/i.test(sqlFragmentText(sqlFragment));
}

describe('SessionIngestDO live activity + cost persist', () => {
  type LiveHarnessOptions = {
    /** Pre-seeded ingest_meta rows (throttle state, prior status, etc.). */
    seedMeta?: Record<string, string | null>;
    /** Pre-seeded message item rows returned by cost SELECT .all(). */
    seedMessageRows?: Array<{ item_data: string }>;
    /** If set, Postgres update rejects with this error. */
    persistError?: Error;
  };

  function makeLiveHarness(options: LiveHarnessOptions = {}) {
    const meta = new Map<string, string | null>(Object.entries(options.seedMeta ?? {}));
    const messageRows = options.seedMessageRows ?? [];
    // item rows keyed by item_id for stale-guard lookups during ingest loop
    const itemRows = new Map<
      string,
      { ingested_at: number | null; item_data_r2_key: string | null }
    >();

    type SelectKind = 'meta_get' | 'item_guard' | 'message_cost' | 'other';
    let selectKind: SelectKind = 'other';
    let eqKey: string | undefined;

    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn((condition: unknown) => {
        const params = collectBoundParams(condition);
        eqKey = params.find((p): p is string => typeof p === 'string');
        return selectQuery;
      }),
      orderBy: vi.fn(() => selectQuery),
      limit: vi.fn(() => selectQuery),
      get: vi.fn(() => {
        if (selectKind === 'item_guard' && eqKey !== undefined) {
          return itemRows.get(eqKey);
        }
        if (eqKey !== undefined && meta.has(eqKey)) {
          return { value: meta.get(eqKey) };
        }
        // hasIngestMeta: presence check — undefined means missing
        if (eqKey !== undefined) {
          return meta.has(eqKey) ? { value: meta.get(eqKey) } : undefined;
        }
        return undefined;
      }),
      all: vi.fn(() => {
        if (selectKind === 'message_cost') return messageRows;
        return [];
      }),
    };

    const db = {
      select: vi.fn((columns?: unknown) => {
        const cols = columns as Record<string, unknown> | undefined;
        if (cols && 'item_data' in cols && !('item_type' in cols) && !('value' in cols)) {
          // Cost compute: select({ item_data }) ... all()
          // OR item guard: select({ ingested_at, item_data_r2_key }) — has ingested_at
          if ('ingested_at' in cols) {
            selectKind = 'item_guard';
          } else {
            selectKind = 'message_cost';
          }
        } else if (cols && 'value' in cols) {
          selectKind = 'meta_get';
        } else if (cols && 'ingested_at' in cols) {
          selectKind = 'item_guard';
        } else {
          selectKind = 'other';
        }
        return selectQuery;
      }),
      insert: vi.fn(() => ({
        values: vi.fn(
          (values: {
            key?: string;
            value?: string | null;
            item_id?: string;
            item_type?: string;
            item_data?: string;
            item_data_r2_key?: string | null;
            ingested_at?: number | null;
          }) => ({
            onConflictDoUpdate: vi.fn(() => ({
              run: vi.fn(() => {
                if (values.key !== undefined) {
                  meta.set(values.key, values.value ?? null);
                } else if (values.item_id !== undefined) {
                  itemRows.set(values.item_id, {
                    ingested_at: values.ingested_at ?? null,
                    item_data_r2_key: values.item_data_r2_key ?? null,
                  });
                  if (values.item_type === 'message' && values.item_data) {
                    messageRows.push({ item_data: values.item_data });
                  }
                }
              }),
            })),
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(() => ({
                get: vi.fn(() => ({ state: 'pending' })),
              })),
            })),
          })
        ),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
    };
    drizzleMocks.db = db;

    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    const state = {
      storage: { setAlarm: vi.fn() },
      waitUntil,
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;

    let lastPgSet: Record<string, unknown> | undefined;
    let pgCallCount = 0;
    const pgWhere = vi.fn((_condition: unknown) => {
      return {
        then(
          onFulfilled?: ((value: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null
        ) {
          pgCallCount += 1;
          if (options.persistError) {
            return Promise.reject(options.persistError).then(onFulfilled, onRejected);
          }
          return Promise.resolve(undefined).then(onFulfilled, onRejected);
        },
      };
    });
    const pgSet = vi.fn((set: Record<string, unknown>) => {
      lastPgSet = set;
      return { where: pgWhere };
    });
    const pgUpdate = vi.fn(() => ({ set: pgSet }));
    dbClientMocks.getWorkerDb.mockReset();
    dbClientMocks.getWorkerDb.mockReturnValue({ update: pgUpdate });

    const env = {
      SESSION_INGEST_R2: { delete: vi.fn() },
      HYPERDRIVE: { connectionString: 'postgres://test' },
      NOTIFICATIONS: { sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })) },
    } as never;

    return {
      durableObject: new SessionIngestDO(state, env),
      meta,
      itemRows,
      messageRows,
      waitUntil,
      settle: () => Promise.all(waitUntilPromises),
      get lastPgSet() {
        return lastPgSet;
      },
      get pgCallCount() {
        return pgCallCount;
      },
      pgSet,
      pgWhere,
      getWorkerDb: dbClientMocks.getWorkerDb,
    };
  }

  function assistantItem(id: string, cost: number) {
    return {
      type: 'message' as const,
      data: {
        id,
        role: 'assistant',
        time: { created: 1000 },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost,
      },
    };
  }

  it('persists activity + cost on first assistant message batch', async () => {
    const harness = makeLiveHarness();
    const ingestedAt = 1_700_000_000_000;

    await harness.durableObject.ingest(
      [assistantItem('m1', 0.15)],
      'usr_live',
      'ses_live',
      1,
      ingestedAt
    );
    await harness.settle();

    expect(harness.pgCallCount).toBe(1);
    expect(harness.lastPgSet).toBeDefined();
    const set = harness.lastPgSet!;
    expect(set).toHaveProperty('total_cost_microdollars');
    expect(set).toHaveProperty('last_activity_at');
    expect(sqlContainsCase(set.total_cost_microdollars)).toBe(true);
    expect(sqlContainsCase(set.last_activity_at)).toBe(true);
    expect(sqlFragmentText(set.total_cost_microdollars)).toContain('150000');
    const activityIso = new Date(ingestedAt).toISOString();
    expect(sqlFragmentText(set.last_activity_at)).toContain(activityIso);
    // Meta advanced only after successful write
    expect(harness.meta.get('lastActivityPersistedValueMs')).toBe(String(ingestedAt));
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBe('150000');
  });

  it('does not persist activity for session_open / session_close / metadata-only batches', async () => {
    const harness = makeLiveHarness();
    await harness.durableObject.ingest(
      [
        { type: 'session_open', data: {} },
        { type: 'session_close', data: { reason: 'completed' } },
        { type: 'session', data: { title: 'T' } },
        { type: 'kilo_meta', data: { platform: 'cli' } },
      ],
      'usr_live',
      'ses_live',
      1,
      1000
    );
    await harness.settle();
    expect(harness.pgCallCount).toBe(0);
  });

  it('does not persist when message is stale-skipped by ingested_at guard', async () => {
    const harness = makeLiveHarness();
    harness.itemRows.set('message/m1', {
      ingested_at: 5000,
      item_data_r2_key: null,
    });

    await harness.durableObject.ingest(
      [assistantItem('m1', 0.15)],
      'usr_live',
      'ses_live',
      1,
      1000 // older than existing 5000 → stale skip
    );
    await harness.settle();
    expect(harness.pgCallCount).toBe(0);
  });

  it('idle-only batch after prior assistant messages persists cost (D17)', async () => {
    const priorCost = JSON.stringify({
      role: 'assistant',
      time: { created: 1000 },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.25,
    });
    const harness = makeLiveHarness({
      seedMeta: {
        status: 'busy',
        lastCostPersistedMicrodollars: '100000',
        lastCostPersistedAtMs: String(Date.now()), // within 30s — idle forces anyway
      },
      seedMessageRows: [{ item_data: priorCost }],
    });

    await harness.durableObject.ingest(
      [{ type: 'session_status', data: { status: 'idle' } }],
      'usr_live',
      'ses_live',
      1,
      Date.now()
    );
    await harness.settle();

    expect(harness.pgCallCount).toBe(1);
    const set = harness.lastPgSet!;
    expect(set).toHaveProperty('total_cost_microdollars');
    expect(set).not.toHaveProperty('last_activity_at'); // no message/part upsert
    expect(sqlFragmentText(set.total_cost_microdollars)).toContain('250000');
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBe('250000');
  });

  it('terminalized-without-idle batch does not live-persist cost', async () => {
    // session_close is lifecycle only — no idle status change, no message upsert
    const harness = makeLiveHarness({
      seedMessageRows: [
        {
          item_data: JSON.stringify({
            role: 'assistant',
            time: { created: 1000 },
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            cost: 0.5,
          }),
        },
      ],
    });

    await harness.durableObject.ingest(
      [{ type: 'session_close', data: { reason: 'completed' } }],
      'usr_live',
      'ses_live',
      1,
      Date.now()
    );
    await harness.settle();
    expect(harness.pgCallCount).toBe(0);
  });

  it('swallows persist failure and leaves meta un-advanced for retry', async () => {
    const harness = makeLiveHarness({
      persistError: new Error('postgres down'),
    });
    const ingestedAt = 1_700_000_000_100;

    await harness.durableObject.ingest(
      [assistantItem('m1', 0.1)],
      'usr_live',
      'ses_live',
      1,
      ingestedAt
    );
    await harness.settle();

    expect(harness.pgCallCount).toBe(1);
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBeUndefined();
    expect(harness.meta.get('lastActivityPersistedValueMs')).toBeUndefined();
  });

  it('one persist call per batch carries exactly the fired columns', async () => {
    const harness = makeLiveHarness();
    await harness.durableObject.ingest(
      [
        {
          type: 'part',
          data: {
            id: 'p1',
            messageID: 'm1',
            type: 'text',
            text: 'hi',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      2_000
    );
    await harness.settle();

    // part → activity only, no cost compute
    expect(harness.pgCallCount).toBe(1);
    expect(harness.waitUntil).toHaveBeenCalledTimes(1);
    const set = harness.lastPgSet!;
    expect(set).toHaveProperty('last_activity_at');
    expect(set).not.toHaveProperty('total_cost_microdollars');
    expect(sqlFragmentText(set.last_activity_at)).toContain(new Date(2000).toISOString());
  });
});
