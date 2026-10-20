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
import { ingestItems, ingestMeta } from '../db/sqlite-schema';
import type { agent_briefing_events } from '@kilocode/db/schema';

function makeEvidenceLedger(options: { gate?: Promise<void>; error?: Error } = {}) {
  type Event = typeof agent_briefing_events.$inferInsert;
  const events = new Map<string, Event>();
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(() => ({ limit: vi.fn(async () => [{ organizationId: null }]) })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((rows: Event[]) => ({
        onConflictDoNothing: vi.fn(async () => {
          for (const row of rows) if (!events.has(row.id)) events.set(row.id, row);
        }),
      })),
    })),
  };
  let error = options.error;
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    await options.gate;
    if (error) throw error;
    return fn(tx);
  });
  return {
    events,
    transaction,
    setError: (next: Error | undefined) => {
      error = next;
    },
  };
}

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

  it('reports the whole PR-link tuple, including head evidence, atomically', async () => {
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery),
      get: vi.fn(() => undefined),
    };
    const db = {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({ run: vi.fn() })),
        })),
      })),
      delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
    };
    drizzleMocks.db = db;

    const state = {
      storage: { setAlarm: vi.fn() },
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const env = { SESSION_INGEST_R2: { delete: vi.fn() } } as never;

    const durableObject = new SessionIngestDO(state, env);
    const result = await durableObject.ingest(
      [
        {
          type: 'session_pr_link',
          data: {
            platform: 'github',
            prUrl: 'https://github.com/acme/widgets/pull/42',
            prNumber: 42,
            headRef: 'fix/typo',
            headSha: 'abc123',
          },
        },
      ],
      'usr_pr',
      'ses_pr',
      1,
      1
    );

    expect(result).toMatchObject({
      accepted: true,
      changes: [
        { name: 'prPlatform', value: 'github' },
        { name: 'prUrl', value: 'https://github.com/acme/widgets/pull/42' },
        { name: 'prNumber', value: '42' },
        { name: 'prHeadRef', value: 'fix/typo' },
        { name: 'prHeadSha', value: 'abc123' },
      ],
    });
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
  const chunks = Array.isArray(condition)
    ? condition
    : ((condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? []);
  for (const chunk of chunks) {
    if (Array.isArray(chunk)) {
      collectBoundParams(chunk, out);
      continue;
    }
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
    evidenceGate?: Promise<void>;
    evidenceError?: Error;
  };

  function makeLiveHarness(options: LiveHarnessOptions = {}) {
    const meta = new Map<string, string | null>(Object.entries(options.seedMeta ?? {}));
    const messageRows = options.seedMessageRows ?? [];
    // item rows keyed by item_id for stale-guard lookups during ingest loop
    const itemRows = new Map<
      string,
      { ingested_at: number | null; item_data_r2_key: string | null }
    >();
    let costScanCount = 0;

    type SelectKind =
      | 'meta_get'
      | 'item_guard'
      | 'message_cost'
      | 'metrics_items'
      | 'briefing_outbox'
      | 'other';
    let selectKind: SelectKind = 'other';
    let eqKey: string | undefined;
    let boundKeys: string[] = [];

    const selectQuery = {
      from: vi.fn((table: unknown) => {
        if (table === ingestMeta && selectKind === 'other') selectKind = 'briefing_outbox';
        return selectQuery;
      }),
      where: vi.fn((condition: unknown) => {
        const params = collectBoundParams(condition);
        eqKey = params.find((p): p is string => typeof p === 'string');
        boundKeys = params.filter((p): p is string => typeof p === 'string');
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
        if (selectKind === 'briefing_outbox') {
          // alarm() loads named keys via inArray; the outbox scan binds no key.
          if (boundKeys.length > 0) {
            return boundKeys
              .filter(key => meta.has(key))
              .map(key => ({ key, value: meta.get(key) ?? null }));
          }
          return [...meta]
            .filter(([key]) => key.startsWith('briefingEvidence:'))
            .map(([key, value]) => ({ key, value }));
        }
        if (selectKind === 'metrics_items') {
          return messageRows.map(row => ({ item_type: 'message', item_data: row.item_data }));
        }
        if (selectKind === 'message_cost') {
          costScanCount += 1;
          return messageRows;
        }
        return [];
      }),
    };

    const db = {
      select: vi.fn((columns?: unknown) => {
        const cols = columns as Record<string, unknown> | undefined;
        boundKeys = [];
        if (cols && 'item_type' in cols && !('item_id' in cols)) {
          selectKind = 'metrics_items';
        } else if (cols && 'item_data' in cols && !('item_type' in cols) && !('value' in cols)) {
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
              run: vi.fn(() => {
                if (values.key !== undefined && !meta.has(values.key))
                  meta.set(values.key, values.value ?? null);
              }),
              returning: vi.fn(() => ({
                get: vi.fn(() => ({ state: 'pending' })),
              })),
            })),
          })
        ),
      })),
      delete: vi.fn(() => ({
        where: vi.fn((condition: unknown) => ({
          run: vi.fn(() => {
            for (const key of collectBoundParams(condition))
              if (typeof key === 'string') meta.delete(key);
          }),
        })),
      })),
    };
    drizzleMocks.db = db;

    const waitUntilPromises: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    let alarmAt: number | null = null;
    const storage = {
      setAlarm: vi.fn(async (at: number) => {
        alarmAt = at;
      }),
      getAlarm: vi.fn(async () => alarmAt),
      deleteAlarm: vi.fn(async () => {
        alarmAt = null;
      }),
    };
    const state = {
      storage,
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
    const evidenceLedger = makeEvidenceLedger({
      gate: options.evidenceGate,
      error: options.evidenceError,
    });
    dbClientMocks.getWorkerDb.mockReturnValue({
      update: pgUpdate,
      transaction: evidenceLedger.transaction,
    });

    const ingestSessionMetrics = vi.fn(async () => undefined);
    const env = {
      SESSION_INGEST_R2: { delete: vi.fn() },
      HYPERDRIVE: { connectionString: 'postgres://test' },
      NOTIFICATIONS: { sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })) },
      O11Y: { ingestSessionMetrics },
    } as never;

    return {
      durableObject: new SessionIngestDO(state, env),
      meta,
      itemRows,
      messageRows,
      waitUntil,
      evidenceLedger,
      ingestSessionMetrics,
      storage,
      get alarmAt() {
        return alarmAt;
      },
      settle: () => Promise.all(waitUntilPromises),
      get lastPgSet() {
        return lastPgSet;
      },
      get pgCallCount() {
        return pgCallCount;
      },
      get costScanCount() {
        return costScanCount;
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

  function userItem(id: string) {
    return {
      type: 'message' as const,
      data: {
        id,
        role: 'user',
        time: { created: 1000 },
      },
    };
  }

  function toolPart(id: string, status: 'running' | 'completed', filePath: string) {
    return {
      type: 'part' as const,
      data: {
        id,
        messageID: 'm1',
        type: 'tool',
        tool: 'edit',
        state: { status, input: { filePath } },
      },
    };
  }

  it('commits newer status and returns both metadata deliveries while an older evidence flush is blocked', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const harness = makeLiveHarness({ evidenceGate: gate });
    const older = await harness.durableObject.ingest(
      [
        assistantItem('historical', 0.1),
        {
          type: 'session_status',
          data: { status: 'busy', occurredAt: '2026-07-24T07:58:00.000Z' },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      10_000
    );
    expect(harness.meta.get('status')).toBe('busy');
    const newer = await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: { status: 'idle', occurredAt: '2026-07-24T07:59:00.000Z' },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    expect(older.changes).toEqual(expect.arrayContaining([{ name: 'status', value: 'busy' }]));
    expect(newer.changes).toEqual(expect.arrayContaining([{ name: 'status', value: 'idle' }]));
    expect(harness.meta.get('status')).toBe('idle');
    expect(harness.meta.get('statusOccurredAt')).toBe('2026-07-24T07:59:00.000Z');
    release();
    await harness.settle();
    expect(harness.meta.get('status')).toBe('idle');
    expect(harness.evidenceLedger.events.size).toBe(3);
  });

  it('retains the durable evidence outbox without dropping metadata on evidence failure', async () => {
    const harness = makeLiveHarness({ evidenceError: new Error('evidence unavailable') });
    const result = await harness.durableObject.ingest(
      [
        assistantItem('failure', 0.1),
        {
          type: 'session_status',
          data: { status: 'question', occurredAt: '2026-07-24T07:59:00.000Z' },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      10_000
    );
    await harness.settle();
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { name: 'status', value: 'question' },
        { name: 'statusOccurredAt', value: '2026-07-24T07:59:00.000Z' },
      ])
    );
    expect(
      [...harness.meta.keys()].filter(key => key.startsWith('briefingEvidence:'))
    ).toHaveLength(2);
    expect(harness.evidenceLedger.events.size).toBe(0);
  });

  it('stores each historical activity once across replay and clears acknowledged outbox records', async () => {
    const harness = makeLiveHarness();
    await harness.durableObject.ingest(
      [assistantItem('replay', 0.1)],
      'usr_live',
      'ses_live',
      1,
      10_000
    );
    await harness.settle();
    await harness.durableObject.ingest(
      [assistantItem('replay', 0.1)],
      'usr_live',
      'ses_live',
      1,
      10_000
    );
    await harness.settle();
    expect(harness.evidenceLedger.events.size).toBe(1);
    expect(
      [...harness.meta.keys()].filter(key => key.startsWith('briefingEvidence:'))
    ).toHaveLength(0);
  });

  it('does not reuse a prior producer timestamp for a legacy status transition', async () => {
    const harness = makeLiveHarness({
      seedMeta: {
        status: 'busy',
        statusOccurredAt: '2026-07-24T07:59:00.000Z',
      },
    });
    const result = await harness.durableObject.ingest(
      [{ type: 'session_status', data: { status: 'question' } }],
      'usr_live',
      'ses_live',
      1,
      10_000
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { name: 'status', value: 'question' },
        { name: 'statusOccurredAt', value: null },
      ])
    );
    await harness.settle();
  });
  it('delivers delayed historical status without regressing current local or live state', async () => {
    const harness = makeLiveHarness({
      seedMeta: {
        status: 'idle',
        statusOccurredAt: '2026-07-24T08:05:00.000Z',
      },
    });
    const result = await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: { status: 'question', occurredAt: '2026-07-24T07:59:00.000Z' },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    expect(harness.meta.get('status')).toBe('idle');
    expect(harness.meta.get('statusOccurredAt')).toBe('2026-07-24T08:05:00.000Z');
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { name: 'status', value: 'question' },
        { name: 'statusOccurredAt', value: '2026-07-24T07:59:00.000Z' },
      ])
    );
    if (result.accepted) expect(result.attentionSignals).toEqual([]);
    await harness.settle();
    expect(harness.pgCallCount).toBe(0);
  });
  it('delivers source time when an identical untimestamped snapshot was already committed', async () => {
    const harness = makeLiveHarness({ seedMeta: { status: 'question' } });
    const result = await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: {
            status: 'question',
            previousStatus: 'busy',
            occurredAt: '2026-07-24T07:59:00.000Z',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { name: 'status', value: 'question' },
        { name: 'statusOccurredAt', value: '2026-07-24T07:59:00.000Z' },
      ])
    );
    if (result.accepted) expect(result.attentionSignals).toEqual([]);
    await harness.settle();
    expect([...harness.evidenceLedger.events.values()]).toEqual([
      expect.objectContaining({
        kind: 'status',
        status: 'question',
        occurred_at: '2026-07-24T07:59:00.000Z',
        payload: { previousStatus: 'busy', previousStatusKnown: true },
      }),
    ]);
  });
  it('retains every originating transition in one batch rather than only its final projected status', async () => {
    const harness = makeLiveHarness();
    await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: { status: 'busy', previousStatus: 'idle', occurredAt: '2026-07-24T07:58:00.000Z' },
        },
        {
          type: 'session_status',
          data: {
            status: 'question',
            previousStatus: 'busy',
            occurredAt: '2026-07-24T07:59:00.000Z',
          },
        },
        {
          type: 'session_status',
          data: {
            status: 'busy',
            previousStatus: 'question',
            occurredAt: '2026-07-24T08:01:00.000Z',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    await harness.settle();
    expect(harness.meta.get('status')).toBe('busy');
    const statuses = [...harness.evidenceLedger.events.values()];
    expect(statuses).toHaveLength(3);
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'question',
          occurred_at: '2026-07-24T07:59:00.000Z',
          payload: { previousStatus: 'busy', previousStatusKnown: true },
        }),
        expect.objectContaining({
          status: 'busy',
          occurred_at: '2026-07-24T08:01:00.000Z',
          payload: { previousStatus: 'question', previousStatusKnown: true },
        }),
      ])
    );
  });

  it('retains old-envelope source transitions even when their stale snapshot is skipped', async () => {
    const harness = makeLiveHarness();
    await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: {
            status: 'idle',
            previousStatus: 'question',
            occurredAt: '2026-07-24T08:05:00.000Z',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    await harness.settle();
    const result = await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: {
            status: 'question',
            previousStatus: 'busy',
            occurredAt: '2026-07-24T07:59:00.000Z',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      10_000
    );
    await harness.settle();
    expect(result.changes).toEqual([]);
    expect(harness.meta.get('status')).toBe('idle');
    expect(harness.evidenceLedger.events.size).toBe(2);
  });

  it('keeps same-millisecond busy-question-busy events distinct and projects the newest transition id', async () => {
    const harness = makeLiveHarness();
    const occurredAt = '2026-07-24T07:59:00.000Z';
    const latest = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: { status: 'busy', previousStatus: 'question', occurredAt, transitionId: latest },
        },
        {
          type: 'session_status',
          data: {
            status: 'question',
            previousStatus: 'busy',
            occurredAt,
            transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          },
        },
        {
          type: 'session_status',
          data: {
            status: 'busy',
            previousStatus: 'idle',
            occurredAt,
            transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAT',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    await harness.settle();
    expect(harness.meta.get('status')).toBe('busy');
    expect(harness.meta.get('statusTransitionId')).toBe(latest);
    expect(harness.evidenceLedger.events.size).toBe(3);
    expect([...harness.evidenceLedger.events.keys()]).toEqual(
      expect.arrayContaining([
        JSON.stringify(['usr_live', 'ses_live', 'status', latest]),
        JSON.stringify(['usr_live', 'ses_live', 'status', '01ARZ3NDEKTSV4RRFFQ69G5FAV']),
        JSON.stringify(['usr_live', 'ses_live', 'status', '01ARZ3NDEKTSV4RRFFQ69G5FAT']),
      ])
    );
  });
  it('retains both equal-millisecond source events when the older identity arrives after the newer projection', async () => {
    const harness = makeLiveHarness();
    const occurredAt = '2026-07-24T07:59:00.000Z';
    await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: {
            status: 'busy',
            previousStatus: 'question',
            occurredAt,
            transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      20_000
    );
    await harness.settle();
    const result = await harness.durableObject.ingest(
      [
        {
          type: 'session_status',
          data: {
            status: 'question',
            previousStatus: 'busy',
            occurredAt,
            transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          },
        },
      ],
      'usr_live',
      'ses_live',
      1,
      30_000
    );
    await harness.settle();
    expect(harness.meta.get('status')).toBe('busy');
    expect(harness.meta.get('statusTransitionId')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAW');
    expect(harness.evidenceLedger.events.size).toBe(2);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { name: 'status', value: 'question' },
        { name: 'statusTransitionId', value: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      ])
    );
    if (result.accepted) expect(result.attentionSignals).toEqual([]);
  });
  describe('briefing evidence retry alarm', () => {
    const outboxKeys = (meta: Map<string, string | null>) =>
      [...meta.keys()].filter(key => key.startsWith('briefingEvidence:'));

    async function ingestWithFailedEvidence() {
      const harness = makeLiveHarness({ evidenceError: new Error('evidence unavailable') });
      await harness.durableObject.ingest(
        [
          { type: 'session_open', data: {} },
          assistantItem('retry', 0.1),
          {
            type: 'session_status',
            data: { status: 'question', occurredAt: '2026-07-24T07:59:00.000Z' },
          },
        ],
        'usr_live',
        'ses_live',
        1,
        10_000
      );
      await harness.settle();
      return harness;
    }

    it('arms a durable backoff retry ahead of the metrics alarm without emitting metrics', async () => {
      const before = Date.now();
      const harness = await ingestWithFailedEvidence();
      const metricsAlarmAt = harness.meta.get('metricsAlarmAt');
      const retryAt = Number(harness.meta.get('briefingEvidenceRetryAt'));
      expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
      expect(retryAt).toBeLessThan(Number(metricsAlarmAt));
      expect(harness.alarmAt).toBe(retryAt);
      expect(harness.meta.get('briefingEvidenceRetryAttempt')).toBe('1');
      expect(outboxKeys(harness.meta)).toHaveLength(2);

      harness.meta.set('briefingEvidenceRetryAt', String(Date.now() - 1));
      await harness.durableObject.alarm();
      expect(harness.ingestSessionMetrics).not.toHaveBeenCalled();
      expect(harness.meta.get('metricsEmitted')).toBeUndefined();
      expect(harness.meta.get('metricsAlarmAt')).toBe(metricsAlarmAt);
      expect(harness.meta.get('briefingEvidenceRetryAttempt')).toBe('2');
      const nextRetryAt = Number(harness.meta.get('briefingEvidenceRetryAt'));
      expect(nextRetryAt).toBeGreaterThanOrEqual(retryAt + 30_000);
      expect(harness.alarmAt).toBe(nextRetryAt);
      expect(outboxKeys(harness.meta)).toHaveLength(2);
      expect(harness.evidenceLedger.events.size).toBe(0);
    });

    it('delivers evidence on the retry alarm, clears the retry and re-arms the metrics time', async () => {
      const harness = await ingestWithFailedEvidence();
      const metricsAlarmAt = harness.meta.get('metricsAlarmAt');
      harness.evidenceLedger.setError(undefined);
      harness.meta.set('briefingEvidenceRetryAt', String(Date.now() - 1));
      await harness.durableObject.alarm();
      expect(harness.evidenceLedger.events.size).toBe(2);
      expect(outboxKeys(harness.meta)).toEqual([]);
      expect(harness.meta.has('briefingEvidenceRetryAt')).toBe(false);
      expect(harness.meta.has('briefingEvidenceRetryAttempt')).toBe(false);
      expect(harness.meta.get('metricsAlarmAt')).toBe(metricsAlarmAt);
      expect(harness.alarmAt).toBe(Number(metricsAlarmAt));
      expect(harness.ingestSessionMetrics).not.toHaveBeenCalled();
    });

    it('does not retry the external write on a fresh ingest inside the backoff window', async () => {
      const harness = await ingestWithFailedEvidence();
      const attempts = harness.evidenceLedger.transaction.mock.calls.length;
      await harness.durableObject.ingest(
        [assistantItem('inside-window', 0.2)],
        'usr_live',
        'ses_live',
        1,
        20_000
      );
      await harness.settle();
      expect(harness.evidenceLedger.transaction).toHaveBeenCalledTimes(attempts);
      expect(outboxKeys(harness.meta).length).toBeGreaterThan(2);
      expect(harness.meta.get('briefingEvidenceRetryAttempt')).toBe('1');

      harness.evidenceLedger.setError(undefined);
      harness.meta.set('briefingEvidenceRetryAt', String(Date.now() - 1));
      await harness.durableObject.alarm();
      expect(outboxKeys(harness.meta)).toEqual([]);
      expect(harness.evidenceLedger.events.size).toBeGreaterThan(2);
    });

    it('clears the pending flag once the outbox drains so later ingests skip the scan', async () => {
      const harness = makeLiveHarness();
      await harness.durableObject.ingest(
        [assistantItem('drains', 0.1)],
        'usr_live',
        'ses_live',
        1,
        10_000
      );
      await harness.settle();
      expect(outboxKeys(harness.meta)).toEqual([]);
      expect(harness.meta.has('briefingEvidencePending')).toBe(false);
      expect(harness.meta.has('briefingEvidenceRetryAt')).toBe(false);

      const failing = await ingestWithFailedEvidence();
      expect(failing.meta.get('briefingEvidencePending')).toBe('true');
    });

    it('flushes evidence staged while a flush was in flight without waiting for the backoff', async () => {
      const gate = Promise.withResolvers<void>();
      const harness = makeLiveHarness({ evidenceGate: gate.promise });
      await harness.durableObject.ingest(
        [assistantItem('first', 0.1)],
        'usr_live',
        'ses_live',
        1,
        10_000
      );
      await harness.durableObject.ingest(
        [assistantItem('second', 0.2)],
        'usr_live',
        'ses_live',
        1,
        20_000
      );
      gate.resolve();
      await harness.settle();
      expect(outboxKeys(harness.meta)).toEqual([]);
      expect(harness.meta.has('briefingEvidencePending')).toBe(false);
      expect(harness.meta.has('briefingEvidenceRetryAt')).toBe(false);
      expect(harness.evidenceLedger.events.size).toBeGreaterThanOrEqual(2);
    });

    it('still emits due metrics while evidence keeps failing and keeps the retry armed', async () => {
      const harness = await ingestWithFailedEvidence();
      harness.meta.set('metricsAlarmAt', String(Date.now() - 1));
      await harness.durableObject.alarm();
      expect(harness.ingestSessionMetrics).toHaveBeenCalledTimes(1);
      expect(harness.meta.get('metricsEmitted')).toBe('true');
      expect(harness.meta.has('metricsAlarmAt')).toBe(false);
      expect(outboxKeys(harness.meta)).toHaveLength(2);
      expect(harness.alarmAt).toBe(Number(harness.meta.get('briefingEvidenceRetryAt')));
    });

    it('never retries or re-arms evidence delivery once the session is deleted', async () => {
      const gate = Promise.withResolvers<void>();
      const harness = makeLiveHarness({ evidenceGate: gate.promise });
      await harness.durableObject.ingest(
        [assistantItem('deleted', 0.1)],
        'usr_live',
        'ses_live',
        1,
        10_000
      );
      await vi.waitFor(() => expect(harness.evidenceLedger.transaction).toHaveBeenCalled());
      expect(harness.meta.has('briefingEvidenceRetryAt')).toBe(true);

      // clearSessionData: keep only the tombstone and drop the alarm.
      for (const key of [...harness.meta.keys()]) harness.meta.delete(key);
      harness.meta.set('deleted', 'true');
      await harness.storage.deleteAlarm();
      const armedCalls = harness.storage.setAlarm.mock.calls.length;

      gate.resolve();
      await harness.settle();
      await harness.durableObject.alarm();
      expect(
        [...harness.meta.keys()].filter(
          key => key.startsWith('briefingEvidence') || key === 'metricsAlarmAt'
        )
      ).toEqual([]);
      expect(harness.meta.get('deleted')).toBe('true');
      expect(harness.storage.setAlarm.mock.calls.length).toBe(armedCalls);
      expect(harness.alarmAt).toBeNull();
    });
  });

  it('guards the live summary by the activity time it rides with', async () => {
    const harness = makeLiveHarness();
    const ingestedAt = 1_700_000_000_000;

    await harness.durableObject.ingest(
      [assistantItem('m1', 0.15), toolPart('p1', 'running', 'src/auth.ts')],
      'usr_live',
      'ses_live',
      1,
      ingestedAt
    );
    await harness.settle();

    const set = harness.lastPgSet!;
    expect(set).toHaveProperty('live_summary');
    // A slower in-flight write of an older batch must not replace a newer
    // summary, so the write is a CASE on the stored activity, like its siblings.
    expect(sqlContainsCase(set.live_summary)).toBe(true);
    const summarySql = sqlFragmentText(set.live_summary);
    expect(summarySql).toContain(new Date(ingestedAt).toISOString());
    expect(summarySql).toContain('auth.ts');
  });

  it('folds only the items the timestamp guard stored into the live summary', async () => {
    const harness = makeLiveHarness();
    const newer = 1_700_000_100_000;
    const older = 1_700_000_000_000;

    await harness.durableObject.ingest(
      [assistantItem('m1', 0.15), toolPart('p1', 'running', 'src/auth.ts')],
      'usr_live',
      'ses_live',
      1,
      newer
    );
    await harness.settle();
    expect(harness.meta.get('liveSummaryState')).toContain('auth.ts');

    // A replay of an older version of a part the DO already holds newer is
    // skipped by the guard, so it must not move the step either.
    await harness.durableObject.ingest(
      [toolPart('p1', 'running', 'src/stale.ts')],
      'usr_live',
      'ses_live',
      1,
      older
    );
    await harness.settle();
    const state = harness.meta.get('liveSummaryState') ?? '';
    expect(state).toContain('auth.ts');
    expect(state).not.toContain('stale.ts');
  });

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

  it('skips full message cost scan when 30s cost window is closed (KB-3)', async () => {
    const harness = makeLiveHarness({
      seedMeta: {
        lastCostPersistedAtMs: String(Date.now()), // within 30s
        lastCostPersistedMicrodollars: '100000',
        // activity throttle closed so we isolate cost-scan behavior
        lastActivityPersistedAtMs: String(Date.now()),
        lastActivityPersistedValueMs: '9999999999999',
      },
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
      [assistantItem('m_throttled', 0.99)],
      'usr_live',
      'ses_live',
      1,
      Date.now()
    );
    await harness.settle();

    expect(harness.costScanCount).toBe(0);
    expect(harness.pgCallCount).toBe(0);
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBe('100000');
  });

  it('idle transition still scans and persists cost inside closed 30s window (D17)', async () => {
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
        lastCostPersistedAtMs: String(Date.now()),
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

    // cost scan runs at least once (attention path may also select message rows)
    expect(harness.costScanCount).toBeGreaterThanOrEqual(1);
    expect(harness.pgCallCount).toBe(1);
    expect(sqlFragmentText(harness.lastPgSet!.total_cost_microdollars)).toContain('250000');
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBe('250000');
  });

  it('user-only message batch does not open cost persist (KB-4)', async () => {
    const harness = makeLiveHarness({
      seedMeta: {
        // leave activity path free so we can see activity-only write
      },
    });

    await harness.durableObject.ingest([userItem('u1')], 'usr_live', 'ses_live', 1, 3_000);
    await harness.settle();

    expect(harness.costScanCount).toBe(0);
    expect(harness.pgCallCount).toBe(1);
    const set = harness.lastPgSet!;
    expect(set).toHaveProperty('last_activity_at');
    expect(set).not.toHaveProperty('total_cost_microdollars');
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBeUndefined();
  });

  it('assistant message still opens cost path (KB-4 regression)', async () => {
    const harness = makeLiveHarness();
    await harness.durableObject.ingest(
      [assistantItem('a1', 0.05)],
      'usr_live',
      'ses_live',
      1,
      4_000
    );
    await harness.settle();

    expect(harness.costScanCount).toBe(1);
    expect(harness.pgCallCount).toBe(1);
    expect(sqlFragmentText(harness.lastPgSet!.total_cost_microdollars)).toContain('50000');
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBe('50000');
  });

  it('decreased recomputed cost does not move lastCostPersistedMicrodollars backward (KB-7)', async () => {
    // Prior persist was 200000; R2 offload left '{}' so recompute yields 0 → gate closed.
    const harness = makeLiveHarness({
      seedMeta: {
        lastCostPersistedMicrodollars: '200000',
        lastCostPersistedAtMs: String(Date.now() - 60_000), // window open
        lastActivityPersistedAtMs: String(Date.now()),
        lastActivityPersistedValueMs: '9999999999999',
      },
      seedMessageRows: [{ item_data: '{}' }],
    });

    await harness.durableObject.ingest(
      [assistantItem('m_r2', 0.01)], // upserted as inline in harness, but seed rows dominate scan
      'usr_live',
      'ses_live',
      1,
      Date.now()
    );
    await harness.settle();

    // Scan ran (window open) but cost gate rejects decrease; no PG cost write / meta regression.
    expect(harness.costScanCount).toBe(1);
    // activity throttled → no persist at all, or only if activity fired
    expect(harness.meta.get('lastCostPersistedMicrodollars')).toBe('200000');
    if (harness.pgCallCount > 0) {
      expect(harness.lastPgSet).not.toHaveProperty('total_cost_microdollars');
    }
  });

  it('post-await throttle meta max-merges so older completion cannot regress newer (KB-6)', async () => {
    // Two concurrent waitUntil tasks: newer cost meta is written first; older completion must not clobber.
    type Gate = { resolve: () => void; promise: Promise<void> };
    const makeGate = (): Gate => {
      let resolve!: () => void;
      const promise = new Promise<void>(r => {
        resolve = r;
      });
      return { resolve, promise };
    };

    const gateA = makeGate(); // older, lower cost — completes second
    const gateB = makeGate(); // newer, higher cost — completes first
    let pgInvoke = 0;

    const meta = new Map<string, string | null>();
    const messageRows: Array<{ item_data: string }> = [];
    const itemRows = new Map<
      string,
      { ingested_at: number | null; item_data_r2_key: string | null }
    >();
    let selectKind: 'meta_get' | 'item_guard' | 'message_cost' | 'briefing_outbox' | 'other' =
      'other';
    let eqKey: string | undefined;

    const selectQuery = {
      from: vi.fn((table: unknown) => {
        if (table === ingestMeta && selectKind === 'other') selectKind = 'briefing_outbox';
        return selectQuery;
      }),
      where: vi.fn((condition: unknown) => {
        const params = collectBoundParams(condition);
        eqKey = params.find((p): p is string => typeof p === 'string');
        return selectQuery;
      }),
      orderBy: vi.fn(() => selectQuery),
      limit: vi.fn(() => selectQuery),
      get: vi.fn(() => {
        if (selectKind === 'item_guard' && eqKey !== undefined) return itemRows.get(eqKey);
        if (eqKey !== undefined && meta.has(eqKey)) return { value: meta.get(eqKey) };
        if (eqKey !== undefined) return meta.has(eqKey) ? { value: meta.get(eqKey) } : undefined;
        return undefined;
      }),
      all: vi.fn(() =>
        selectKind === 'message_cost'
          ? messageRows
          : selectKind === 'briefing_outbox'
            ? [...meta]
                .filter(([key]) => key.startsWith('briefingEvidence:'))
                .map(([key, value]) => ({ key, value }))
            : []
      ),
    };

    const db = {
      select: vi.fn((columns?: unknown) => {
        const cols = columns as Record<string, unknown> | undefined;
        if (cols && 'item_data' in cols && !('item_type' in cols) && !('value' in cols)) {
          selectKind = 'ingested_at' in cols ? 'item_guard' : 'message_cost';
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
              run: vi.fn(() => {
                if (values.key !== undefined && !meta.has(values.key))
                  meta.set(values.key, values.value ?? null);
              }),
              returning: vi.fn(() => ({ get: vi.fn(() => ({ state: 'pending' })) })),
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
      storage: { setAlarm: vi.fn(), getAlarm: vi.fn(async () => null), deleteAlarm: vi.fn() },
      waitUntil,
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;

    const pgWhere = vi.fn(() => {
      pgInvoke += 1;
      const gate = pgInvoke === 1 ? gateA : gateB;
      return {
        then(
          onFulfilled?: ((value: unknown) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null
        ) {
          return gate.promise.then(() => undefined).then(onFulfilled, onRejected);
        },
      };
    });
    dbClientMocks.getWorkerDb.mockReset();
    dbClientMocks.getWorkerDb.mockReturnValue({
      transaction: makeEvidenceLedger().transaction,
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: pgWhere })) })),
    });

    const env = {
      SESSION_INGEST_R2: { delete: vi.fn() },
      HYPERDRIVE: { connectionString: 'postgres://test' },
      NOTIFICATIONS: { sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })) },
    } as never;
    const durableObject = new SessionIngestDO(state, env);

    // Ingest A: cost 100000 — its PG write is held on gateA
    await durableObject.ingest([assistantItem('ma', 0.1)], 'usr_live', 'ses_live', 1, 10_000);
    // Ingest B: cost 250000 — held on gateB
    await durableObject.ingest([assistantItem('mb', 0.25)], 'usr_live', 'ses_live', 1, 20_000);

    expect(waitUntilPromises.length).toBe(4);

    // B completes first (sum 0.1+0.25 → 350000), then A (0.1 → 100000).
    // Without max-merge, A would regress meta to 100000.
    gateB.resolve();
    await waitUntilPromises[3];
    expect(meta.get('lastCostPersistedMicrodollars')).toBe('350000');

    gateA.resolve();
    await waitUntilPromises[1];
    expect(meta.get('lastCostPersistedMicrodollars')).toBe('350000');
    // activity value also max-merged
    expect(Number(meta.get('lastActivityPersistedValueMs'))).toBe(20_000);
  });
});

