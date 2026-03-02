/**
 * Tests for KiloClawInstance DO.
 *
 * Since DurableObject isn't available in node, we mock cloudflare:workers
 * and provide a fake storage. We also mock the fly client so no real
 * API calls are made.
 *
 * The tests exercise the DO's public methods and verify that:
 * - Two-phase destroy keeps IDs on Fly failure
 * - Alarm reconciliation fixes drift
 * - Status guards reject operations during destroying
 * - Alarm cadence varies by status
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// -- Mock cloudflare:workers --
// Must be before the DO import so vitest hoists it.
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

// -- Mock fly client --
// Keep real isFlyNotFound, isFlyInsufficientResources + FlyApiError; mock all API functions.
vi.mock('../fly/client', async () => {
  const { FlyApiError, isFlyNotFound, isFlyInsufficientResources } =
    await vi.importActual('../fly/client');
  return {
    FlyApiError,
    isFlyNotFound,
    isFlyInsufficientResources,
    createMachine: vi.fn(),
    getMachine: vi.fn(),
    startMachine: vi.fn(),
    stopMachine: vi.fn(),
    stopMachineAndWait: vi.fn(),
    destroyMachine: vi.fn(),
    waitForState: vi.fn(),
    updateMachine: vi.fn(),
    createVolume: vi.fn(),
    createVolumeWithFallback: vi.fn(),
    deleteVolume: vi.fn(),
    getVolume: vi.fn(),
    listMachines: vi.fn().mockResolvedValue([]),
    listVolumeSnapshots: vi.fn().mockResolvedValue([]),
    execCommand: vi.fn(),
  };
});

// -- Mock image-version --
vi.mock('../lib/image-version', async () => {
  const actual = await vi.importActual('../lib/image-version');
  return {
    ...actual,
    resolveLatestVersion: vi.fn().mockResolvedValue(null),
  };
});

// -- Mock db --
vi.mock('../db', () => ({
  getWorkerDb: vi.fn(() => ({})),
  getActiveInstance: vi.fn().mockResolvedValue(null),
  markInstanceDestroyed: vi.fn().mockResolvedValue(undefined),
}));

// -- Mock gateway/env --
vi.mock('../gateway/env', () => ({
  buildEnvVars: vi.fn().mockResolvedValue({
    env: { AUTO_APPROVE_DEVICES: 'true' },
    sensitive: { KILOCODE_API_KEY: 'test', OPENCLAW_GATEWAY_TOKEN: 'gw-token' },
  }),
}));

// -- Mock utils/env-encryption --
vi.mock('../utils/env-encryption', () => ({
  ENCRYPTED_ENV_PREFIX: 'KILOCLAW_ENC_',
  encryptEnvValue: vi.fn((_key: string, value: string) => `enc:v1:fake_${value}`),
}));

import { KiloClawInstance } from './kiloclaw-instance';
import * as flyClient from '../fly/client';
import { FlyApiError } from '../fly/client';
import * as db from '../db';
import { resolveLatestVersion } from '../lib/image-version';
import {
  ALARM_INTERVAL_RUNNING_MS,
  ALARM_INTERVAL_DESTROYING_MS,
  ALARM_INTERVAL_IDLE_MS,
  ALARM_JITTER_MS,
  SELF_HEAL_THRESHOLD,
  STALE_PROVISION_THRESHOLD_MS,
} from '../config';

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
    // Test helpers
    _store: store,
    _getAlarm: () => alarmTime,
  };
}

function createFakeAppStub() {
  return {
    ensureApp: vi.fn().mockResolvedValue({ appName: 'claw-user-1' }),
    ensureEnvKey: vi.fn().mockResolvedValue({
      key: 'dGVzdC1rZXktMzItYnl0ZXMtcGFkZGVkLi4uLg==',
      secretsVersion: 1,
    }),
  };
}

function createFakeEnv() {
  const appStub = createFakeAppStub();
  return {
    FLY_API_TOKEN: 'test-token',
    FLY_APP_NAME: 'test-app',
    FLY_REGION: 'us,eu',
    GATEWAY_TOKEN_SECRET: 'test-secret',
    KILOCLAW_INSTANCE: {} as unknown,
    KILOCLAW_APP: {
      idFromName: vi.fn().mockReturnValue('fake-do-id'),
      get: vi.fn().mockReturnValue(appStub),
    } as unknown,
    HYPERDRIVE: { connectionString: '' } as unknown,
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown,
  };
}

function createInstance(
  storage = createFakeStorage(),
  env = createFakeEnv()
): {
  instance: KiloClawInstance;
  storage: ReturnType<typeof createFakeStorage>;
  waitUntilPromises: Promise<unknown>[];
} {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    storage,
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
  } as unknown;
  const instance = new KiloClawInstance(
    ctx as ConstructorParameters<typeof KiloClawInstance>[0],
    env as ConstructorParameters<typeof KiloClawInstance>[1]
  );
  return { instance, storage, waitUntilPromises };
}

/** Seed DO storage with a provisioned instance and trigger loadState. */
async function seedProvisioned(
  storage: ReturnType<typeof createFakeStorage>,
  overrides: Record<string, unknown> = {}
) {
  const defaults: Record<string, unknown> = {
    userId: 'user-1',
    sandboxId: 'sandbox-1',
    status: 'provisioned',
    flyVolumeId: 'vol-1',
    flyRegion: 'iad',
    provisionedAt: Date.now(),
    healthCheckFailCount: 0,
    pendingDestroyMachineId: null,
    pendingDestroyVolumeId: null,
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    storage._store.set(k, v);
  }
}

async function seedRunning(
  storage: ReturnType<typeof createFakeStorage>,
  overrides: Record<string, unknown> = {}
) {
  await seedProvisioned(storage, {
    status: 'running',
    flyMachineId: 'machine-1',
    lastStartedAt: Date.now(),
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Mock global fetch for waitForHealthy() health probe.
  // Returns gateway running + root 200 so start() doesn't block.
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/_kilo/gateway/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ state: 'running' }),
        });
      }
      // Root path probe — return non-502
      return Promise.resolve({ ok: true, status: 200 });
    })
  );
});

