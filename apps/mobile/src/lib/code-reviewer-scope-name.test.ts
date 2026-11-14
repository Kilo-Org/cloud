// The remembered scope names are what titles a Code Reviewer header after the
// reader loses the membership, so the store must hold the newest names, survive
// a restart, and never hand one account's names to another.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Fake SecureStore surface backed by an in-memory Map, injected through the
// test-only setter so the durable mirror never loads the real native module.
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

function persistedRecord(entries: readonly { organizationId: string; organizationName: string }[]) {
  return JSON.stringify({
    version: 1,
    userId: 'u1',
    entries: entries.map((entry, index) => ({ ...entry, seenAt: 1_700_000_000_000 - index })),
  });
}

beforeEach(() => {
  _resetScopeNamesForTests();
  _setSecureStoreForTests(secureStoreMock);
  store.clear();
  vi.clearAllMocks();
});

afterEach(async () => {
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
    const record = JSON.parse(store.get(REVIEWER_SCOPE_NAMES_KEY) ?? '{}') as {
      entries: { organizationId: string }[];
    };
    expect(record.entries).toHaveLength(20);
    expect(record.entries[0].organizationId).toBe('org-20');
    expect(record.entries[19].organizationId).toBe('org-1');
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

    store.set(
      REVIEWER_SCOPE_NAMES_KEY,
      JSON.stringify({
        version: 2,
        userId: 'u1',
        entries: [{ organizationId: 'org-labs', organizationName: 'Drain Labs', seenAt: 1 }],
      })
    );
    await _hydrateScopeNamesForTests();
    expect(readScopeName('org-labs')).toBeUndefined();
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
