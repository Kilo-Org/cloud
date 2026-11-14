// The remembered scope names are what titles a Code Reviewer header after the
// reader loses the membership, so the store must hold the newest names, survive
// a restart, and never hand one account's names to another.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ACTIVE_USER_ID_KEY, REVIEWER_SCOPE_NAMES_KEY } from '@/lib/storage-keys';

import {
  _flushScopeNameWritesForTests,
  _hydrateScopeNamesForTests,
  _resetScopeNamesForTests,
  _setSecureStoreForTests,
  clearScopeNames,
  hydrateScopeNames,
  readScopeName,
  rememberScopeName,
  subscribeScopeNames,
} from './code-reviewer-scope-name';

const store = new Map<string, string>();

// Controls the record read: one case holds it open so the account boundary can
// land mid-read, another refuses it once the way a locked device does.
const recordRead = {
  gate: null as null | { reached: () => void; released: Promise<void>; release: () => void },
  failures: 0,
};

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    if (key === REVIEWER_SCOPE_NAMES_KEY) {
      // The bytes are captured when the read starts, like a native read that
      // resolves with what the keychain held before a later delete.
      const captured = store.get(key) ?? null;
      const gate = recordRead.gate;
      if (gate !== null) {
        recordRead.gate = null;
        gate.reached();
        await gate.released;
        return captured;
      }
      if (recordRead.failures > 0) {
        recordRead.failures -= 1;
        throw new Error('the keychain refused the record read');
      }
      return captured;
    }
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

/**
 * A promise a case resolves by hand, so a test can wait for something without
 * guessing at a delay.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let storedResolve: (() => void) | undefined = undefined;
  const promise = new Promise<void>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      storedResolve?.();
    },
  };
}

/**
 * Hold the next record read open, so a case can run the account boundary while
 * a restart read is in flight without guessing at a delay.
 */
function holdRecordRead(): { reached: Promise<void>; release: () => void } {
  const reached = deferred();
  const released = deferred();
  recordRead.gate = {
    reached: () => {
      reached.resolve();
    },
    released: released.promise,
    release: () => {
      released.resolve();
    },
  };
  return {
    reached: reached.promise,
    release: () => {
      recordRead.gate = null;
      released.resolve();
    },
  };
}

function persistedRecord(entries: readonly { organizationId: string; organizationName: string }[]) {
  return JSON.stringify({
    version: 1,
    userId: 'u1',
    entries: entries.map((entry, index) => ({ ...entry, seenAt: 1_700_000_000_000 - index })),
  });
}

/**
 * The mirrored record read back through a schema rather than a cast: a test
 * that inspects device data fails on a shape change with a message instead of
 * reading an undefined entry.
 */
const mirroredRecordSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  entries: z.array(
    z.object({
      organizationId: z.string().min(1),
      organizationName: z.string().min(1),
      seenAt: z.number(),
    })
  ),
});

type MirroredRecord = z.infer<typeof mirroredRecordSchema>;

function mirroredRecord(): MirroredRecord {
  const raw = store.get(REVIEWER_SCOPE_NAMES_KEY);
  if (raw === undefined) {
    throw new Error('the record was not mirrored');
  }
  const parsed = mirroredRecordSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`the mirrored record does not match: ${parsed.error.message}`);
  }
  return parsed.data;
}

function entryAt(record: MirroredRecord, index: number): MirroredRecord['entries'][number] {
  const entry = record.entries[index];
  if (entry === undefined) {
    throw new Error(`the mirrored record has no entry at index ${index}`);
  }
  return entry;
}

beforeEach(() => {
  _resetScopeNamesForTests();
  _setSecureStoreForTests(secureStoreMock);
  store.clear();
  recordRead.gate = null;
  recordRead.failures = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  recordRead.gate?.release();
  recordRead.gate = null;
  await _flushScopeNameWritesForTests();
  _resetScopeNamesForTests();
  store.clear();
});