describe('two-phase destroy', () => {
  it('clears all state when both Fly deletes succeed', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.destroy();

    // Storage fully cleared
    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });

  it('keeps pendingDestroyMachineId when machine delete fails', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.destroyMachine as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'fail')
    );
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.destroy();

    // Storage NOT cleared — pending machine ID preserved
    expect(storage._store.get('pendingDestroyMachineId')).toBe('machine-1');
    expect(storage._store.get('pendingDestroyVolumeId')).toBeNull();
    expect(storage._store.get('status')).toBe('destroying');
    // Alarm scheduled for retry
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('keeps pendingDestroyVolumeId when volume delete fails', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'fail')
    );

    await instance.destroy();

    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('vol-1');
    expect(storage._store.get('status')).toBe('destroying');
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('treats 404 as success (resource already gone)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.destroyMachine as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.deleteVolume as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));

    await instance.destroy();

    // Both treated as success → full cleanup
    expect(storage._store.size).toBe(0);
  });

  it('alarm retries pending destroy to completion', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: 'machine-1',
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: 'machine-1',
      pendingDestroyVolumeId: 'vol-1',
    });

    // First alarm: machine delete succeeds, volume still fails
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockRejectedValue(new FlyApiError('timeout', 503, 'retry'));

    await instance.alarm();

    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('vol-1');
    expect(storage._store.size).toBeGreaterThan(0); // NOT cleared

    // Second alarm: volume delete now succeeds
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    // Need a fresh instance to re-loadState from storage
    const { instance: inst2 } = createInstance(storage);
    await inst2.alarm();

    // Now fully cleaned up
    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });
});

describe('reconciliation: machine status sync', () => {
  it('syncs DO status from running to stopped after threshold failures', async () => {
    const { storage } = createInstance();
    await seedRunning(storage);

    // Machine reports stopped
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    // Need SELF_HEAL_THRESHOLD consecutive alarms
    for (let i = 0; i < SELF_HEAL_THRESHOLD; i++) {
      const { instance: inst } = createInstance(storage);
      await inst.alarm();
    }

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('healthCheckFailCount')).toBe(0);
  });

  it('resets fail count when machine is healthy', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { healthCheckFailCount: 3 });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('healthCheckFailCount')).toBe(0);
  });
});

describe('reconciliation: missing machine (404)', () => {
  it('clears stale machineId and marks stopped', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('flyMachineId')).toBeNull();
    expect(storage._store.get('status')).toBe('stopped');
  });
});

describe('reconciliation: volume', () => {
  it('creates volume when flyVolumeId is null', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyVolumeId: null });

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'iad',
    });

    await instance.alarm();

    expect(flyClient.createVolumeWithFallback).toHaveBeenCalled();
    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
  });

  it('replaces lost volume (404) with data_loss log', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyVolumeId: 'vol-dead' });

    (flyClient.getVolume as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-replacement',
      region: 'iad',
    });

    await instance.alarm();

    expect(storage._store.get('flyVolumeId')).toBe('vol-replacement');

    // Verify data_loss was logged
    const logCalls = (console.log as Mock).mock.calls;
    const dataLossLog = logCalls.find((args: unknown[]) => {
      const msg = String(args[0]);
      return msg.includes('replace_lost_volume') && msg.includes('data_loss');
    });
    expect(dataLossLog).toBeDefined();
  });
});

describe('destroying: no recreation', () => {
  it('does not create volume during destroying', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyVolumeId: null,
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: null,
    });

    await instance.alarm();

    expect(flyClient.createVolumeWithFallback).not.toHaveBeenCalled();
  });

  it('does not create machine during destroying', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: null,
    });

    await instance.alarm();

    expect(flyClient.createMachine).not.toHaveBeenCalled();
  });
});

describe('status guards', () => {
  it('start() rejects when destroying', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'destroying' });

    await expect(instance.start()).rejects.toThrow('Cannot start: instance is being destroyed');
  });

  it('provision() rejects when destroying', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'destroying' });

    await expect(instance.provision('user-1', {})).rejects.toThrow(
      'Cannot provision: instance is being destroyed'
    );
  });

  it('stop() is a no-op when destroying', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'destroying' });

    await instance.stop();

    // Status unchanged
    expect(storage._store.get('status')).toBe('destroying');
    expect(flyClient.stopMachineAndWait).not.toHaveBeenCalled();
  });
});

describe('alarm cadence', () => {
  it('schedules fast alarm for running instances', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    const alarm = storage._getAlarm();
    expect(alarm).not.toBeNull();
    const delta = alarm! - Date.now();
    expect(delta).toBeGreaterThanOrEqual(ALARM_INTERVAL_RUNNING_MS);
    expect(delta).toBeLessThanOrEqual(ALARM_INTERVAL_RUNNING_MS + ALARM_JITTER_MS + 100);
  });

  it('schedules fast alarm for destroying instances', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      pendingDestroyMachineId: 'machine-1',
      pendingDestroyVolumeId: null,
    });

    (flyClient.destroyMachine as Mock).mockRejectedValue(new FlyApiError('timeout', 503, 'retry'));

    await instance.alarm();

    const alarm = storage._getAlarm();
    expect(alarm).not.toBeNull();
    const delta = alarm! - Date.now();
    expect(delta).toBeGreaterThanOrEqual(ALARM_INTERVAL_DESTROYING_MS);
    expect(delta).toBeLessThanOrEqual(ALARM_INTERVAL_DESTROYING_MS + ALARM_JITTER_MS + 100);
  });

  it('schedules slow alarm for stopped instances', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped' });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    const alarm = storage._getAlarm();
    expect(alarm).not.toBeNull();
    const delta = alarm! - Date.now();
    expect(delta).toBeGreaterThanOrEqual(ALARM_INTERVAL_IDLE_MS);
    expect(delta).toBeLessThanOrEqual(ALARM_INTERVAL_IDLE_MS + ALARM_JITTER_MS + 100);
  });

  it('schedules slow alarm for provisioned instances', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    const alarm = storage._getAlarm();
    expect(alarm).not.toBeNull();
    const delta = alarm! - Date.now();
    expect(delta).toBeGreaterThanOrEqual(ALARM_INTERVAL_IDLE_MS);
    expect(delta).toBeLessThanOrEqual(ALARM_INTERVAL_IDLE_MS + ALARM_JITTER_MS + 100);
  });
});

describe('alarm runs for all live statuses', () => {
  it('runs reconciliation for provisioned instances', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // Volume was checked
    expect(flyClient.getVolume).toHaveBeenCalled();
    // Alarm rescheduled
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('runs reconciliation for stopped instances', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: 'machine-1' });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(flyClient.getVolume).toHaveBeenCalled();
    expect(flyClient.getMachine).toHaveBeenCalled();
    expect(storage._getAlarm()).not.toBeNull();
  });
});

