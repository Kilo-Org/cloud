import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteStoredValue,
  deleteStoredValueSafe,
  readStoredValue,
  readStoredValueForUpdate,
  readStoredValueSafe,
  writeStoredValue,
  writeStoredValueSafe,
} from '@/lib/auth/secure-store-value';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

const getItemAsync = vi.hoisted(() =>
  vi.fn<(key: string, options?: unknown) => Promise<string | null>>()
);
const setItemAsync = vi.hoisted(() =>
  vi.fn<(key: string, value: string, options?: unknown) => Promise<void>>()
);
const deleteItemAsync = vi.hoisted(() =>
  vi.fn<(key: string, options?: unknown) => Promise<void>>()
);

vi.mock('expo-secure-store', () => ({
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
}));

let events: TelemetryEvent[] = [];

beforeEach(() => {
  events = [];
  vi.clearAllMocks();
  setTelemetrySink(event => {
    events.push(event);
  });
});

afterEach(() => {
  setTelemetrySink(null);
});

/** The native failure shape under test: a rejecting call. Throwing inside the
 *  mock is the same rejection the guarded helper catches. */
function rejectedCall(message: string): never {
  throw new Error(message);
}

describe('readStoredValueSafe', () => {
  it('reads the stored value without reporting when the native read succeeds', async () => {
    getItemAsync.mockResolvedValue('stored-value');

    await expect(readStoredValueSafe('scope-key')).resolves.toBe('stored-value');
    expect(events).toHaveLength(0);
  });

  it('treats a rejected read as absent and reports one warning naming the read', async () => {
    getItemAsync.mockImplementation(() => rejectedCall('keychain unavailable'));

    await expect(readStoredValueSafe('scope-key')).resolves.toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'read']);
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'secure_store',
      'error.operation': 'read',
    });
  });

  it('never puts the key or the stored value in the reported event', async () => {
    getItemAsync.mockImplementation(() => rejectedCall('Calling getValueWithKeyAsync failed'));

    await readStoredValueSafe('auth-token');

    // The event carries the operation and the native cause only: no key name,
    // no credential, no stored value.
    expect(JSON.stringify(events[0])).not.toContain('auth-token');
  });
});

describe('readStoredValue', () => {
  it('keeps the credential contract: a rejected read still rejects', async () => {
    getItemAsync.mockImplementation(() => rejectedCall('keychain unavailable'));

    await expect(readStoredValue('auth-token')).rejects.toThrow('keychain unavailable');
    // The raw read is silent: the bounded-retry credential read reports once.
    expect(events).toHaveLength(0);
  });
});

describe('readStoredValueForUpdate', () => {
  it('returns the stored value without reporting when the native read succeeds', async () => {
    getItemAsync.mockResolvedValue('stored-value');

    await expect(readStoredValueForUpdate('viewed-key')).resolves.toEqual({
      status: 'value',
      value: 'stored-value',
    });
    expect(events).toHaveLength(0);
  });

  it('keeps "nothing stored" apart from a failed read', async () => {
    getItemAsync.mockResolvedValue(null);

    // A real "nothing stored" is a value, not an unreadable record, so a
    // read-modify-write can safely treat it as empty.
    await expect(readStoredValueForUpdate('viewed-key')).resolves.toEqual({
      status: 'value',
      value: null,
    });
    expect(events).toHaveLength(0);
  });

  it('reports one warning naming the read and resolves as unreadable', async () => {
    getItemAsync.mockImplementation(() => rejectedCall('keychain unavailable'));

    await expect(readStoredValueForUpdate('viewed-key')).resolves.toEqual({
      status: 'unreadable',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'read']);
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'secure_store',
      'error.operation': 'read',
    });
    // The key is never attached to the report.
    expect(JSON.stringify(events[0])).not.toContain('viewed-key');
  });
});

describe('writeStoredValueSafe', () => {
  it('returns true without reporting when the native write succeeds', async () => {
    setItemAsync.mockResolvedValue(undefined);

    await expect(writeStoredValueSafe('pref-key', 'value')).resolves.toBe(true);
    expect(events).toHaveLength(0);
  });

  it('treats a rejected write as recoverable and reports one warning naming the write', async () => {
    setItemAsync.mockImplementation(() => rejectedCall('Calling setValueWithKeyAsync failed'));

    await expect(writeStoredValueSafe('pref-key', 'value')).resolves.toBe(false);

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'write']);
    expect(events[0]?.tags).toEqual({
      'error.subsystem': 'secure_store',
      'error.operation': 'write',
    });
  });
});

describe('deleteStoredValueSafe', () => {
  it('treats a rejected delete as recoverable and reports one warning naming the delete', async () => {
    deleteItemAsync.mockImplementation(() => rejectedCall('keychain unavailable'));

    await expect(deleteStoredValueSafe('pref-key')).resolves.toBe(false);

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'delete']);
  });
});

describe('writeStoredValue and deleteStoredValue', () => {
  it('reports the credential write and still rejects so sign-in owns the outcome', async () => {
    setItemAsync.mockImplementation(() => rejectedCall('Calling setValueWithKeyAsync failed'));

    await expect(writeStoredValue('auth-token', 'credential')).rejects.toThrow(
      'Calling setValueWithKeyAsync failed'
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warning');
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'write']);
    // No credential material reaches the report.
    expect(JSON.stringify(events[0])).not.toContain('credential');
  });

  it('reports the delete and still rejects so the caller owns the outcome', async () => {
    deleteItemAsync.mockImplementation(() => rejectedCall('keychain unavailable'));

    await expect(deleteStoredValue('auth-token')).rejects.toThrow('keychain unavailable');

    expect(events).toHaveLength(1);
    expect(events[0]?.fingerprint).toEqual(['secure-store-failure', 'delete']);
  });
});
