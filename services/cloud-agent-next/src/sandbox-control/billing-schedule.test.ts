import { describe, expect, it } from 'vitest';
import { BillingScheduleTable, VERCEL_BILLING_SCHEDULE_KEY } from './billing-schedule.js';

const T0 = 1_000_000;

function memoryStorage(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(VERCEL_BILLING_SCHEDULE_KEY, initial);
  const state = {
    values,
    puts: [] as unknown[],
    gets: [] as string[],
    failNextGet: false,
    failNextPut: false,
    async get<T>(key: string): Promise<T | undefined> {
      state.gets.push(key);
      if (state.failNextGet) {
        state.failNextGet = false;
        throw new Error('storage read failed');
      }
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      if (state.failNextPut) {
        state.failNextPut = false;
        throw new Error('storage write failed');
      }
      values.set(key, value);
      state.puts.push(value);
    },
  };
  return state;
}

function entries(storage: ReturnType<typeof memoryStorage>) {
  return storage.values.get(VERCEL_BILLING_SCHEDULE_KEY) as
    | Record<string, { dueAtMs: number; retryNotBeforeMs?: number; payload?: unknown }>
    | undefined;
}

describe('BillingScheduleTable loading', () => {
  it('distinguishes not-loaded from empty', async () => {
    const storage = memoryStorage({ a: { dueAtMs: T0 - 1 } });
    const nowMs = T0;
    const table = new BillingScheduleTable({
      storage,
      recompose: async () => undefined,
      now: () => nowMs,
    });

    expect(table.snapshotEarliestDue()).toBeUndefined();

    await table.load();
    expect(table.snapshotEarliestDue()).toBe(T0 - 1);

    const empty = new BillingScheduleTable({
      storage: memoryStorage(),
      recompose: async () => undefined,
      now: () => nowMs,
    });
    await empty.load();
    expect(empty.snapshotEarliestDue()).toBeNull();
  });

  it('propagates a load failure and re-reads on retry', async () => {
    const storage = memoryStorage({ a: { dueAtMs: T0 - 1 } });
    storage.failNextGet = true;
    const table = new BillingScheduleTable({ storage, recompose: async () => undefined });

    await expect(table.load()).rejects.toThrow('storage read failed');
    expect(table.snapshotEarliestDue()).toBeUndefined();

    await table.load();
    expect(table.snapshotEarliestDue()).toBe(T0 - 1);
  });

  it('dedupes concurrent loads to one read', async () => {
    const storage = memoryStorage();
    const table = new BillingScheduleTable({ storage, recompose: async () => undefined });

    await Promise.all([table.load(), table.load()]);
    expect(storage.gets).toHaveLength(1);
  });
});

describe('BillingScheduleTable eligibility', () => {
  it('ignores an entry blocked by retryNotBefore and restores it when due', async () => {
    const storage = memoryStorage();
    let nowMs = T0;
    const table = new BillingScheduleTable({
      storage,
      recompose: async () => undefined,
      now: () => nowMs,
    });
    await table.load();

    await table.schedule('a', T0 - 1_000);
    await table.schedule('b', T0 - 5_000);
    await table.deferRetry('b', undefined, T0 + 10_000);

    expect(table.snapshotEarliestDue()).toBe(T0 - 1_000);
    expect(await table.dueEntries()).toEqual([{ callback: 'a', dueAtMs: T0 - 1_000 }]);

    nowMs = T0 + 11_000;
    expect(table.snapshotEarliestDue()).toBe(T0 - 1_000);
    expect(await table.dueEntries()).toEqual([
      { callback: 'a', dueAtMs: T0 - 1_000 },
      { callback: 'b', dueAtMs: T0 - 5_000 },
    ]);
  });

  it('composes a future-dated entry at that future time instead of ignoring it', async () => {
    let nowMs = T0;
    const table = new BillingScheduleTable({
      storage: memoryStorage(),
      recompose: async () => undefined,
      now: () => nowMs,
    });
    await table.load();
    await table.schedule('a', T0 + 5_000);
    expect(table.snapshotEarliestDue()).toBe(T0 + 5_000);
    expect(await table.dueEntries()).toEqual([]);
    nowMs = T0 + 5_000;
    expect(table.snapshotEarliestDue()).toBe(T0 + 5_000);
    expect(await table.dueEntries()).toEqual([{ callback: 'a', dueAtMs: T0 + 5_000 }]);
  });

  it('composes a deferred entry at its retry bound, not its raw due time', async () => {
    let nowMs = T0;
    const table = new BillingScheduleTable({
      storage: memoryStorage(),
      recompose: async () => undefined,
      now: () => nowMs,
    });
    await table.load();
    await table.schedule('a', T0 - 5_000);
    await table.deferRetry('a', undefined, T0 + 10_000);

    expect(table.snapshotEarliestDue()).toBe(T0 + 10_000);
    expect(await table.dueEntries()).toEqual([]);

    nowMs = T0 + 10_000;
    expect(table.snapshotEarliestDue()).toBe(T0 + 10_000);
    expect(await table.dueEntries()).toEqual([{ callback: 'a', dueAtMs: T0 - 5_000 }]);
  });
});