describe('startExistingMachine: transient vs 404 errors', () => {
  it('does NOT recreate machine on transient 500 error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped' });

    // getMachine returns stopped, but updateMachine throws transient 500
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'internal')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await expect(instance.start('user-1')).rejects.toThrow('server error');

    // createMachine should NOT have been called — no duplicate
    expect(flyClient.createMachine).not.toHaveBeenCalled();
    // Machine ID should still be intact
    expect(storage._store.get('flyMachineId')).toBe('machine-1');
  });

  it('recreates machine when getMachine returns 404', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped' });

    // getMachine 404 — machine gone
    (flyClient.getMachine as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-new',
      region: 'iad',
    });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.start('user-1');

    expect(flyClient.createMachine).toHaveBeenCalled();
    expect(storage._store.get('flyMachineId')).toBe('machine-new');
  });
});

describe('createNewMachine: persist ID before waitForState', () => {
  it('persists machine ID to storage before calling waitForState', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: null });

    let idAtWaitTime: unknown = undefined;

    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-fresh',
      region: 'iad',
    });
    (flyClient.waitForState as Mock).mockImplementation(() => {
      // Capture what's in storage at the moment waitForState is called
      idAtWaitTime = storage._store.get('flyMachineId');
      return Promise.resolve();
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.start('user-1');

    // The machine ID was persisted BEFORE waitForState ran
    expect(idAtWaitTime).toBe('machine-fresh');
  });

  it('includes Fly HTTP health check config in machine create request', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: null });

    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-health-check',
      region: 'iad',
    });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.start('user-1');

    expect(flyClient.createMachine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        checks: {
          controller: {
            type: 'http',
            port: 18789,
            method: 'GET',
            path: '/_kilo/health',
            interval: '30s',
            timeout: '5s',
            grace_period: '120s',
          },
        },
      }),
      expect.anything()
    );
  });

  it('preserves machine ID in storage even if waitForState fails', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: null });

    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-orphan-safe',
      region: 'iad',
    });
    (flyClient.waitForState as Mock).mockRejectedValue(new Error('timeout'));
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await expect(instance.start('user-1')).rejects.toThrow('timeout');

    // Machine ID is persisted despite the failure — not orphaned
    expect(storage._store.get('flyMachineId')).toBe('machine-orphan-safe');
  });
});

describe('gateway process control via controller', () => {
  it('allows gateway status calls when machine ID exists even if DO status is stale', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'stopped',
      flyMachineId: 'machine-1',
      flyAppName: 'acct-test',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: 'running',
          pid: 123,
          uptime: 42,
          restarts: 1,
          lastExit: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await instance.getGatewayProcessStatus();
    expect(status.state).toBe('running');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('calls gateway status through Fly Proxy with controller auth headers', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: 'machine-1', flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: 'running',
          pid: 123,
          uptime: 42,
          restarts: 1,
          lastExit: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const status = await instance.getGatewayProcessStatus();

    expect(status.state).toBe('running');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://acct-test.fly.dev/_kilo/gateway/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'fly-force-instance-id': 'machine-1',
        }) as unknown,
      })
    );

    const call = fetchSpy.mock.calls[0];
    const headers = new Headers(call[1]?.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer [a-f0-9]{64}$/);
    fetchSpy.mockRestore();
  });

  it('starts, stops, and restarts the gateway process through controller routes', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: 'machine-1', flyAppName: 'acct-test' });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    await instance.startGatewayProcess();
    await instance.stopGatewayProcess();
    await instance.restartGatewayProcess();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://acct-test.fly.dev/_kilo/gateway/start');
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://acct-test.fly.dev/_kilo/gateway/stop');
    expect(fetchSpy.mock.calls[2]?.[0]).toBe('https://acct-test.fly.dev/_kilo/gateway/restart');
    fetchSpy.mockRestore();
  });

  it('surfaces controller HTTP status errors', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: 'machine-1', flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Gateway already running or starting' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.startGatewayProcess()).rejects.toSatisfy((err: unknown) => {
      if (typeof err !== 'object' || err === null) return false;
      return (
        'status' in err &&
        (err as { status: number }).status === 409 &&
        'message' in err &&
        (err as { message: string }).message.includes('already running')
      );
    });

    fetchSpy.mockRestore();
  });

  it('restoreConfig calls the controller config restore endpoint and preserves signaled', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: 'machine-1', flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, signaled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.restoreConfig('base');

    expect(result).toEqual({ ok: true, signaled: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://acct-test.fly.dev/_kilo/config/restore/base');
    fetchSpy.mockRestore();
  });

  it('restoreConfig surfaces signaled: false when gateway was not running', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: 'machine-1', flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, signaled: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.restoreConfig('base');

    expect(result).toEqual({ ok: true, signaled: false });
    fetchSpy.mockRestore();
  });

  it('rejects invalid controller success payload shape', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: 'machine-1', flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: 'yes' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.startGatewayProcess()).rejects.toSatisfy((err: unknown) => {
      if (typeof err !== 'object' || err === null) return false;
      return (
        'status' in err &&
        (err as { status: number }).status === 502 &&
        'message' in err &&
        (err as { message: string }).message.includes('invalid response')
      );
    });

    fetchSpy.mockRestore();
  });
});

// ============================================================================
// selectRecoveryCandidate (pure function, no mocks needed)
// ============================================================================

import {
  selectRecoveryCandidate,
  parseRegions,
  deprioritizeRegion,
  shuffleRegions,
} from './kiloclaw-instance';
import type { FlyMachine } from '../fly/types';

