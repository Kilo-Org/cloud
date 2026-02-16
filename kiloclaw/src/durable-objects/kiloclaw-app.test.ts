/**
 * Tests for KiloClawApp DO.
 *
 * Mocks cloudflare:workers and the fly/apps module.
 * Verifies idempotent app creation, IP allocation, alarm retry,
 * and destroy behavior.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// -- Mock cloudflare:workers --
vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {
    ctx: { storage: unknown };
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx as { storage: unknown };
      this.env = env;
    }
  },
}));

// -- Mock fly/apps --
vi.mock('../fly/apps', async () => {
  const { appNameFromUserId } = await vi.importActual('../fly/apps');
  return {
    appNameFromUserId,
    createApp: vi.fn().mockResolvedValue({ id: 'app-id', created_at: 1234567890 }),
    getApp: vi.fn().mockResolvedValue(null), // default: app doesn't exist yet
    deleteApp: vi.fn().mockResolvedValue(undefined),
    allocateIP: vi.fn().mockResolvedValue({ address: '::1', type: 'v6' }),
  };
});

import { KiloClawApp } from './kiloclaw-app';
import * as appsClient from '../fly/apps';
import { FlyApiError } from '../fly/client';

// ============================================================================
// Test harness
// ============================================================================

function createFakeStorage() {
  const store = new Map<string, unknown>();
  let alarmTime: number | null = null;

  return {
    get(keys: string[]): Map<string, unknown> {
      const result = new Map<string, unknown>();
      for (const k of keys) {
        if (store.has(k)) result.set(k, store.get(k));
      }
      return result;
    },
    put(entries: Record<string, unknown>): void {
      for (const [k, v] of Object.entries(entries)) {
        store.set(k, v);
      }
    },
    deleteAll(): void {
      store.clear();
      alarmTime = null;
    },
    setAlarm(time: number): void {
      alarmTime = time;
    },
    deleteAlarm(): void {
      alarmTime = null;
    },
    _store: store,
    _getAlarm: () => alarmTime,
  };
}

function createFakeEnv() {
  return {
    FLY_API_TOKEN: 'test-token',
    FLY_ORG_SLUG: 'test-org',
  };
}

function createAppDO(
  storage = createFakeStorage(),
  env = createFakeEnv()
): { appDO: KiloClawApp; storage: ReturnType<typeof createFakeStorage> } {
  const ctx = { storage } as unknown;
  const appDO = new KiloClawApp(
    ctx as ConstructorParameters<typeof KiloClawApp>[0],
    env as ConstructorParameters<typeof KiloClawApp>[1]
  );
  return { appDO, storage };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Reset default mock behaviors
  (appsClient.getApp as Mock).mockResolvedValue(null);
  (appsClient.createApp as Mock).mockResolvedValue({ id: 'app-id', created_at: 1234567890 });
  (appsClient.allocateIP as Mock).mockResolvedValue({ address: '::1', type: 'v6' });
});

describe('ensureApp', () => {
  it('creates app and allocates both IPs on first call', async () => {
    const { appDO, storage } = createAppDO();

    const result = await appDO.ensureApp('user-1');

    expect(result.appName).toMatch(/^acct-[0-9a-f]{20}$/);
    expect(appsClient.createApp).toHaveBeenCalledWith(
      { apiToken: 'test-token' },
      result.appName,
      'test-org'
    );
    expect(appsClient.allocateIP).toHaveBeenCalledTimes(2);
    expect(appsClient.allocateIP).toHaveBeenCalledWith('test-token', result.appName, 'v6');
    expect(appsClient.allocateIP).toHaveBeenCalledWith('test-token', result.appName, 'shared_v4');
    expect(storage._store.get('ipv4Allocated')).toBe(true);
    expect(storage._store.get('ipv6Allocated')).toBe(true);
  });

  it('skips creation if app already exists', async () => {
    (appsClient.getApp as Mock).mockResolvedValue({ id: 'existing', created_at: 100 });

    const { appDO } = createAppDO();
    await appDO.ensureApp('user-1');

    expect(appsClient.createApp).not.toHaveBeenCalled();
    expect(appsClient.allocateIP).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — second call is a no-op', async () => {
    const { appDO } = createAppDO();

    const result1 = await appDO.ensureApp('user-1');
    vi.clearAllMocks();
    const result2 = await appDO.ensureApp('user-1');

    expect(result1.appName).toBe(result2.appName);
    expect(appsClient.createApp).not.toHaveBeenCalled();
    expect(appsClient.getApp).not.toHaveBeenCalled();
    expect(appsClient.allocateIP).not.toHaveBeenCalled();
  });

  it('resumes from partial state — IPv6 done, IPv4 pending', async () => {
    const storage = createFakeStorage();
    storage._store.set('userId', 'user-1');
    storage._store.set('flyAppName', 'acct-test');
    storage._store.set('ipv6Allocated', true);
    storage._store.set('ipv4Allocated', false);

    // App already exists (since we already created it)
    (appsClient.getApp as Mock).mockResolvedValue({ id: 'existing', created_at: 100 });

    const { appDO } = createAppDO(storage);
    await appDO.ensureApp('user-1');

    // Should only allocate IPv4
    expect(appsClient.allocateIP).toHaveBeenCalledTimes(1);
    expect(appsClient.allocateIP).toHaveBeenCalledWith('test-token', 'acct-test', 'shared_v4');
  });

  it('arms retry alarm and rethrows on partial failure', async () => {
    // IPv6 allocation will fail
    (appsClient.allocateIP as Mock).mockRejectedValue(new FlyApiError('timeout', 503, 'retry'));

    const { appDO, storage } = createAppDO();

    await expect(appDO.ensureApp('user-1')).rejects.toThrow('timeout');

    // App name was persisted (partial state saved before failure)
    expect(storage._store.get('flyAppName')).toMatch(/^acct-/);
    // IPs NOT allocated
    expect(storage._store.get('ipv6Allocated')).not.toBe(true);
    expect(storage._store.get('ipv4Allocated')).not.toBe(true);
    // Retry alarm armed
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('arms retry alarm when IPv4 allocation fails after IPv6 succeeds', async () => {
    let callCount = 0;
    (appsClient.allocateIP as Mock).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ address: '::1', type: 'v6' });
      return Promise.reject(new FlyApiError('rate limit', 429, 'slow down'));
    });

    const { appDO, storage } = createAppDO();

    await expect(appDO.ensureApp('user-1')).rejects.toThrow('rate limit');

    // IPv6 was persisted, IPv4 was not
    expect(storage._store.get('ipv6Allocated')).toBe(true);
    expect(storage._store.get('ipv4Allocated')).not.toBe(true);
    // Retry alarm armed
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('uses dev- prefix when WORKER_ENV is development', async () => {
    const env = {
      FLY_API_TOKEN: 'test-token',
      FLY_ORG_SLUG: 'test-org',
      WORKER_ENV: 'development',
    };
    const { appDO } = createAppDO(createFakeStorage(), env);

    const result = await appDO.ensureApp('user-1');

    expect(result.appName).toMatch(/^dev-[0-9a-f]{20}$/);
  });

  it('uses acct- prefix when WORKER_ENV is not development', async () => {
    const env = { FLY_API_TOKEN: 'test-token', FLY_ORG_SLUG: 'test-org', WORKER_ENV: 'production' };
    const { appDO } = createAppDO(createFakeStorage(), env);

    const result = await appDO.ensureApp('user-1');

    expect(result.appName).toMatch(/^acct-[0-9a-f]{20}$/);
  });

  it('uses acct- prefix when WORKER_ENV is unset', async () => {
    const { appDO } = createAppDO();

    const result = await appDO.ensureApp('user-1');

    expect(result.appName).toMatch(/^acct-[0-9a-f]{20}$/);
  });

  it('throws when FLY_API_TOKEN is missing', async () => {
    const { appDO } = createAppDO(createFakeStorage(), { FLY_API_TOKEN: '', FLY_ORG_SLUG: 'org' });
    await expect(appDO.ensureApp('user-1')).rejects.toThrow('FLY_API_TOKEN is not configured');
  });

  it('throws when FLY_ORG_SLUG is missing', async () => {
    const { appDO } = createAppDO(createFakeStorage(), { FLY_API_TOKEN: 'tok', FLY_ORG_SLUG: '' });
    await expect(appDO.ensureApp('user-1')).rejects.toThrow('FLY_ORG_SLUG is not configured');
  });
});

describe('getAppName', () => {
  it('returns null when no app has been created', async () => {
    const { appDO } = createAppDO();
    expect(await appDO.getAppName()).toBeNull();
  });

  it('returns the app name after ensureApp', async () => {
    const { appDO } = createAppDO();
    const { appName } = await appDO.ensureApp('user-1');
    expect(await appDO.getAppName()).toBe(appName);
  });
});

describe('destroyApp', () => {
  it('deletes the Fly app and clears all state', async () => {
    const { appDO, storage } = createAppDO();
    await appDO.ensureApp('user-1');

    await appDO.destroyApp();

    expect(appsClient.deleteApp).toHaveBeenCalled();
    expect(storage._store.size).toBe(0);
    expect(await appDO.getAppName()).toBeNull();
  });

  it('is a no-op when no app exists', async () => {
    const { appDO } = createAppDO();
    await appDO.destroyApp();
    expect(appsClient.deleteApp).not.toHaveBeenCalled();
  });
});

describe('alarm retry', () => {
  it('retries incomplete IP allocation on alarm', async () => {
    const storage = createFakeStorage();
    storage._store.set('userId', 'user-1');
    storage._store.set('flyAppName', 'acct-test');
    storage._store.set('ipv6Allocated', true);
    storage._store.set('ipv4Allocated', false);

    // App exists
    (appsClient.getApp as Mock).mockResolvedValue({ id: 'existing', created_at: 100 });

    const { appDO } = createAppDO(storage);
    await appDO.alarm();

    expect(appsClient.allocateIP).toHaveBeenCalledWith('test-token', 'acct-test', 'shared_v4');
    expect(storage._store.get('ipv4Allocated')).toBe(true);
  });

  it('reschedules alarm if retry fails', async () => {
    const storage = createFakeStorage();
    storage._store.set('userId', 'user-1');
    storage._store.set('flyAppName', 'acct-test');
    storage._store.set('ipv6Allocated', false);
    storage._store.set('ipv4Allocated', false);

    (appsClient.getApp as Mock).mockRejectedValue(new FlyApiError('timeout', 503, 'retry'));

    const { appDO } = createAppDO(storage);
    await appDO.alarm();

    expect(storage._getAlarm()).not.toBeNull();
  });

  it('does nothing on alarm when fully set up', async () => {
    const storage = createFakeStorage();
    storage._store.set('userId', 'user-1');
    storage._store.set('flyAppName', 'acct-test');
    storage._store.set('ipv6Allocated', true);
    storage._store.set('ipv4Allocated', true);

    const { appDO } = createAppDO(storage);
    await appDO.alarm();

    expect(appsClient.getApp).not.toHaveBeenCalled();
    expect(appsClient.allocateIP).not.toHaveBeenCalled();
  });
});
