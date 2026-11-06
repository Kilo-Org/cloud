import { describe, expect, it } from 'vitest';
import {
  KILO_CLI_VERSION_HEADER,
  WRAPPER_VERSION_HEADER,
} from '../../shared/control-plane-runtime-contract.js';
import {
  readObservedRuntimeVersions,
  readRuntimeIdentity,
  resetRuntimeIdentity,
  RUNTIME_IDENTITY_KEY,
  writeRuntimeIdentity,
} from './runtime-identity.js';

function storage(values = new Map<string, unknown>()) {
  return {
    values,
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: (key: string) => values.delete(key),
  };
}

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('allocation runtime identity', () => {
  it('keeps only bounded versions from upgrade headers', () => {
    expect(
      readObservedRuntimeVersions(
        headers({
          [KILO_CLI_VERSION_HEADER]: '7.4.20',
          [WRAPPER_VERSION_HEADER]: '2.4.0-rc.1',
        })
      )
    ).toEqual({ kiloCliVersion: '7.4.20', wrapperVersion: '2.4.0-rc.1' });

    expect(
      readObservedRuntimeVersions(
        headers({
          [KILO_CLI_VERSION_HEADER]: '7.4.20+PRIVATE_SENTINEL',
          [WRAPPER_VERSION_HEADER]: 'not-a-version',
        })
      )
    ).toEqual({ kiloCliVersion: null, wrapperVersion: null });

    expect(readObservedRuntimeVersions(headers({}))).toEqual({
      kiloCliVersion: null,
      wrapperVersion: null,
    });
  });

  it('persists and reads identity for the matching allocation only', () => {
    const store = storage();
    writeRuntimeIdentity(store, 'allocation-1', {
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
    });

    expect(readRuntimeIdentity(store, 'allocation-1')).toEqual({
      allocationId: 'allocation-1',
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
    });
    expect(readRuntimeIdentity(store, 'allocation-2')).toBeNull();
    expect(readRuntimeIdentity(store, null)).toBeNull();

    const reloaded = storage(structuredClone(store.values));
    expect(readRuntimeIdentity(reloaded, 'allocation-1')?.wrapperVersion).toBe('2.4.0');
  });

  it('does not clear a previously observed version when a reconnect omits headers', () => {
    const store = storage();
    writeRuntimeIdentity(store, 'allocation-1', {
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
    });

    writeRuntimeIdentity(store, 'allocation-1', {
      kiloCliVersion: '7.5.0',
      wrapperVersion: null,
    });
    expect(readRuntimeIdentity(store, 'allocation-1')).toMatchObject({
      kiloCliVersion: '7.5.0',
      wrapperVersion: '2.4.0',
    });

    writeRuntimeIdentity(store, 'allocation-1', {
      kiloCliVersion: null,
      wrapperVersion: null,
    });
    expect(readRuntimeIdentity(store, 'allocation-1')).toMatchObject({
      kiloCliVersion: '7.5.0',
      wrapperVersion: '2.4.0',
    });
  });

  it('resets identity for a new allocation', () => {
    const store = storage();
    writeRuntimeIdentity(store, 'allocation-1', {
      kiloCliVersion: '7.4.20',
      wrapperVersion: '2.4.0',
    });
    resetRuntimeIdentity(store);

    expect(store.values.has(RUNTIME_IDENTITY_KEY)).toBe(false);
    expect(readRuntimeIdentity(store, 'allocation-1')).toBeNull();
  });

  it('ignores malformed stored identity', () => {
    const store = storage();
    store.put(RUNTIME_IDENTITY_KEY, {
      allocationId: 'allocation-1',
      kiloCliVersion: 'PRIVATE_SENTINEL',
      wrapperVersion: '2.4.0',
    });
    expect(readRuntimeIdentity(store, 'allocation-1')).toEqual({
      allocationId: 'allocation-1',
      kiloCliVersion: null,
      wrapperVersion: '2.4.0',
    });
  });
});
