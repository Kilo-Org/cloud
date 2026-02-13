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
// Keep real isFlyNotFound + FlyApiError; mock all API functions.
vi.mock('../fly/client', async () => {
  const { FlyApiError, isFlyNotFound } = await vi.importActual('../fly/client');
  return {
    FlyApiError,
    isFlyNotFound,
    createMachine: vi.fn(),
    getMachine: vi.fn(),
    startMachine: vi.fn(),
    stopMachine: vi.fn(),
    destroyMachine: vi.fn(),
    waitForState: vi.fn(),
    updateMachine: vi.fn(),
    createVolume: vi.fn(),
    deleteVolume: vi.fn(),
    getVolume: vi.fn(),
    listMachines: vi.fn().mockResolvedValue([]),
  };
});

// -- Mock db --
vi.mock('../db', () => ({
  createDatabaseConnection: vi.fn(),
  InstanceStore: vi.fn(),
}));

// -- Mock gateway/env --
vi.mock('../gateway/env', () => ({
  buildEnvVars: vi.fn().mockResolvedValue({ KILOCODE_API_KEY: 'test' }),
}));

import { KiloClawInstance } from './kiloclaw-instance';
import * as flyClient from '../fly/client';
import { FlyApiError } from '../fly/client';
import {
  ALARM_INTERVAL_RUNNING_MS,
  ALARM_INTERVAL_DESTROYING_MS,
  ALARM_INTERVAL_IDLE_MS,
  ALARM_JITTER_MS,
  SELF_HEAL_THRESHOLD,
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

function createFakeEnv() {
  return {
    FLY_API_TOKEN: 'test-token',
    FLY_APP_NAME: 'test-app',
    FLY_REGION: 'us,eu',
    GATEWAY_TOKEN_SECRET: 'test-secret',
    KILOCLAW_INSTANCE: {} as unknown,
    HYPERDRIVE: { connectionString: '' } as unknown,
  };
}

function createInstance(
  storage = createFakeStorage(),
  env = createFakeEnv()
): { instance: KiloClawInstance; storage: ReturnType<typeof createFakeStorage> } {
  const ctx = { storage } as unknown;
  const instance = new KiloClawInstance(
    ctx as ConstructorParameters<typeof KiloClawInstance>[0],
    env as ConstructorParameters<typeof KiloClawInstance>[1]
  );
  return { instance, storage };
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

    (flyClient.createVolume as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'iad',
    });

    await instance.alarm();

    expect(flyClient.createVolume).toHaveBeenCalled();
    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
  });

  it('replaces lost volume (404) with data_loss log', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyVolumeId: 'vol-dead' });

    (flyClient.getVolume as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.createVolume as Mock).mockResolvedValue({
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

    expect(flyClient.createVolume).not.toHaveBeenCalled();
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
    expect(flyClient.stopMachine).not.toHaveBeenCalled();
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

// ============================================================================
// selectRecoveryCandidate (pure function, no mocks needed)
// ============================================================================

import { selectRecoveryCandidate } from './kiloclaw-instance';
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