function fakeMachine(overrides: Partial<FlyMachine>): FlyMachine {
  return {
    id: 'machine-1',
    name: 'test',
    state: 'started',
    region: 'iad',
    instance_id: 'inst-1',
    config: { image: 'test:latest' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('selectRecoveryCandidate', () => {
  it('returns null for empty list', () => {
    expect(selectRecoveryCandidate([])).toBeNull();
  });

  it('returns null when all machines are destroyed/destroying', () => {
    const machines = [
      fakeMachine({ id: 'm1', state: 'destroyed' }),
      fakeMachine({ id: 'm2', state: 'destroying' }),
    ];
    expect(selectRecoveryCandidate(machines)).toBeNull();
  });

  it('prefers started over stopped', () => {
    const machines = [
      fakeMachine({ id: 'stopped-1', state: 'stopped', updated_at: '2026-02-01T00:00:00Z' }),
      fakeMachine({ id: 'started-1', state: 'started', updated_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(selectRecoveryCandidate(machines)?.id).toBe('started-1');
  });

  it('prefers starting over stopped', () => {
    const machines = [
      fakeMachine({ id: 'stopped-1', state: 'stopped' }),
      fakeMachine({ id: 'starting-1', state: 'starting' }),
    ];
    expect(selectRecoveryCandidate(machines)?.id).toBe('starting-1');
  });

  it('tie-breaks by newest updated_at', () => {
    const machines = [
      fakeMachine({ id: 'old', state: 'stopped', updated_at: '2026-01-01T00:00:00Z' }),
      fakeMachine({ id: 'new', state: 'stopped', updated_at: '2026-02-01T00:00:00Z' }),
    ];
    expect(selectRecoveryCandidate(machines)?.id).toBe('new');
  });

  it('ignores destroyed machines while picking live ones', () => {
    const machines = [
      fakeMachine({ id: 'dead', state: 'destroyed' }),
      fakeMachine({ id: 'alive', state: 'stopped' }),
    ];
    expect(selectRecoveryCandidate(machines)?.id).toBe('alive');
  });
});

describe('metadata recovery via alarm', () => {
  it('recovers machine ID from Fly metadata when flyMachineId is null', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.listMachines as Mock).mockResolvedValue([
      fakeMachine({
        id: 'recovered-machine',
        state: 'started',
        region: 'iad',
        config: { image: 'test:latest', mounts: [{ volume: 'vol-recovered', path: '/root' }] },
      }),
    ]);

    await instance.alarm();

    expect(storage._store.get('flyMachineId')).toBe('recovered-machine');
    expect(storage._store.get('flyRegion')).toBe('iad');
    expect(storage._store.get('status')).toBe('running');
  });

  it('recovers volume ID from machine mount config', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null, flyVolumeId: null });

    (flyClient.listMachines as Mock).mockResolvedValue([
      fakeMachine({
        id: 'recovered-machine',
        state: 'stopped',
        config: { image: 'test:latest', mounts: [{ volume: 'vol-from-mount', path: '/root' }] },
      }),
    ]);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-from-mount' });

    await instance.alarm();

    expect(storage._store.get('flyVolumeId')).toBe('vol-from-mount');
  });

  it('respects cooldown — skips recovery if attempted recently', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      flyMachineId: null,
      lastMetadataRecoveryAt: Date.now(), // just attempted
    });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // listMachines should NOT have been called due to cooldown
    expect(flyClient.listMachines).not.toHaveBeenCalled();
  });

  it('does not attempt recovery during destroying', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: null,
    });

    await instance.alarm();

    expect(flyClient.listMachines).not.toHaveBeenCalled();
  });
});

// ============================================================================
// updateChannels
// ============================================================================

describe('updateChannels', () => {
  const fakeEnvelope = {
    encryptedData: 'data',
    encryptedDEK: 'dek',
    algorithm: 'rsa-aes-256-gcm' as const,
    version: 1 as const,
  };

  it('sets a telegram token on a provisioned instance', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.updateChannels({ telegramBotToken: fakeEnvelope });

    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(false);
    const channels = storage._store.get('channels') as Record<string, unknown>;
    expect(channels.telegramBotToken).toEqual(fakeEnvelope);
  });

  it('removes a telegram token when null is passed', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { telegramBotToken: fakeEnvelope },
    });

    const result = await instance.updateChannels({ telegramBotToken: null });

    expect(result.telegram).toBe(false);
    // channels should be null when all tokens are removed
    expect(storage._store.get('channels')).toBeNull();
  });

  it('merges with existing channels — setting telegram preserves discord', async () => {
    const discordEnvelope = { ...fakeEnvelope, encryptedData: 'discord-data' };
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { discordBotToken: discordEnvelope },
    });

    const result = await instance.updateChannels({ telegramBotToken: fakeEnvelope });

    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(true);
    const channels = storage._store.get('channels') as Record<string, unknown>;
    expect(channels.telegramBotToken).toEqual(fakeEnvelope);
    expect(channels.discordBotToken).toEqual(discordEnvelope);
  });

  it('ignores undefined fields — only patches provided keys', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { telegramBotToken: fakeEnvelope },
    });

    // Pass only discord, leave telegram undefined (should be preserved)
    const discordEnvelope = { ...fakeEnvelope, encryptedData: 'discord-data' };
    const result = await instance.updateChannels({ discordBotToken: discordEnvelope });

    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(true);
  });
});

// ============================================================================
// parseRegions + deprioritizeRegion (pure functions)
// ============================================================================

describe('parseRegions', () => {
  it('splits comma-separated regions', () => {
    expect(parseRegions('dfw,yyz,cdg')).toEqual(['dfw', 'yyz', 'cdg']);
  });

  it('handles a single region', () => {
    expect(parseRegions('iad')).toEqual(['iad']);
  });

  it('trims whitespace', () => {
    expect(parseRegions('dfw, yyz , cdg')).toEqual(['dfw', 'yyz', 'cdg']);
  });

  it('filters empty strings', () => {
    expect(parseRegions('dfw,,cdg')).toEqual(['dfw', 'cdg']);
  });
});

describe('deprioritizeRegion', () => {
  it('moves failed region to end', () => {
    expect(deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'dfw')).toEqual(['yyz', 'cdg', 'dfw']);
  });

  it('moves middle region to end', () => {
    expect(deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'yyz')).toEqual(['dfw', 'cdg', 'yyz']);
  });

  it('returns list unchanged when failed region is already last', () => {
    expect(deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'cdg')).toEqual(['dfw', 'yyz', 'cdg']);
  });

  it('returns list unchanged when failed region is not in list', () => {
    expect(deprioritizeRegion(['dfw', 'yyz'], 'iad')).toEqual(['dfw', 'yyz']);
  });

  it('returns list unchanged when failedRegion is null', () => {
    expect(deprioritizeRegion(['dfw', 'yyz'], null)).toEqual(['dfw', 'yyz']);
  });

  it('handles single-element list', () => {
    expect(deprioritizeRegion(['dfw'], 'dfw')).toEqual(['dfw']);
  });
});

