import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as TrustedHostsModule from './use-trusted-hosts';
import {
  clearTrustedHosts,
  isTrustedHost,
  parseTrustedHosts,
  revokeHost,
  trustHost,
} from './use-trusted-hosts';

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

// The store is a module-level singleton that latches its one disk read, so a
// fresh module graph gives a truly cold store whose preload-then-read can be
// exercised end to end.
async function freshTrustedHosts(): Promise<typeof TrustedHostsModule> {
  vi.resetModules();
  const mod = import('./use-trusted-hosts');
  await Promise.resolve();
  return mod;
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  captureException.mockReset();
  toastError.mockReset();
  clearTrustedHosts();
});

describe('parseTrustedHosts', () => {
  it('parses a JSON string array', () => {
    expect(parseTrustedHosts('["a.com","b.com:8080"]')).toEqual(['a.com', 'b.com:8080']);
  });

  it('returns an empty list for null', () => {
    expect(parseTrustedHosts(null)).toEqual([]);
  });

  it('returns an empty list for malformed JSON', () => {
    expect(parseTrustedHosts('not json')).toEqual([]);
  });

  it('returns an empty list for a non-array value', () => {
    expect(parseTrustedHosts('{"a":1}')).toEqual([]);
  });

  it('filters out non-string entries', () => {
    expect(parseTrustedHosts('["a.com", 1, true, null]')).toEqual(['a.com']);
  });
});

describe('trusted host store', () => {
  it('trusting a host serializes the JSON array and dedupes', async () => {
    trustHost('a.com');
    trustHost('b.com');
    trustHost('a.com');

    expect(isTrustedHost('a.com')).toBe(true);
    expect(isTrustedHost('b.com')).toBe(true);
    expect(isTrustedHost('c.com')).toBe(false);

    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('trusted-hosts', '["a.com","b.com"]');
  });

  it('revokes one host and keeps the others', async () => {
    trustHost('a.com');
    trustHost('b.com');
    await flushMicrotasks();

    revokeHost('a.com');

    expect(isTrustedHost('a.com')).toBe(false);
    expect(isTrustedHost('b.com')).toBe(true);

    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith('trusted-hosts', '["b.com"]');
  });

  it('clears every trusted host and deletes the key', async () => {
    trustHost('a.com');
    await flushMicrotasks();

    clearTrustedHosts();

    expect(isTrustedHost('a.com')).toBe(false);

    await flushMicrotasks();
    expect(deleteItemAsync).toHaveBeenCalledWith('trusted-hosts');
  });

  it('merges a Trust write with the pre-loaded persisted list', async () => {
    // A cold store reads this list on import and must preserve it when a new
    // host is trusted later.
    getItemAsync.mockResolvedValue('["existing.com"]');
    const mod = await freshTrustedHosts();

    // The module-scope preload resolved the persisted list.
    await flushMicrotasks();
    expect(mod.getTrustedHostsHasLoaded()).toBe(true);
    expect(mod.isTrustedHost('existing.com')).toBe(true);

    mod.trustHost('new.com');

    expect(mod.isTrustedHost('existing.com')).toBe(true);
    expect(mod.isTrustedHost('new.com')).toBe(true);

    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenLastCalledWith(
      'trusted-hosts',
      JSON.stringify(['existing.com', 'new.com'])
    );
  });
});