describe('remembered scope names', () => {
  it('remembers a name for its own scope and mirrors the record for its account', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');

    rememberScopeName('org-labs', 'Drain Labs');

    expect(readScopeName('org-labs')).toBe('Drain Labs');
    expect(readScopeName('org-other')).toBeUndefined();

    await _flushScopeNameWritesForTests();
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStoreMock.setItemAsync.mock.calls[0]?.[0]).toBe(REVIEWER_SCOPE_NAMES_KEY);
    expect(JSON.parse(secureStoreMock.setItemAsync.mock.calls[0]?.[1] ?? '')).toEqual({
      version: 1,
      userId: 'u1',
      entries: [
        { organizationId: 'org-labs', organizationName: 'Drain Labs', seenAt: expect.any(Number) },
      ],
    });
  });

  it('survives a reload from the persisted record', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    rememberScopeName('org-labs', 'Drain Labs');
    rememberScopeName('org-gone', 'Drain Labs EU');
    await _flushScopeNameWritesForTests();

    // A fresh process: the map starts empty and the restart read fills it.
    _resetScopeNamesForTests();
    _setSecureStoreForTests(secureStoreMock);
    expect(readScopeName('org-labs')).toBeUndefined();

    await _hydrateScopeNamesForTests();

    expect(readScopeName('org-labs')).toBe('Drain Labs');
    expect(readScopeName('org-gone')).toBe('Drain Labs EU');
  });

  it('caps the record at the newest twenty names', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    for (let index = 0; index <= 20; index += 1) {
      rememberScopeName(`org-${index}`, `Organization ${index}`);
    }

    expect(readScopeName('org-0')).toBeUndefined();
    expect(readScopeName('org-1')).toBe('Organization 1');
    expect(readScopeName('org-20')).toBe('Organization 20');

    await _flushScopeNameWritesForTests();
    const record = mirroredRecord();
    expect(record.entries).toHaveLength(20);
    expect(entryAt(record, 0).organizationId).toBe('org-20');
    expect(entryAt(record, 19).organizationId).toBe('org-1');
  });

  it('ignores a record written for another account', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u2');
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      persistedRecord([{ organizationId: 'org-labs', organizationName: 'Drain Labs' }])
    );

    await _hydrateScopeNamesForTests();

    expect(readScopeName('org-labs')).toBeUndefined();
  });

  it('discards a corrupt or unknown-version record', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    store.set(REVIEWER_SCOPE_NAMES_KEY, '{"version":1,');
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-labs')).toBeUndefined();

    // The first read committed `u1`, so the second half names another active
    // account: otherwise the same-account short-circuit keeps the `version: 2`
    // record from ever reaching the check this case is about.
    store.set(ACTIVE_USER_ID_KEY, 'u2');
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      JSON.stringify({
        version: 2,
        userId: 'u2',
        entries: [{ organizationId: 'org-labs', organizationName: 'Drain Labs', seenAt: 1 }],
      })
    );
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-labs')).toBeUndefined();
  });

  it('keeps the account uncommitted when the record read is refused', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      persistedRecord([{ organizationId: 'org-labs', organizationName: 'Drain Labs' }])
    );

    recordRead.failures = 1;
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-labs')).toBeUndefined();

    // A committed account would short-circuit this read; it must reach the
    // record the refusal never returned.
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-labs')).toBe('Drain Labs');
  });

  it('writes the whole record when a remember follows a refused read', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      persistedRecord([{ organizationId: 'org-labs', organizationName: 'Drain Labs' }])
    );

    recordRead.failures = 1;
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-labs')).toBeUndefined();

    rememberScopeName('org-new', 'New Labs');
    await _flushScopeNameWritesForTests();

    // The write waited on a read that succeeded — the refusal committed
    // nothing — so the record carries the name the refused read missed instead
    // of a map that never saw it.
    expect(mirroredRecord().entries.map(entry => entry.organizationId)).toEqual([
      'org-new',
      'org-labs',
    ]);
    expect(readScopeName('org-labs')).toBe('Drain Labs');
    expect(readScopeName('org-new')).toBe('New Labs');
  });

  it('drops a restart read that races the account boundary', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      persistedRecord([{ organizationId: 'org-labs', organizationName: 'Drain Labs' }])
    );
    const read = holdRecordRead();

    const hydration = hydrateScopeNames();
    await read.reached;

    clearScopeNames();
    read.release();
    await hydration;

    expect(readScopeName('org-labs')).toBeUndefined();
    await _flushScopeNameWritesForTests();
    expect(store.has(REVIEWER_SCOPE_NAMES_KEY)).toBe(false);

    // The raced read committed no account either: a record that arrives after
    // the boundary is read on the next hydrate instead of being skipped.
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      persistedRecord([{ organizationId: 'org-two', organizationName: 'Drain Labs EU' }])
    );
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-two')).toBe('Drain Labs EU');
  });

  it('re-renders a subscriber once the restart read lands', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      persistedRecord([{ organizationId: 'org-labs', organizationName: 'Drain Labs' }])
    );
    const listener = vi.fn<() => void>();

    const unsubscribe = subscribeScopeNames(listener);
    await hydrateScopeNames();

    expect(listener).toHaveBeenCalled();
    expect(readScopeName('org-labs')).toBe('Drain Labs');
    unsubscribe();
  });

  it('drops the names and the persisted record at an account boundary', async () => {
    store.set(ACTIVE_USER_ID_KEY, 'u1');
    rememberScopeName('org-labs', 'Drain Labs');
    await _flushScopeNameWritesForTests();
    expect(store.get(REVIEWER_SCOPE_NAMES_KEY)).toBeDefined();

    clearScopeNames();

    expect(readScopeName('org-labs')).toBeUndefined();
    await _flushScopeNameWritesForTests();
    expect(store.has(REVIEWER_SCOPE_NAMES_KEY)).toBe(false);
  });
});