describe('shuffleRegions', () => {
  it('returns the same elements', () => {
    const input = ['cdg', 'arn', 'yyz', 'ord', 'dfw', 'lax'];
    const result = shuffleRegions([...input]);
    expect(result.sort()).toEqual(input.sort());
  });

  it('returns a single-element array unchanged', () => {
    expect(shuffleRegions(['dfw'])).toEqual(['dfw']);
  });

  it('returns an empty array unchanged', () => {
    expect(shuffleRegions([])).toEqual([]);
  });

  it('mutates in place and returns the same reference', () => {
    const arr = ['a', 'b', 'c'];
    const result = shuffleRegions(arr);
    expect(result).toBe(arr);
  });

  it('produces different orderings over many runs', () => {
    const input = ['cdg', 'arn', 'yyz', 'ord', 'dfw', 'lax'];
    const orderings = new Set<string>();
    for (let i = 0; i < 50; i++) {
      orderings.add(shuffleRegions([...input]).join(','));
    }
    // With 6 elements (720 permutations), 50 shuffles should produce at least 2 distinct orderings
    expect(orderings.size).toBeGreaterThan(1);
  });
});

// ============================================================================
// Live check in getStatus()
// ============================================================================

describe('getStatus: throttled live Fly check', () => {
  it('confirms running when Fly says started', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'started', config: {} });

    const result = await instance.getStatus();

    // Fire-and-forget: wait for the background check to complete
    await Promise.all(waitUntilPromises);

    expect(result.status).toBe('running');
    expect(flyClient.getMachine).toHaveBeenCalledTimes(1);
  });

  it('flips to stopped in-memory when Fly says stopped', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped', config: {} });

    // First call: fires the live check (fire-and-forget), returns cached 'running'
    const result1 = await instance.getStatus();
    await Promise.all(waitUntilPromises);

    // Status was updated in-memory by the background check
    // Second call should return 'stopped' (and not fire another check since status != running)
    const result2 = await instance.getStatus();

    expect(result1.status).toBe('running'); // fire-and-forget: first call returns cached
    expect(result2.status).toBe('stopped'); // next call sees updated in-memory state
    // No persistence — alarm loop owns that
    expect(storage._store.get('status')).toBe('running');
  });

  it('leaves status as running for transitional states (starting)', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'starting', config: {} });

    await instance.getStatus();
    await Promise.all(waitUntilPromises);

    // Second call: status should still be running
    const result = await instance.getStatus();
    expect(result.status).toBe('running');
  });

  it('leaves status as running for transitional states (stopping)', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopping', config: {} });

    await instance.getStatus();
    await Promise.all(waitUntilPromises);

    const result = await instance.getStatus();
    expect(result.status).toBe('running');
  });

  it('flips to stopped on 404 (machine gone)', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));

    await instance.getStatus();
    await Promise.all(waitUntilPromises);

    const result = await instance.getStatus();
    expect(result.status).toBe('stopped');
    // No persistence
    expect(storage._store.get('status')).toBe('running');
  });

  it('preserves cached status on transient Fly error', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockRejectedValue(new FlyApiError('timeout', 503, 'retry'));

    await instance.getStatus();
    await Promise.all(waitUntilPromises);

    const result = await instance.getStatus();
    expect(result.status).toBe('running');
  });

  it('respects throttle — does not call Fly within window', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'started', config: {} });

    // First call triggers live check
    await instance.getStatus();
    await Promise.all(waitUntilPromises);
    expect(flyClient.getMachine).toHaveBeenCalledTimes(1);

    // Second call within throttle window — should NOT call Fly again
    await instance.getStatus();
    await Promise.all(waitUntilPromises);
    expect(flyClient.getMachine).toHaveBeenCalledTimes(1);
  });

  it('does not fire live check when status is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: 'machine-1' });

    await instance.getStatus();

    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });

  it('does not fire live check when flyMachineId is null', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: null });

    await instance.getStatus();

    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Volume region validation before machine creation
// ============================================================================