describe('SessionIngestDO clone primitives', () => {
  type ItemRow = {
    id: number;
    item_id: string;
    item_type: string;
    item_data: string;
    item_data_r2_key: string | null;
    ingested_at: number | null;
  };

  /**
   * Recover the ingest-order cursor bound into an `afterIngestOrderCursor` SQL
   * condition. The non-null branch binds [ingestedAt, ingestedAt, id]; the null
   * branch binds [id]; no cursor binds no numbers.
   */
  function extractIngestCursor(
    condition: unknown
  ): { ingestedAt: number | null; id: number } | null {
    const numbers = collectConditionParams(condition).filter(
      (p): p is number => typeof p === 'number'
    );
    if (numbers.length === 0) return null;
    if (numbers.length === 1) return { ingestedAt: null, id: numbers[0] };
    return { ingestedAt: numbers[0], id: numbers[numbers.length - 1] };
  }

  /**
   * Walk a drizzle SQL condition and collect every bound Param value (string or
   * number), including Params nested inside the plain array that `inArray`
   * inlines. `collectBoundParams` above stops at that array, so this walker is
   * needed for the clone export condition.
   */
  function collectConditionParams(
    condition: unknown,
    out: Array<string | number> = []
  ): Array<string | number> {
    if (condition == null) return out;
    if (Array.isArray(condition)) {
      for (const item of condition) collectConditionParams(item, out);
      return out;
    }
    if (typeof condition !== 'object') return out;
    const value = (condition as { value?: unknown }).value;
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(value);
    }
    const chunks = (condition as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) collectConditionParams(chunk, out);
    }
    return out;
  }

  function compareIngestOrder(
    a: { ingested_at: number | null; id: number },
    b: { ingested_at: number | null; id: number }
  ): number {
    if (a.ingested_at === null && b.ingested_at !== null) return -1;
    if (a.ingested_at !== null && b.ingested_at === null) return 1;
    if (a.ingested_at !== null && b.ingested_at !== null && a.ingested_at !== b.ingested_at) {
      return a.ingested_at - b.ingested_at;
    }
    return a.id - b.id;
  }

  function isAfterIngestOrder(
    row: { ingested_at: number | null; id: number },
    cursor: { ingestedAt: number | null; id: number }
  ): boolean {
    if (cursor.ingestedAt === null) {
      if (row.ingested_at === null) return row.id > cursor.id;
      return true;
    }
    if (row.ingested_at === null) return false;
    if (row.ingested_at !== cursor.ingestedAt) return row.ingested_at > cursor.ingestedAt;
    return row.id > cursor.id;
  }

  function makeCloneHarness(seedItems: ItemRow[] = []) {
    const items: ItemRow[] = seedItems.map(row => ({ ...row }));
    const meta = new Map<string, string | null>();
    let nextId = items.reduce((max, row) => Math.max(max, row.id), 0) + 1;

    type SelectKind = 'items_export' | 'items_r2' | 'meta_get' | 'other';
    let selectKind: SelectKind = 'other';
    let whereCondition: unknown;
    let eqKey: string | undefined;
    let limitValue: number | undefined;
    let orderByArgs: unknown[] = [];

    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn((condition: unknown) => {
        whereCondition = condition;
        eqKey = collectBoundParams(condition).find((p): p is string => typeof p === 'string');
        return selectQuery;
      }),
      orderBy: vi.fn((...args: unknown[]) => {
        orderByArgs = args;
        return selectQuery;
      }),
      limit: vi.fn((n: number) => {
        limitValue = n;
        return selectQuery;
      }),
      get: vi.fn(() => {
        if (selectKind === 'meta_get' && eqKey !== undefined) {
          const value = meta.get(eqKey);
          return value === undefined ? undefined : { value };
        }
        return undefined;
      }),
      all: vi.fn(() => {
        if (selectKind === 'items_export') {
          const params = collectConditionParams(whereCondition);
          const allowedTypes = params.filter((p): p is string => typeof p === 'string');
          const cursor = extractIngestCursor(whereCondition);
          return items
            .filter(row => allowedTypes.includes(row.item_type))
            .filter(row => cursor === null || isAfterIngestOrder(row, cursor))
            .sort(compareIngestOrder)
            .slice(0, limitValue ?? Number.POSITIVE_INFINITY)
            .map(row => ({
              id: row.id,
              item_id: row.item_id,
              item_type: row.item_type,
              item_data: row.item_data,
              item_data_r2_key: row.item_data_r2_key,
              ingested_at: row.ingested_at,
            }));
        }
        if (selectKind === 'items_r2') {
          return items
            .filter(row => row.item_data_r2_key !== null)
            .map(row => ({ item_data_r2_key: row.item_data_r2_key }));
        }
        return [];
      }),
    };

    const db = {
      select: vi.fn((columns?: unknown) => {
        const cols = columns as Record<string, unknown> | undefined;
        if (cols && 'item_id' in cols) selectKind = 'items_export';
        else if (cols && 'item_data_r2_key' in cols) selectKind = 'items_r2';
        else if (cols && 'value' in cols) selectKind = 'meta_get';
        else selectKind = 'other';
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
                  const existing = items.find(row => row.item_id === values.item_id);
                  if (existing) {
                    existing.item_type = values.item_type ?? existing.item_type;
                    existing.item_data = values.item_data ?? existing.item_data;
                    existing.item_data_r2_key = values.item_data_r2_key ?? null;
                    existing.ingested_at = values.ingested_at ?? null;
                  } else {
                    items.push({
                      id: nextId++,
                      item_id: values.item_id,
                      item_type: values.item_type ?? '',
                      item_data: values.item_data ?? '',
                      item_data_r2_key: values.item_data_r2_key ?? null,
                      ingested_at: values.ingested_at ?? null,
                    });
                  }
                }
              }),
            })),
          })
        ),
      })),
      delete: vi.fn((table: unknown) => ({
        run: () => {
          if (table === ingestItems) items.length = 0;
          if (table === ingestMeta) meta.clear();
        },
        where: (condition: unknown) => ({
          run: () => {
            if (table !== ingestMeta) return;
            // `ne(key, 'deleted')` wipes all but the tombstone; `eq(key, k)` deletes one key.
            const key = collectBoundParams(condition).find(
              (p): p is string => typeof p === 'string'
            );
            if (key === 'deleted') {
              for (const k of meta.keys()) if (k !== 'deleted') meta.delete(k);
            } else if (key !== undefined) {
              meta.delete(key);
            }
          },
        }),
      })),
    };
    drizzleMocks.db = db;

    const deleteObject = vi.fn(async () => {});
    const deleteAlarm = vi.fn(async () => {});
    const clearSqlite = vi.fn((fn: () => unknown) => fn());
    const state = {
      storage: {
        setAlarm: vi.fn(),
        deleteAlarm,
        transactionSync: clearSqlite,
      },
      waitUntil: vi.fn(),
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const env = { SESSION_INGEST_R2: { delete: deleteObject } } as never;

    return {
      durableObject: new SessionIngestDO(state, env),
      items,
      meta,
      deleteObject,
      deleteAlarm,
      clearSqlite,
      get orderByArgs() {
        return orderByArgs;
      },
    };
  }

  function itemRow(
    id: number,
    itemId: string,
    itemType: string,
    ingestedAt: number | null,
    r2Key: string | null = null
  ): ItemRow {
    return {
      id,
      item_id: itemId,
      item_type: itemType,
      item_data: JSON.stringify({ id: itemId }),
      item_data_r2_key: r2Key,
      ingested_at: ingestedAt,
    };
  }

  it('exports bounded batches in (ingested_at, id) order with only allowed item types', async () => {
    const harness = makeCloneHarness([
      itemRow(1, 'session/1', 'session', 100),
      itemRow(2, 'message/2', 'message', 100),
      itemRow(3, 'kilo_meta/3', 'kilo_meta', 100),
      itemRow(4, 'part/4', 'part', 200),
      itemRow(5, 'session_diff/5', 'session_diff', 300),
      itemRow(6, 'message/6', 'message', 50),
    ]);

    const first = await harness.durableObject.exportCloneBatch(null, 2);
    expect(harness.orderByArgs).toEqual([ingestItems.ingested_at, ingestItems.id]);
    expect(first.rows.map(row => row.itemId)).toEqual(['message/6', 'session/1']);
    expect(
      first.rows.every(row => ['session', 'message', 'part', 'session_diff'].includes(row.itemType))
    ).toBe(true);
    expect(first.done).toBe(false);
    expect(first.nextCursor).toEqual({ ingestedAt: 100, id: 1 });

    const second = await harness.durableObject.exportCloneBatch(first.nextCursor, 2);
    expect(second.rows.map(row => row.itemId)).toEqual(['message/2', 'part/4']);
    expect(second.done).toBe(false);
    expect(second.nextCursor).toEqual({ ingestedAt: 200, id: 4 });

    const third = await harness.durableObject.exportCloneBatch(second.nextCursor, 2);
    expect(third.rows.map(row => row.itemId)).toEqual(['session_diff/5']);
    expect(third.done).toBe(true);
    expect(third.nextCursor).toBeNull();
  });

  it('produces a deterministic, stable digest over identical rows', async () => {
    const harness = makeCloneHarness([
      itemRow(1, 'session/1', 'session', 100),
      itemRow(2, 'message/2', 'message', 200, 'items/blob-2'),
    ]);

    const first = await harness.durableObject.exportCloneBatch(null, 10);
    const second = await harness.durableObject.exportCloneBatch(null, 10);

    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);

    // The digest covers the stored reference: an inline row contributes item_data,
    // so changing inline data changes the digest.
    harness.items[0].item_data = JSON.stringify({ id: 'session/1', changed: true });
    const changed = await harness.durableObject.exportCloneBatch(null, 10);
    expect(changed.digest).not.toBe(first.digest);
  });

  it('stages, inspects, and finalizes a clone round-trip', async () => {
    const harness = makeCloneHarness();
    const rows = [
      {
        itemId: 'session/dst',
        itemType: 'session' as const,
        itemData: '{}',
        itemDataR2Key: null,
        ingestedAt: 1,
      },
      {
        itemId: 'message/dst',
        itemType: 'message' as const,
        itemData: '{}',
        itemDataR2Key: null,
        ingestedAt: 2,
      },
    ];

    const staged = harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows,
      nextCursor: { ingestedAt: 2, id: 9 },
      rollingDigest: 'digest-1',
      copiedItemCount: 2,
    });
    expect(staged).toMatchObject({ status: 'staged', copiedItemCount: 2 });

    const inspected = harness.durableObject.inspectCloneStage({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
    });
    expect(inspected).toMatchObject({
      status: 'in_progress',
      nextCursor: { ingestedAt: 2, id: 9 },
      rollingDigest: 'digest-1',
      copiedItemCount: 2,
    });

    const finalized = harness.durableObject.finalizeCloneStage({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      finalDigest: 'digest-1',
      finalItemCount: 2,
    });
    expect(finalized).toMatchObject({ status: 'complete', sourceSessionId: 'src' });

    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
      })
    ).toMatchObject({ status: 'complete' });
    expect(harness.items).toHaveLength(2);
  });

  it('resumes an incomplete same-source stage with the persisted next cursor', async () => {
    const harness = makeCloneHarness();

    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/a',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
        {
          itemId: 'message/b',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 2,
        },
      ],
      nextCursor: { ingestedAt: 2, id: 11 },
      rollingDigest: 'digest-partial',
      copiedItemCount: 2,
    });

    const inspected = harness.durableObject.inspectCloneStage({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
    });
    expect(inspected).toMatchObject({
      status: 'in_progress',
      nextCursor: { ingestedAt: 2, id: 11 },
      copiedItemCount: 2,
    });

    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/c',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 3,
        },
        {
          itemId: 'message/d',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 4,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest-full',
      copiedItemCount: 4,
    });

    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
      })
    ).toMatchObject({
      status: 'in_progress',
      nextCursor: null,
      rollingDigest: 'digest-full',
      copiedItemCount: 4,
    });
    expect(harness.items).toHaveLength(4);
  });

  it('rejects a different source or destination across stage, inspect, and finalize', async () => {
    const harness = makeCloneHarness();

    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src-a',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/a',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest-a',
      copiedItemCount: 1,
    });

    const stagedB = harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src-b',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/b',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest-b',
      copiedItemCount: 1,
    });
    expect(stagedB).toMatchObject({ status: 'mismatch', storedSourceSessionId: 'src-a' });

    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src-b',
        destinationSessionId: 'dst',
      })
    ).toMatchObject({ status: 'mismatch', storedSourceSessionId: 'src-a' });

    expect(
      harness.durableObject.finalizeCloneStage({
        sourceSessionId: 'src-b',
        destinationSessionId: 'dst',
        finalDigest: 'digest-a',
        finalItemCount: 1,
      })
    ).toMatchObject({ status: 'mismatch', storedSourceSessionId: 'src-a' });

    // A destination mismatch is rejected too.
    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src-a',
        destinationSessionId: 'dst-other',
      })
    ).toMatchObject({ status: 'mismatch', storedDestinationSessionId: 'dst' });

    // The rejected batch did not mutate the stage.
    expect(harness.items).toHaveLength(1);
    expect(harness.items[0].item_id).toBe('message/a');
  });

  it('reports whether a mismatched stage was complete or in_progress', () => {
    const harness = makeCloneHarness();

    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src-a',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/a',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest-a',
      copiedItemCount: 1,
    });

    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src-b',
        destinationSessionId: 'dst',
      })
    ).toMatchObject({ status: 'mismatch', storedStage: 'in_progress' });

    harness.durableObject.finalizeCloneStage({
      sourceSessionId: 'src-a',
      destinationSessionId: 'dst',
      finalDigest: 'digest-a',
      finalItemCount: 1,
    });

    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src-b',
        destinationSessionId: 'dst',
      })
    ).toMatchObject({ status: 'mismatch', storedStage: 'complete' });
  });

  it('is idempotent when re-staging the same batch and re-finalizing the same source', async () => {
    const harness = makeCloneHarness();
    const params = {
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/a',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
        {
          itemId: 'message/b',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 2,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest-full',
      copiedItemCount: 2,
    };

    expect(harness.durableObject.stageCloneBatch(params).status).toBe('staged');
    expect(harness.durableObject.stageCloneBatch(params).status).toBe('staged');
    expect(harness.items).toHaveLength(2);

    const finalized = {
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      finalDigest: 'digest-full',
      finalItemCount: 2,
    };
    expect(harness.durableObject.finalizeCloneStage(finalized).status).toBe('complete');
    expect(harness.durableObject.finalizeCloneStage(finalized).status).toBe('complete');
  });

  it('rejects finalization when the digest or item count does not match', async () => {
    const harness = makeCloneHarness();
    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'message/a',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest-real',
      copiedItemCount: 1,
    });

    expect(
      harness.durableObject.finalizeCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
        finalDigest: 'digest-wrong',
        finalItemCount: 1,
      })
    ).toMatchObject({
      status: 'digest_mismatch',
      expectedDigest: 'digest-wrong',
      actualDigest: 'digest-real',
    });

    expect(
      harness.durableObject.finalizeCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
        finalDigest: 'digest-real',
        finalItemCount: 5,
      })
    ).toMatchObject({ status: 'digest_mismatch', expectedItemCount: 5, actualItemCount: 1 });

    // No complete marker was written.
    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
      })
    ).toMatchObject({ status: 'in_progress' });
  });

  it('resets staged rows, R2 objects, and clone markers', async () => {
    const harness = makeCloneHarness();
    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows: [
        {
          itemId: 'session/dst',
          itemType: 'session' as const,
          itemData: '{}',
          itemDataR2Key: null,
          ingestedAt: 1,
        },
        {
          itemId: 'message/dst',
          itemType: 'message' as const,
          itemData: '{}',
          itemDataR2Key: 'items/staged-blob',
          ingestedAt: 2,
        },
      ],
      nextCursor: null,
      rollingDigest: 'digest',
      copiedItemCount: 2,
    });

    await harness.durableObject.resetCloneStage();

    // The SQLite wipe must complete before the R2 delete await opens the input gate.
    expect(harness.clearSqlite.mock.invocationCallOrder[0]).toBeLessThan(
      harness.deleteObject.mock.invocationCallOrder[0]
    );
    expect(harness.deleteObject).toHaveBeenCalledWith(['items/staged-blob']);
    expect(harness.items).toHaveLength(0);
    expect(harness.meta.size).toBe(0);
    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
      })
    ).toEqual({ status: 'empty' });
  });

  it('treats a stage built for another message cut as a different clone', () => {
    const harness = makeCloneHarness();
    const cutIdentity = {
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      upToMessageId: 'msg_02',
    };

    expect(
      harness.durableObject.stageCloneBatch({
        ...cutIdentity,
        rows: [
          {
            itemId: 'message/msg_01',
            itemType: 'message' as const,
            itemData: '{}',
            itemDataR2Key: null,
            ingestedAt: 1,
          },
        ],
        nextCursor: { ingestedAt: 1, id: 1 },
        rollingDigest: 'digest-cut',
        copiedItemCount: 1,
      }).status
    ).toBe('staged');
    expect(harness.meta.get('cloneUpToMessageId')).toBe('msg_02');

    expect(harness.durableObject.inspectCloneStage(cutIdentity)).toMatchObject({
      status: 'in_progress',
      copiedItemCount: 1,
    });
    for (const other of [
      { sourceSessionId: 'src', destinationSessionId: 'dst' },
      { ...cutIdentity, upToMessageId: 'msg_03' },
    ]) {
      expect(harness.durableObject.inspectCloneStage(other)).toMatchObject({
        status: 'mismatch',
        storedStage: 'in_progress',
      });
      expect(
        harness.durableObject.stageCloneBatch({
          ...other,
          rows: [],
          nextCursor: null,
          rollingDigest: 'digest-other',
          copiedItemCount: 0,
        }).status
      ).toBe('mismatch');
      expect(
        harness.durableObject.finalizeCloneStage({
          ...other,
          finalDigest: 'digest-cut',
          finalItemCount: 1,
        }).status
      ).toBe('mismatch');
    }

    expect(
      harness.durableObject.finalizeCloneStage({
        ...cutIdentity,
        finalDigest: 'digest-cut',
        finalItemCount: 1,
      }).status
    ).toBe('complete');
    expect(harness.durableObject.inspectCloneStage(cutIdentity)).toMatchObject({
      status: 'complete',
    });
    expect(
      harness.durableObject.inspectCloneStage({ ...cutIdentity, upToMessageId: 'msg_01' })
    ).toMatchObject({ status: 'mismatch', storedStage: 'complete' });
  });

  it('records no message cut for a full clone stage and clears a stale one', () => {
    const harness = makeCloneHarness();
    // A leftover cut with no stage identity reads as an empty stage.
    harness.meta.set('cloneUpToMessageId', 'msg_stale');
    harness.durableObject.stageCloneBatch({
      sourceSessionId: 'src',
      destinationSessionId: 'dst',
      rows: [],
      nextCursor: null,
      rollingDigest: 'digest',
      copiedItemCount: 0,
    });

    expect(harness.meta.has('cloneUpToMessageId')).toBe(false);
    expect(
      harness.durableObject.inspectCloneStage({
        sourceSessionId: 'src',
        destinationSessionId: 'dst',
        upToMessageId: 'msg_01',
      })
    ).toMatchObject({ status: 'mismatch' });
  });

  it('swallows an R2 delete failure so resetCloneStage still returns a typed reject', async () => {
    const harness = makeCloneHarness([itemRow(1, 'message/src', 'message', 1, 'items/blob')]);
    harness.deleteObject.mockRejectedValueOnce(new Error('r2 unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(harness.durableObject.resetCloneStage()).resolves.toBeUndefined();

    expect(harness.clearSqlite).toHaveBeenCalled();
    expect(harness.items).toHaveLength(0);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('fences writes and retains R2 discovery after a failed clear, then retries cleanup', async () => {
    const harness = makeCloneHarness([itemRow(1, 'message/src', 'message', 1, 'items/blob')]);
    harness.deleteObject.mockRejectedValueOnce(new Error('r2 unavailable'));

    await expect(harness.durableObject.clear()).rejects.toThrow('r2 unavailable');
    expect(harness.meta.get('deleted')).toBe('true');
    expect(harness.items).toHaveLength(1);
    expect(harness.clearSqlite).not.toHaveBeenCalled();

    await expect(harness.durableObject.clear()).resolves.toBeUndefined();
    expect(harness.items).toHaveLength(0);
    expect(harness.meta.get('deleted')).toBe('true');
    expect(harness.deleteObject).toHaveBeenCalledTimes(2);
  });
});
