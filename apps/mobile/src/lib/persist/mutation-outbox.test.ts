/* eslint-disable require-await, @typescript-eslint/require-await -- the fake KV factories settle without await because they resolve immediately */
import * as Sentry from '@sentry/react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The outbox module imports the native encrypted-kv chain; the fake below is
// an in-memory Map-backed KV that mirrors the real upsert/list semantics.
const kvStore = new Map<string, { scope: string; k: string; v: string; updatedAt: number }>();
let nextUpdatedAt = 1;

const kvMock = vi.hoisted(() => ({
  getItem: vi.fn(async (_scope: string, _k: string): Promise<string | null> => null),
  setItem: vi.fn(async (_scope: string, _k: string, _v: string): Promise<void> => undefined),
  removeItem: vi.fn(async (_scope: string, _k: string): Promise<void> => undefined),
  listEntries: vi.fn(async (_scope: string): Promise<{ k: string; updatedAt: number }[]> => []),
}));

vi.mock('@/lib/persist/encrypted-kv', () => kvMock);

vi.mock('@sentry/react-native', () => ({
  captureException: vi.fn(),
}));

/* eslint-disable import/first */
import {
  isOutboxRow,
  listOutboxRows,
  loadOutboxRow,
  outboxScope,
  removeOutboxRow,
  writeOutboxRow,
  type OutboxRow,
} from './mutation-outbox';
import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { inFlightSaveCount } from '@/lib/hooks/save-chain';
/* eslint-enable import/first */

function storageKey(scope: string, k: string): string {
  return `${scope}\u0000${k}`;
}

function seedStoredValue(scope: string, k: string, v: string): void {
  kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
  nextUpdatedAt += 1;
}

function safeRetryRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    taxonomy: 'safe-retry',
    operationKey: 'op-key-1',
    fingerprint: 'fp-1',
    input: { prompt: 'hello' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  nextUpdatedAt = 1;
  kvMock.getItem.mockImplementation(
    async (scope, k) => kvStore.get(storageKey(scope, k))?.v ?? null
  );
  kvMock.setItem.mockImplementation(async (scope, k, v) => {
    kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
    nextUpdatedAt += 1;
  });
  kvMock.removeItem.mockImplementation(async (scope, k) => {
    kvStore.delete(storageKey(scope, k));
  });
  kvMock.listEntries.mockImplementation(async scope =>
    [...kvStore.values()]
      .filter(entry => entry.scope === scope)
      .toSorted((a, b) => a.updatedAt - b.updatedAt)
      .map(entry => ({ k: entry.k, updatedAt: entry.updatedAt }))
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('outbox scope and shape guard', () => {
  it('builds the account-scoped storage key', () => {
    expect(outboxScope('u1')).toBe('outbox:u1');
  });

  it('accepts safe-retry and reconcile-first rows', () => {
    expect(isOutboxRow(safeRetryRow())).toBe(true);
    expect(isOutboxRow(safeRetryRow({ taxonomy: 'reconcile-first' }))).toBe(true);
  });

  it('rejects a never-replay row (never enqueued)', () => {
    expect(isOutboxRow(safeRetryRow({ taxonomy: 'never-replay' as never }))).toBe(false);
  });

  it('rejects malformed rows', () => {
    expect(isOutboxRow(null)).toBe(false);
    expect(isOutboxRow({ taxonomy: 'safe-retry', operationKey: 'k' })).toBe(false);
    expect(isOutboxRow({ taxonomy: 'safe-retry', fingerprint: 'fp' })).toBe(false);
    expect(isOutboxRow({ taxonomy: 'bogus', operationKey: 'k', fingerprint: 'fp' })).toBe(false);
  });

  it('accepts a string scope and rejects a non-string scope', () => {
    expect(isOutboxRow(safeRetryRow({ scope: 'personal' }))).toBe(true);
    expect(isOutboxRow(safeRetryRow({ scope: 42 as never }))).toBe(false);
  });
});

describe('round trip and absent load', () => {
  it('round-trips a safe-retry row through the encrypted kv', async () => {
    const row = safeRetryRow();
    await writeOutboxRow('u1', row);
    await expect(loadOutboxRow('u1', row.fingerprint)).resolves.toEqual(row);
  });

  it('round-trips a reconcile-first row', async () => {
    const row = safeRetryRow({ taxonomy: 'reconcile-first' });
    await writeOutboxRow('u1', row);
    await expect(loadOutboxRow('u1', row.fingerprint)).resolves.toEqual(row);
  });

  it('round-trips a reconcile-first row with its scope', async () => {
    const row = safeRetryRow({ taxonomy: 'reconcile-first', scope: 'personal' });
    await writeOutboxRow('u1', row);
    await expect(loadOutboxRow('u1', row.fingerprint)).resolves.toEqual(row);
  });

  it('loads null for an absent fingerprint without reporting Sentry', async () => {
    await expect(loadOutboxRow('u1', 'missing')).resolves.toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('keeps scopes separate per user', async () => {
    await writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp' }));
    await writeOutboxRow('u2', safeRetryRow({ fingerprint: 'fp', operationKey: 'op-key-2' }));
    await expect(loadOutboxRow('u1', 'fp')).resolves.toMatchObject({ operationKey: 'op-key-1' });
    await expect(loadOutboxRow('u2', 'fp')).resolves.toMatchObject({ operationKey: 'op-key-2' });
  });

  it('no-ops every API when the userId is unknown', async () => {
    await writeOutboxRow('', safeRetryRow());
    await removeOutboxRow('', 'fp');
    await expect(loadOutboxRow('', 'fp')).resolves.toBeNull();
    await expect(listOutboxRows('')).resolves.toEqual([]);
    expect(kvMock.setItem).not.toHaveBeenCalled();
    expect(kvMock.removeItem).not.toHaveBeenCalled();
  });
});

describe('process kill and relaunch', () => {
  it('recovers a written safe-retry row after a simulated relaunch and keeps its stored operationKey', async () => {
    // Crash mid-flight: the row was persisted before the POST.
    await writeOutboxRow('u1', safeRetryRow({ operationKey: 'op-key-1', fingerprint: 'fp-1' }));

    // Relaunch: the launch load lists the rows again from the encrypted KV.
    const rows = await listOutboxRows('u1');

    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      taxonomy: 'safe-retry',
      operationKey: 'op-key-1',
      fingerprint: 'fp-1',
    });
  });
});

describe('remove and list', () => {
  it('removes a stored row', async () => {
    await writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp' }));
    await removeOutboxRow('u1', 'fp');
    await expect(loadOutboxRow('u1', 'fp')).resolves.toBeNull();
  });

  it('lists every row for one user', async () => {
    await writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp-1' }));
    await writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp-2', taxonomy: 'reconcile-first' }));
    const rows = await listOutboxRows('u1');
    expect(rows?.map(r => r.fingerprint).toSorted()).toEqual(['fp-1', 'fp-2']);
  });

  it('skips corrupt entries when listing', async () => {
    seedStoredValue('outbox:u1', 'fp-1', 'not-json{{{');
    await writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp-2' }));
    const rows = await listOutboxRows('u1');
    expect(rows?.map(r => r.fingerprint)).toEqual(['fp-2']);
  });

  it('returns null when the store read fails, never an empty list', async () => {
    // A failed read must not read as "no stored rows": a caller that trusts an
    // empty list mints a fresh operation key and can duplicate the mutation.
    kvMock.listEntries.mockRejectedValueOnce(new Error('kv down'));
    await expect(listOutboxRows('u1')).resolves.toBeNull();

    await writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp-1' }));
    kvMock.getItem.mockRejectedValueOnce(new Error('kv down'));
    await expect(listOutboxRows('u1')).resolves.toBeNull();
  });
});

describe('epoch fence', () => {
  it('skips a queued write whose epoch moved before it ran', async () => {
    // The first write for the key holds the chain (slow setItem); the second
    // queues behind it and captures the same epoch. Bumping the epoch before
    // the first settles makes the second write skip its setItem.
    let releaseFirst: (() => void) | undefined = undefined;
    const gate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    kvMock.setItem.mockImplementationOnce(async (scope, k, v) => {
      await gate;
      kvStore.set(storageKey(scope, k), { scope, k, v, updatedAt: nextUpdatedAt });
      nextUpdatedAt += 1;
    });

    const first = writeOutboxRow('u1', safeRetryRow({ fingerprint: 'fp' }));
    const second = writeOutboxRow(
      'u1',
      safeRetryRow({ fingerprint: 'fp', operationKey: 'op-key-2' })
    );
    bumpAuthEpoch();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- resolver assigned synchronously
    releaseFirst!();
    await Promise.all([first, second]);

    expect(kvMock.setItem).toHaveBeenCalledTimes(1);
    expect(inFlightSaveCount()).toBe(0);
  });
});

describe('corrupt read', () => {
  it('loads null and reports Sentry for a value that is not valid JSON', async () => {
    seedStoredValue('outbox:u1', 'fp', 'not-json{{{');
    await expect(loadOutboxRow('u1', 'fp')).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('loads null and reports Sentry for a shape mismatch', async () => {
    seedStoredValue('outbox:u1', 'fp', '{"taxonomy":"safe-retry","operationKey":"k"}');
    await expect(loadOutboxRow('u1', 'fp')).resolves.toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('write rejection boundary', () => {
  it('reports and swallows a failed write so the mutation is never blocked', async () => {
    kvMock.setItem.mockRejectedValueOnce(new Error('kv down'));
    await expect(writeOutboxRow('u1', safeRetryRow())).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('reports and swallows a failed remove', async () => {
    kvMock.removeItem.mockRejectedValueOnce(new Error('kv down'));
    await expect(removeOutboxRow('u1', 'fp')).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