describe('start: volume region validation', () => {
  it('corrects flyRegion when it drifts from actual volume region', async () => {
    const { instance, storage } = createInstance();
    // DO thinks volume is in 'iad', but actual volume is in 'cdg'
    await seedProvisioned(storage, { flyMachineId: null, flyRegion: 'iad' });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'cdg' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.start('user-1');

    // flyRegion should be corrected to actual volume region
    expect(storage._store.get('flyRegion')).toBe('cdg');
    // Machine should be created (region passed from corrected flyRegion)
    expect(flyClient.createMachine).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ region: 'cdg' })
    );
  });

  it('handles volume gone (404) during region check by creating a new volume', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null });

    // Volume is gone
    (flyClient.getVolume as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    // ensureVolume creates a replacement
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'dfw',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'dfw' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.start('user-1');

    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
    expect(storage._store.get('flyRegion')).toBe('dfw');
    expect(storage._store.get('status')).toBe('running');
  });

  it('skips region check when machine already exists', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped' });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockResolvedValue({ id: 'machine-1' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.start('user-1');

    // getVolume should only be called by ensureVolume (which is a no-op since
    // flyVolumeId is set), NOT for region validation (because flyMachineId exists)
    // Actually getVolume is NOT called by ensureVolume when flyVolumeId is set.
    // The region validation also skips because flyMachineId is set.
    expect(flyClient.getVolume).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 412 insufficient resources recovery
// ============================================================================

describe('start: 412 insufficient resources recovery', () => {
  it('fresh provision (never started): deletes volume and creates fresh with deprioritized regions', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null, lastStartedAt: null });

    // First createMachine fails with 412
    (flyClient.createMachine as Mock)
      .mockRejectedValueOnce(
        new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
      )
      .mockResolvedValueOnce({ id: 'machine-retry', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });

    await instance.start('user-1');

    // Old volume was deleted
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-1');
    // New volume created via fallback with deprioritized regions and compute hint
    const regions412Call = (flyClient.createVolumeWithFallback as Mock).mock.calls[0];
    expect(regions412Call[1]).toEqual(
      expect.objectContaining({
        compute: expect.objectContaining({ cpus: 2, memory_mb: 3072 }) as unknown,
      })
    );
    // Regions are shuffled, so just check the set (deprioritize is a no-op here
    // because 'iad' is not in FLY_REGION='us,eu')
    expect((regions412Call[2] as string[]).sort()).toEqual(['eu', 'us']);
    // source_volume_id should NOT be set for fresh provision
    const createVolumeCall = (flyClient.createVolumeWithFallback as Mock).mock
      .calls[0][1] as Record<string, unknown>;
    expect(createVolumeCall.source_volume_id).toBeUndefined();

    // Machine was created on retry
    expect(flyClient.createMachine).toHaveBeenCalledTimes(2);
    expect(storage._store.get('flyMachineId')).toBe('machine-retry');
    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
    expect(storage._store.get('flyRegion')).toBe('cdg');
    expect(storage._store.get('status')).toBe('running');
  });

  it('existing instance (has user data): forks volume to preserve data', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      flyMachineId: null,
      lastStartedAt: Date.now() - 60_000,
    });

    // First createMachine fails with 412
    (flyClient.createMachine as Mock)
      .mockRejectedValueOnce(
        new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
      )
      .mockResolvedValueOnce({ id: 'machine-retry', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    // Fork succeeds
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-forked',
      region: 'cdg',
    });

    await instance.start('user-1');

    // Volume was forked (source_volume_id set) with compute hint and deprioritized regions
    const regionsForkCall = (flyClient.createVolumeWithFallback as Mock).mock.calls[0];
    expect(regionsForkCall[1]).toEqual(
      expect.objectContaining({
        source_volume_id: 'vol-1',
        compute: expect.objectContaining({ cpus: 2, memory_mb: 3072 }) as unknown,
      })
    );
    // Regions are shuffled — check the set
    expect((regionsForkCall[2] as string[]).sort()).toEqual(['eu', 'us']);
    // Old volume was deleted
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-1');
    // Machine was retried
    expect(storage._store.get('flyMachineId')).toBe('machine-retry');
    expect(storage._store.get('flyVolumeId')).toBe('vol-forked');
  });

  it('existing instance: propagates error when fork fails (no silent data loss)', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      flyMachineId: null,
      lastStartedAt: Date.now() - 60_000,
    });

    // First createMachine fails with 412
    (flyClient.createMachine as Mock).mockRejectedValueOnce(
      new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    // Fork fails (all regions exhausted)
    (flyClient.createVolumeWithFallback as Mock).mockRejectedValueOnce(
      new FlyApiError('fork failed', 500, 'fail')
    );

    await expect(instance.start('user-1')).rejects.toThrow('fork failed');

    // Volume should NOT have been replaced with a fresh one
    expect(storage._store.get('flyVolumeId')).toBe('vol-1');
    // No machine created
    expect(storage._store.get('flyMachineId')).toBeNull();
  });

  it('destroys existing machine when 412 hits on updateMachine in startExistingMachine', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped', lastStartedAt: Date.now() - 60_000 });

    // getMachine returns stopped, updateMachine throws 412
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-new', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.start('user-1');

    // Old machine was destroyed
    expect(flyClient.destroyMachine).toHaveBeenCalledWith(expect.anything(), 'machine-1');
    // Volume was forked (has user data) with compute hint
    const regionsUpdateCall = (flyClient.createVolumeWithFallback as Mock).mock.calls[0];
    expect(regionsUpdateCall[1]).toEqual(
      expect.objectContaining({
        source_volume_id: 'vol-1',
        compute: expect.objectContaining({ cpus: 2, memory_mb: 3072 }) as unknown,
      })
    );
    // Regions are shuffled then deprioritized — check the set
    expect((regionsUpdateCall[2] as string[]).sort()).toEqual(['eu', 'us']);
    // New machine was created
    expect(storage._store.get('flyMachineId')).toBe('machine-new');
    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
    expect(storage._store.get('status')).toBe('running');
  });

  it('keeps machine ID when destroy of stranded machine fails transiently', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped', lastStartedAt: Date.now() - 60_000 });

    // getMachine returns stopped, updateMachine throws 412
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    // destroyMachine fails with transient 500
    (flyClient.destroyMachine as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'internal')
    );
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    // Fork still succeeds
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-new', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.start('user-1');

    // Old machine ID should still be tracked (not orphaned)
    // The new machine gets stored via createNewMachine, overwriting the old one
    expect(storage._store.get('flyMachineId')).toBe('machine-new');
    // destroyMachine was attempted
    expect(flyClient.destroyMachine).toHaveBeenCalledWith(expect.anything(), 'machine-1');
  });

  it('propagates non-412 errors without recovery', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null });

    (flyClient.createMachine as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'internal')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await expect(instance.start('user-1')).rejects.toThrow('server error');

    // Volume should NOT have been replaced
    expect(flyClient.deleteVolume).not.toHaveBeenCalled();
    expect(flyClient.createVolumeWithFallback).not.toHaveBeenCalled();
    expect(storage._store.get('flyVolumeId')).toBe('vol-1');
  });

  it('propagates error when 412 retry also fails', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null, lastStartedAt: null });

    // Both attempts fail
    (flyClient.createMachine as Mock)
      .mockRejectedValueOnce(
        new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
      )
      .mockRejectedValueOnce(new FlyApiError('still no resources', 500, '{"error":"no capacity"}'));
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });

    await expect(instance.start('user-1')).rejects.toThrow('still no resources');

    // Volume was replaced (during recovery attempt)
    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
    // But machine was NOT created (retry failed)
    expect(storage._store.get('flyMachineId')).toBeNull();
  });
});

// ============================================================================
// stop() error handling
// ============================================================================

describe('stop: error propagation', () => {
  it('propagates non-404 Fly errors', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.stopMachineAndWait as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'internal')
    );

    await expect(instance.stop()).rejects.toThrow('server error');

    // Status should NOT have been written to stopped
    expect(storage._store.get('status')).toBe('running');
  });

  it('treats 404 as success (machine already gone)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.stopMachineAndWait as Mock).mockRejectedValue(
      new FlyApiError('not found', 404, '{}')
    );

    await instance.stop();

    expect(storage._store.get('status')).toBe('stopped');
  });

  it('succeeds when Fly stop completes normally', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.stopMachineAndWait as Mock).mockResolvedValue(undefined);

    await instance.stop();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('lastStoppedAt')).toBeDefined();
  });
});

// ============================================================================
// listVolumeSnapshots
// ============================================================================

