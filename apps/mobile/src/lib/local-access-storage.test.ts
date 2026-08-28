import { describe, expect, it, vi } from 'vitest';
import { type SecureStoreOptions } from 'expo-secure-store';

import { createLocalAccessStorage, localAccessStorageKey } from './local-access-storage';
import { AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from './storage-keys';

vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6 }));

function memoryStore() {
  const bytes = new Map<string, string>();
  const store = {
    getItemAsync: vi.fn(async (key: string, options?: SecureStoreOptions) => {
      if (options?.requireAuthentication) {
        throw new Error('Unexpected biometric read');
      }
      const result = await Promise.resolve(bytes.get(key) ?? null);
      return result;
    }),
    setItemAsync: vi.fn(async (key: string, value: string, options?: SecureStoreOptions) => {
      if (options?.requireAuthentication) {
        throw new Error('Unexpected biometric record');
      }
      await Promise.resolve();
      bytes.set(key, value);
    }),
  };
  return { bytes, store, storage: createLocalAccessStorage(store) };
}

describe('account-owned security records', () => {
  it.each([
    [null, { status: 'absent' }],
    ['{"version":1,"enabled":true}', { status: 'present', enabled: true }],
    ['{"version":1,"enabled":false}', { status: 'present', enabled: false }],
  ] as const)('reads confirmed state %s', async (value, expected) => {
    const { bytes, storage } = memoryStore();
    if (value !== null) {
      bytes.set(localAccessStorageKey('A'), value);
    }
    expect(await storage.read('A')).toEqual(expected);
  });

  it.each([
    '',
    '{',
    'null',
    'false',
    '42',
    '[]',
    '{}',
    '{"version":0,"enabled":true}',
    '{"version":2,"enabled":false}',
    '{"version":"1","enabled":true}',
    '{"enabled":true}',
    '{"version":1}',
    '{"version":1,"enabled":"false"}',
    '{"version":1,"enabled":null}',
    '{"version":1,"enabled":false,"extra":true}',
  ])('protects malformed bytes without replacing them: %s', async value => {
    const { bytes, storage } = memoryStore();
    bytes.set(localAccessStorageKey('A'), value);
    expect(await storage.read('A')).toEqual({ status: 'malformed' });
    expect(bytes.get(localAccessStorageKey('A'))).toBe(value);
  });

  it('distinguishes failed reads and permits a nondestructive retry', async () => {
    const { bytes, store, storage } = memoryStore();
    bytes.set(localAccessStorageKey('A'), '{"version":1,"enabled":true}');
    store.getItemAsync.mockRejectedValueOnce(new Error('Storage unavailable'));
    expect(await storage.read('A')).toEqual({ status: 'failed' });
    expect(await storage.read('A')).toEqual({ status: 'present', enabled: true });
  });

  it('isolates arbitrary account IDs and leaves existing credentials unchanged', async () => {
    const { bytes, storage } = memoryStore();
    const credentials = new Map([
      [AUTH_TOKEN_KEY, 'bearer'],
      [REFRESH_TOKEN_KEY, 'refresh'],
      [TOKEN_EXPIRES_AT_KEY, '123'],
    ]);
    for (const [key, value] of credentials) {
      bytes.set(key, value);
    }
    const users = ['a:b', 'a_b', 'a.b', 'a/b', 'a%2Fb', 'å', 'a', '61'];
    const writes = await Promise.all(
      users.map(async (user, index) => {
        const result = await storage.write(user, index % 2 === 0, () => true);
        return result;
      })
    );
    expect(writes).toEqual(users.map(() => 'committed'));
    const restored = await Promise.all(
      users.map(async user => {
        const result = await storage.read(user);
        return result;
      })
    );
    for (const [index, record] of restored.entries()) {
      expect(record).toEqual({ status: 'present', enabled: index % 2 === 0 });
    }
    for (const [key, value] of credentials) {
      expect(bytes.get(key)).toBe(value);
    }
    expect(bytes.size).toBe(users.length + credentials.size);
  });

  it('returns failed writes and preserves the last stored value', async () => {
    const { store, storage } = memoryStore();
    await storage.write('A', true, () => true);
    store.setItemAsync.mockRejectedValueOnce(new Error('Write failed'));
    expect(await storage.write('A', false, () => true)).toBe('failed');
    expect(await storage.read('A')).toEqual({ status: 'present', enabled: true });
    expect(await storage.write('A', false, () => true)).toBe('committed');
    expect(await storage.read('A')).toEqual({ status: 'present', enabled: false });
  });

  it('serializes an account and skips a stale queued write without claiming commit', async () => {
    const { bytes, store, storage } = memoryStore();
    const release = Promise.withResolvers<undefined>();
    store.setItemAsync.mockImplementationOnce(async (key, value) => {
      await release.promise;
      bytes.set(key, value);
    });
    const first = storage.write('A', true, () => true);
    let current = true;
    const second = storage.write('A', false, () => current);
    current = false;
    release.resolve(undefined);
    expect(await first).toBe('committed');
    expect(await second).toBe('stale');
    expect(await storage.read('A')).toEqual({ status: 'present', enabled: true });
  });

  it('reports an already-started stale write and never retargets it to another account', async () => {
    const { bytes, store, storage } = memoryStore();
    const release = Promise.withResolvers<undefined>();
    store.setItemAsync.mockImplementationOnce(async (key, value) => {
      await release.promise;
      bytes.set(key, value);
    });
    let current = true;
    const pending = storage.write('A', true, () => current);
    current = false;
    expect(await storage.write('B', false, () => true)).toBe('committed');
    release.resolve(undefined);
    expect(await pending).toBe('stale');
    expect(await storage.read('A')).toEqual({ status: 'present', enabled: true });
    expect(await storage.read('B')).toEqual({ status: 'present', enabled: false });
  });

  it('orders re-entry reads behind writes and commits later writes last', async () => {
    const { bytes, store, storage } = memoryStore();
    const release = Promise.withResolvers<undefined>();
    store.setItemAsync.mockImplementationOnce(async (key, value) => {
      await release.promise;
      bytes.set(key, value);
    });
    const first = storage.write('A', true, () => true);
    const read = storage.read('A');
    const second = storage.write('A', false, () => true);
    release.resolve(undefined);
    expect(await first).toBe('committed');
    expect(await read).toEqual({ status: 'present', enabled: true });
    expect(await second).toBe('committed');
    expect(await storage.read('A')).toEqual({ status: 'present', enabled: false });
  });
});