describe('BillingScheduleTable mutations', () => {
  it('markDue never inserts an entry', async () => {
    const storage = memoryStorage();
    const table = new BillingScheduleTable({ storage, recompose: async () => undefined });
    await table.load();
    await table.schedule('a', T0 + 1_000, 'gen');

    await table.markDue('missing', 'gen', T0);
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0 + 1_000, payload: 'gen' } });

    await table.markDue('a', 'other-generation', T0);
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0 + 1_000, payload: 'gen' } });

    await table.markDue('a', 'gen', T0);
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0, payload: 'gen' } });
  });

  it('deferRetry keeps dueAtMs and blocks dispatch until the retry bound', async () => {
    const storage = memoryStorage();
    let nowMs = T0;
    const table = new BillingScheduleTable({
      storage,
      recompose: async () => undefined,
      now: () => nowMs,
    });
    await table.load();
    await table.schedule('a', T0 - 1_000, 'gen');

    await table.deferRetry('a', 'gen', T0 + 60_000);

    expect(entries(storage)?.a.dueAtMs).toBe(T0 - 1_000);
    expect(entries(storage)?.a.retryNotBeforeMs).toBe(T0 + 60_000);
    expect(table.snapshotEarliestDue()).toBe(T0 + 60_000);
    expect(await table.dueEntries()).toEqual([]);

    nowMs = T0 + 60_000;
    expect(table.snapshotEarliestDue()).toBe(T0 + 60_000);

    // markDue moves the due time for settlement but must not erase the backoff.
    await table.markDue('a', 'gen', T0 + 61_000);
    expect(entries(storage)?.a.dueAtMs).toBe(T0 + 61_000);
    expect(entries(storage)?.a.retryNotBeforeMs).toBe(T0 + 60_000);
  });

  it('completeDue only removes a still-matching entry', async () => {
    const storage = memoryStorage();
    const table = new BillingScheduleTable({ storage, recompose: async () => undefined });
    await table.load();
    await table.schedule('a', T0, 'gen');

    await table.completeDue({ callback: 'a', dueAtMs: T0 + 1, payload: 'gen' });
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0, payload: 'gen' } });

    await table.completeDue({ callback: 'a', dueAtMs: T0, payload: 'other' });
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0, payload: 'gen' } });

    await table.completeDue({ callback: 'a', dueAtMs: T0, payload: 'gen' });
    expect(entries(storage)).toEqual({});
  });

  it('remove only deletes a matching payload', async () => {
    const storage = memoryStorage();
    const table = new BillingScheduleTable({ storage, recompose: async () => undefined });
    await table.load();
    await table.schedule('a', T0, 'gen');

    await table.remove('a', 'other');
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0, payload: 'gen' } });

    await table.remove('a', 'gen');
    expect(entries(storage)).toEqual({});
  });

  it('propagates a storage write failure without marking the mutation complete', async () => {
    const storage = memoryStorage();
    let composeCalls = 0;
    const table = new BillingScheduleTable({
      storage,
      recompose: async () => {
        composeCalls += 1;
      },
    });
    await table.load();

    storage.failNextPut = true;
    await expect(table.schedule('a', T0)).rejects.toThrow('storage write failed');
    expect(entries(storage)).toBeUndefined();
    expect(composeCalls).toBe(0);

    await table.schedule('a', T0);
    expect(entries(storage)).toEqual({ a: { dueAtMs: T0 } });
  });
});

describe('BillingScheduleTable compose loop', () => {
  it('sets a dirty bit for a mutation during an in-flight compose and re-runs recompose', async () => {
    const storage = memoryStorage();
    let firstEnteredEnter!: () => void;
    const firstEntered = new Promise<void>(resolve => {
      firstEnteredEnter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let composeCalls = 0;
    const table = new BillingScheduleTable({
      storage,
      recompose: async () => {
        composeCalls += 1;
        if (composeCalls === 1) {
          firstEnteredEnter();
          await gate;
        }
      },
    });
    await table.load();

    const first = table.schedule('a', T0 + 1_000);
    await firstEntered;
    const second = table.schedule('b', T0 + 2_000);
    release();
    await Promise.all([first, second]);

    expect(composeCalls).toBe(2);
    expect(entries(storage)).toEqual({
      a: { dueAtMs: T0 + 1_000 },
      b: { dueAtMs: T0 + 2_000 },
    });
  });

  it('needs no alarm dependency', async () => {
    const storage = memoryStorage();
    expect('setAlarm' in storage).toBe(false);
    expect('deleteAlarm' in storage).toBe(false);

    const table = new BillingScheduleTable({ storage, recompose: async () => undefined });
    await table.load();
    await table.schedule('a', T0);
    await table.deferRetry('a', undefined, T0 + 1_000);
    await table.markDue('a', undefined, T0);
    await table.completeDue({ callback: 'a', dueAtMs: T0 });
    await table.remove('a');
    expect(storage.gets).toEqual([VERCEL_BILLING_SCHEDULE_KEY]);
  });
});