describe('listVolumeSnapshots', () => {
  it('returns snapshots from Fly API when volume exists', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const snapshots = [
      {
        id: 'snap-1',
        created_at: '2026-02-19T00:00:00Z',
        digest: 'sha256:abc',
        retention_days: 5,
        size: 1048576,
        status: 'complete',
        volume_size: 10737418240,
      },
    ];
    (flyClient.listVolumeSnapshots as Mock).mockResolvedValue(snapshots);

    const result = await instance.listVolumeSnapshots();

    expect(result).toEqual(snapshots);
    expect(flyClient.listVolumeSnapshots).toHaveBeenCalledWith(
      { apiToken: 'test-token', appName: 'test-app' },
      'vol-1'
    );
  });

  it('returns empty array when no volume exists', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyVolumeId: null });

    const result = await instance.listVolumeSnapshots();

    expect(result).toEqual([]);
    expect(flyClient.listVolumeSnapshots).not.toHaveBeenCalled();
  });

  it('returns empty array for unprovisioned instance', async () => {
    const { instance } = createInstance();

    const result = await instance.listVolumeSnapshots();

    expect(result).toEqual([]);
    expect(flyClient.listVolumeSnapshots).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Device pairing
// ============================================================================
describe('listDevicePairingRequests', () => {
  it('returns empty when not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.listDevicePairingRequests();

    expect(result).toEqual({ requests: [] });
  });

  it('calls execCommand and parses JSON output', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fakeOutput = JSON.stringify({
      requests: [
        { requestId: 'abc-123', deviceId: 'dev-1', role: 'operator', platform: 'MacIntel' },
      ],
    });
    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: fakeOutput,
      stderr: '',
    });

    const result = await instance.listDevicePairingRequests();

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].requestId).toBe('abc-123');
    expect(flyClient.execCommand).toHaveBeenCalledWith(
      expect.anything(),
      'machine-1',
      ['/usr/bin/env', 'HOME=/root', 'node', '/usr/local/bin/openclaw-device-pairing-list.js'],
      60
    );
  });

  it('returns empty on exec failure', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 1,
      stdout: '',
      stderr: 'something went wrong',
    });

    const result = await instance.listDevicePairingRequests();

    expect(result).toEqual({ requests: [] });
  });
});

describe('approveDevicePairingRequest', () => {
  it('rejects invalid requestId format', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const result = await instance.approveDevicePairingRequest('not-a-uuid');

    expect(result).toEqual({ success: false, message: 'Invalid request ID' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('returns not running when instance is stopped', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: false, message: 'Instance is not running' });
  });

  it('calls openclaw devices approve with the requestId', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: 'approved',
      stderr: '',
    });

    const requestId = '58f4ac67-12b4-4f6e-adee-ff3463a7c30c';
    const result = await instance.approveDevicePairingRequest(requestId);

    expect(result).toEqual({ success: true, message: 'Device pairing approved' });
    expect(flyClient.execCommand).toHaveBeenCalledWith(
      expect.anything(),
      'machine-1',
      ['/usr/bin/env', 'HOME=/root', 'openclaw', 'devices', 'approve', requestId],
      60
    );
  });

  it('accepts uppercase UUIDs', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: 'approved',
      stderr: '',
    });

    const requestId = '58F4AC67-12B4-4F6E-ADEE-FF3463A7C30C';
    const result = await instance.approveDevicePairingRequest(requestId);

    expect(result).toEqual({ success: true, message: 'Device pairing approved' });
    expect(flyClient.execCommand).toHaveBeenCalledWith(
      expect.anything(),
      'machine-1',
      ['/usr/bin/env', 'HOME=/root', 'openclaw', 'devices', 'approve', requestId],
      60
    );
  });

  it('returns failure message on exec error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 1,
      stdout: '',
      stderr: 'request not found',
    });

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: false, message: 'Approval failed' });
  });
});

// ============================================================================
// provision: auto-start
// ============================================================================

describe('provision: auto-start after fresh provision', () => {
  it('calls start() on fresh provision and ends in running state', async () => {
    const { instance, storage } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    const result = await instance.provision('user-1', {});

    expect(result.sandboxId).toBeDefined();
    expect(flyClient.createMachine).toHaveBeenCalled();
    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('flyMachineId')).toBe('machine-1');
  });

  it('skips auto-start on re-provision of existing instance', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    // Re-provision with new config — should NOT call createMachine again
    (flyClient.createMachine as Mock).mockClear();

    await instance.provision('user-1', { kilocodeApiKey: 'new-key' });

    expect(flyClient.createMachine).not.toHaveBeenCalled();
    expect(storage._store.get('status')).toBe('running');
  });
});

