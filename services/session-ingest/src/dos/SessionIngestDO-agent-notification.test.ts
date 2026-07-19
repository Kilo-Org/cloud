import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { SessionIngestDO } from './SessionIngestDO';

/**
 * Stateful in-memory mock of the SessionIngestDO's Drizzle handle. Three logical
 * tables are tracked:
 *   - ingest_items: keyed by `item_id`
 *   - agent_notification_dispatch: keyed by `identity`
 *   - meta: keyed by `key` (existing tests reuse this)
 *
 * Insert chains: `insert(t).values(v).onConflictDoUpdate({...}).run()` persists rows;
 * `insert(t).values(v).onConflictDoNothing(...).returning({state}).get()` is used for the
 * agent_notification insert-if-absent and returns the row only on a fresh insert.
 * Update chains call `.run()` and flip the dispatch row to `dispatched`.
 */
function makeDb() {
  const ingestItems = new Map<string, Record<string, unknown>>();
  const dispatch = new Map<string, { state: 'pending' | 'dispatched' }>();
  const meta = new Map<string, { value: string | null }>();

  type EqCondition = {
    queryChunks?: Array<{ value?: unknown }>;
  };

  const extractEqValue = (condition: unknown): string | undefined => {
    const chunks = (condition as EqCondition | undefined)?.queryChunks ?? [];
    for (const chunk of chunks) {
      const value = (chunk as { value?: unknown } | null)?.value;
      if (typeof value === 'string') return value;
    }
    return undefined;
  };

  const selectChain = (table: 'ingest_items' | 'agent_notification_dispatch' | 'ingest_meta') => {
    let key: string | undefined;
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn((condition: unknown) => {
        key = extractEqValue(condition);
        return chain;
      }),
      get: vi.fn(() => {
        if (table === 'ingest_items') {
          return key === undefined ? undefined : (ingestItems.get(key) ?? undefined);
        }
        if (table === 'agent_notification_dispatch') {
          return key === undefined ? undefined : (dispatch.get(key) ?? undefined);
        }
        return key === undefined ? undefined : (meta.get(key) ?? undefined);
      }),
      all: vi.fn(() => []),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
    };
    return chain;
  };

  const updateChain = {
    set: vi.fn(() => updateChain),
    where: vi.fn((condition: unknown) => {
      const key = extractEqValue(condition);
      if (key !== undefined && dispatch.has(key)) {
        dispatch.set(key, { state: 'dispatched' });
      }
      return {
        run: vi.fn(),
      };
    }),
  };

  const db = {
    select: vi.fn((columns: unknown) => {
      if (
        columns &&
        typeof columns === 'object' &&
        'state' in (columns as Record<string, unknown>)
      ) {
        return selectChain('agent_notification_dispatch');
      }
      if (
        columns &&
        typeof columns === 'object' &&
        'value' in (columns as Record<string, unknown>)
      ) {
        return selectChain('ingest_meta');
      }
      return selectChain('ingest_items');
    }),
    insert: vi.fn((_table: unknown) => ({
      // Every insert chain exposes both conflict handlers so the mock never loses a
      // method regardless of which drizzle table object is passed. The concrete
      // behaviour is driven by the values payload, not by table metadata.
      values: vi.fn((v: Record<string, unknown>) => {
        const values = v;

        const runOnConflictDoUpdate = vi.fn(() => {
          if (typeof values['item_id'] === 'string') {
            ingestItems.set(values['item_id'], values);
          } else if (typeof values['key'] === 'string') {
            meta.set(values['key'], { value: (values['value'] as string | null) ?? null });
          }
        });

        const runOnConflictDoNothing = vi.fn(() => {
          const identity = values['identity'] as string | undefined;
          if (identity !== undefined && !dispatch.has(identity)) {
            dispatch.set(identity, {
              state: (values['state'] as 'pending' | 'dispatched') ?? 'pending',
            });
          }
        });

        return {
          onConflictDoUpdate: vi.fn(() => ({ run: runOnConflictDoUpdate })),
          onConflictDoNothing: vi.fn((_: unknown) => ({
            returning: vi.fn(() => ({
              get: vi.fn(() => {
                const identity = values['identity'] as string | undefined;
                if (identity === undefined) return undefined;
                if (dispatch.has(identity)) return undefined;
                dispatch.set(identity, {
                  state: (values['state'] as 'pending' | 'dispatched') ?? 'pending',
                });
                return { state: values['state'] ?? 'pending' };
              }),
            })),
            run: runOnConflictDoNothing,
          })),
        };
      }),
    })),
    update: vi.fn(() => updateChain),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) })),
  };

  return { db, ingestItems, dispatch, meta, updateChain };
}