describe('auto-destroy stale provisioned instances', () => {
  // Reset listMachines to return [] for each test in this block, since
  // earlier metadata-recovery tests may have set it to return machines
  // and vi.clearAllMocks() does not reset implementations.
  beforeEach(() => {
    (flyClient.listMachines as Mock).mockResolvedValue([]);
  });

  function createInstanceWithPostgres(markImpl: () => Promise<void> = () => Promise.resolve()): {
    instance: KiloClawInstance;
    storage: ReturnType<typeof createFakeStorage>;
    markDestroyed: Mock;
  } {
    const env = {
      ...createFakeEnv(),
      HYPERDRIVE: { connectionString: 'postgres://test' } as unknown,
    };

    const markDestroyed = vi.fn(markImpl);
    (db.getWorkerDb as Mock).mockReturnValue({});
    (db.getActiveInstance as Mock).mockResolvedValue(null);
    (db.markInstanceDestroyed as Mock).mockImplementation(markDestroyed);

    const { instance, storage } = createInstance(undefined, env);
    return { instance, storage, markDestroyed };
  }

  it('auto-destroys provisioned instance older than threshold with no machine', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000; // 1 min past threshold
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    await instance.alarm();

    // DO state should be fully cleared (destroy completed)
    expect(storage._store.size).toBe(0);
    // Postgres mark-destroyed should have been called
    expect(markDestroyed).toHaveBeenCalledOnce();
    expect(markDestroyed).toHaveBeenCalledWith(expect.anything(), 'user-1', 'sandbox-1');
    // Metadata recovery ran first (listMachines), but found nothing
    expect(flyClient.listMachines).toHaveBeenCalled();
    // Volume reconciliation should not have run (destroyed before that)
    expect(flyClient.getVolume).not.toHaveBeenCalled();
  });

  it('does not auto-destroy if provisionedAt is within threshold', async () => {
    const recentTime = Date.now() - STALE_PROVISION_THRESHOLD_MS + 60_000; // 1 min before threshold
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: recentTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // Instance should still exist, not destroyed
    expect(storage._store.size).toBeGreaterThan(0);
    expect(storage._store.get('status')).not.toBeNull();
    expect(markDestroyed).not.toHaveBeenCalled();
  });

  it('does not auto-destroy if instance has a machine ID', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000;
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: 'machine-1',
      lastStartedAt: null,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // Should still exist — machine exists so it's not a stale provision
    expect(storage._store.get('status')).not.toBeNull();
    expect(storage._store.size).toBeGreaterThan(0);
    expect(markDestroyed).not.toHaveBeenCalled();
  });

  it('does not auto-destroy if instance was previously started', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000;
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: staleTime + 1000, // was started at some point
    });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // Should still exist — was previously started so not an abandoned provision
    expect(storage._store.size).toBeGreaterThan(0);
    expect(storage._store.get('status')).not.toBeNull();
    expect(markDestroyed).not.toHaveBeenCalled();
  });

  it('does not auto-destroy when metadata recovery fails with transient error', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000;
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    // Fly API fails transiently — we can't confirm whether a machine exists
    (flyClient.listMachines as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'internal')
    );

    await instance.alarm();

    // Should NOT auto-destroy — recovery was inconclusive
    expect(storage._store.size).toBeGreaterThan(0);
    expect(storage._store.get('status')).not.toBeNull();
    expect(markDestroyed).not.toHaveBeenCalled();
  });

  it('recovers machine via metadata before considering auto-destroy', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000;
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    // Fly still has a live machine — metadata recovery should find it
    (flyClient.listMachines as Mock).mockResolvedValue([
      fakeMachine({
        id: 'recovered-machine',
        state: 'stopped',
        region: 'iad',
        config: { image: 'test:latest', mounts: [{ volume: 'vol-1', path: '/root' }] },
      }),
    ]);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // Machine recovered — instance should NOT be auto-destroyed
    expect(storage._store.get('flyMachineId')).toBe('recovered-machine');
    expect(storage._store.size).toBeGreaterThan(0);
    expect(markDestroyed).not.toHaveBeenCalled();
  });

  it('logs reconciliation action with structured details', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 3600_000; // 1 hour past threshold
    const { instance, storage } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    await instance.alarm();

    const logCalls = (console.log as Mock).mock.calls;
    const autoDestroyLog = logCalls.find((args: unknown[]) => {
      const msg = String(args[0]);
      return msg.includes('auto_destroy_stale_provision');
    });
    expect(autoDestroyLog).toBeDefined();
    const parsed: unknown = JSON.parse(String(autoDestroyLog![0]));
    expect(parsed).toMatchObject({
      tag: 'reconcile',
      reason: 'alarm',
      action: 'auto_destroy_stale_provision',
      user_id: 'user-1',
    });
  });

  it('proceeds with destroy when markDestroyedInPostgres completes', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000;
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    await instance.alarm();

    // Both markDestroyedInPostgres and destroy should have completed
    expect(markDestroyed).toHaveBeenCalledOnce();
    expect(storage._store.size).toBe(0);
    // Alarm should not be rescheduled (DO is fully destroyed)
    expect(storage._getAlarm()).toBeNull();
  });

  it('retries Postgres mark on later alarms after Fly cleanup is complete', async () => {
    const staleTime = Date.now() - STALE_PROVISION_THRESHOLD_MS - 60_000;
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    markDestroyed
      .mockRejectedValueOnce(new Error('transient hyperdrive error'))
      .mockResolvedValueOnce(undefined);

    await seedProvisioned(storage, {
      provisionedAt: staleTime,
      flyMachineId: null,
      lastStartedAt: null,
    });

    await instance.alarm();

    // Fly cleanup completed, but PG mark failed so DO stays in destroying state for retry
    expect(storage._store.get('status')).toBe('destroying');
    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._store.get('pendingDestroyVolumeId')).toBeNull();
    expect(storage._store.get('pendingPostgresMarkOnFinalize')).toBe(true);
    expect(storage._getAlarm()).not.toBeNull();

    await instance.alarm();

    expect(markDestroyed).toHaveBeenCalledTimes(2);
    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });

  it('does not mark Postgres for manual destroy path', async () => {
    const { instance, storage, markDestroyed } = createInstanceWithPostgres();
    await seedRunning(storage);

    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.destroy();

    expect(markDestroyed).not.toHaveBeenCalled();
    expect(storage._store.size).toBe(0);
  });
});

// ============================================================================
// restartGateway image tag override
// ============================================================================

describe('restartGateway image tag override', () => {
  beforeEach(() => {
    (flyClient.stopMachineAndWait as Mock).mockResolvedValue(undefined);
    (flyClient.updateMachine as Mock).mockResolvedValue(undefined);
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });
  });

  it('uses existing trackedImageTag when no options provided', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { trackedImageTag: 'old-tag-123' });

    const result = await instance.restartGateway();

    expect(result.success).toBe(true);
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(storage._store.get('trackedImageTag')).toBe('old-tag-123');
  });

  it('fetches latest from KV when imageTag is "latest"', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, {
      trackedImageTag: 'old-tag',
      openclawVersion: '1.0.0',
      imageVariant: 'default',
    });

    (resolveLatestVersion as Mock).mockResolvedValueOnce({
      openclawVersion: '2.0.0',
      variant: 'default',
      imageTag: 'new-tag-from-kv',
      imageDigest: null,
      publishedAt: new Date().toISOString(),
    });

    const result = await instance.restartGateway({ imageTag: 'latest' });

    expect(result.success).toBe(true);
    expect(resolveLatestVersion).toHaveBeenCalledOnce();
    expect(storage._store.get('trackedImageTag')).toBe('new-tag-from-kv');
    expect(storage._store.get('openclawVersion')).toBe('2.0.0');
    expect(storage._store.get('imageVariant')).toBe('default');
  });

  it('falls back gracefully when "latest" but KV is empty', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { trackedImageTag: 'old-tag' });

    (resolveLatestVersion as Mock).mockResolvedValueOnce(null);

    const result = await instance.restartGateway({ imageTag: 'latest' });

    expect(result.success).toBe(true);
    expect(resolveLatestVersion).toHaveBeenCalledOnce();
    // trackedImageTag unchanged — resolveImageTag will use existing value
    expect(storage._store.get('trackedImageTag')).toBe('old-tag');
  });

  it('pins to specific tag without KV lookup and clears version metadata', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, {
      trackedImageTag: 'old-tag',
      openclawVersion: '1.0.0',
      imageVariant: 'default',
    });

    const result = await instance.restartGateway({ imageTag: '2026.2.25-abc123' });

    expect(result.success).toBe(true);
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(storage._store.get('trackedImageTag')).toBe('2026.2.25-abc123');
    expect(storage._store.get('openclawVersion')).toBeNull();
    expect(storage._store.get('imageVariant')).toBeNull();
  });
});