let harnessDb: ReturnType<typeof makeDb> | undefined;

beforeEach(() => {
  harnessDb = makeDb();
  drizzleMocks.db = harnessDb.db;
});

function makeHarness() {
  const state = {
    storage: { setAlarm: vi.fn() },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
  } as unknown as DurableObjectState;
  const env = {
    SESSION_INGEST_R2: { delete: vi.fn() },
    NOTIFICATIONS: { sendSessionReadyNotification: vi.fn() },
  } as never;
  return { do: new SessionIngestDO(state, env), dispatch: harnessDb!.dispatch };
}

describe('SessionIngestDO agent_notification dispatch lifecycle', () => {
  it('emits an agent_notification signal on a fresh insert', async () => {
    const { do: durableObject } = makeHarness();
    const result = await durableObject.ingest(
      [{ type: 'agent_notification', data: { id: 'note_1', message: 'Build done' } }],
      'usr_n',
      'ses_n',
      1,
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('unreachable');
    expect(result.attentionSignals).toEqual([
      { kind: 'agent_notification', notificationId: 'note_1', message: 'Build done' },
    ]);
  });

  it('re-emits the same identity on replay while still pending', async () => {
    const { do: durableObject } = makeHarness();
    await durableObject.ingest(
      [{ type: 'agent_notification', data: { id: 'note_replay', message: 'first' } }],
      'usr_n',
      'ses_n',
      1,
      1
    );
    const replay = await durableObject.ingest(
      [{ type: 'agent_notification', data: { id: 'note_replay', message: 'second' } }],
      'usr_n',
      'ses_n',
      1,
      2
    );
    expect(replay.accepted).toBe(true);
    if (!replay.accepted) throw new Error('unreachable');
    expect(replay.attentionSignals).toEqual([
      { kind: 'agent_notification', notificationId: 'note_replay', message: 'second' },
    ]);
  });

  it('emits nothing on replay once the identity is marked dispatched', async () => {
    const { do: durableObject, dispatch } = makeHarness();
    await durableObject.ingest(
      [{ type: 'agent_notification', data: { id: 'note_dispatched', message: 'm' } }],
      'usr_n',
      'ses_n',
      1,
      1
    );
    durableObject.markAgentNotificationDispatched('note_dispatched');
    expect(dispatch.get('agent_notification/note_dispatched')?.state).toBe('dispatched');

    const replay = await durableObject.ingest(
      [{ type: 'agent_notification', data: { id: 'note_dispatched', message: 'm' } }],
      'usr_n',
      'ses_n',
      1,
      2
    );
    expect(replay.accepted).toBe(true);
    if (!replay.accepted) throw new Error('unreachable');
    expect(replay.attentionSignals).toEqual([]);
  });

  it('preserves several distinct notifications in one batch', async () => {
    const { do: durableObject } = makeHarness();
    const result = await durableObject.ingest(
      [
        { type: 'agent_notification', data: { id: 'a', message: 'one' } },
        { type: 'agent_notification', data: { id: 'b', message: 'two' } },
        { type: 'agent_notification', data: { id: 'c', message: 'three' } },
      ],
      'usr_n',
      'ses_n',
      1,
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('unreachable');
    expect(result.attentionSignals).toEqual([
      { kind: 'agent_notification', notificationId: 'a', message: 'one' },
      { kind: 'agent_notification', notificationId: 'b', message: 'two' },
      { kind: 'agent_notification', notificationId: 'c', message: 'three' },
    ]);
  });

  it('keeps the dispatch row pending when only some identities in a batch are pre-marked', async () => {
    const { do: durableObject, dispatch } = makeHarness();
    dispatch.set('agent_notification/old', { state: 'dispatched' });
    const result = await durableObject.ingest(
      [
        { type: 'agent_notification', data: { id: 'old', message: 'stale' } },
        { type: 'agent_notification', data: { id: 'fresh', message: 'new' } },
      ],
      'usr_n',
      'ses_n',
      1,
      1
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error('unreachable');
    expect(result.attentionSignals).toEqual([
      { kind: 'agent_notification', notificationId: 'fresh', message: 'new' },
    ]);
  });
});
