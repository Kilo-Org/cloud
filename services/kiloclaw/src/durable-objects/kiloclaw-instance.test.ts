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

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

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
    listVolumes: vi.fn().mockResolvedValue([]),
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
  getActivePersonalInstance: vi.fn().mockResolvedValue(null),
  findPepperByUserId: vi.fn().mockResolvedValue({
    id: 'user-1',
    api_token_pepper: 'pepper-1',
  }),
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

// -- Mock stream-chat client --
vi.mock('../stream-chat/client', () => ({
  setupDefaultStreamChatChannel: vi.fn().mockResolvedValue({
    apiKey: 'sc-api-key',
    botUserId: 'bot-sandbox-1',
    botUserToken: 'sc-bot-token',
    channelId: 'default-sandbox-1',
  }),
  createShortLivedUserToken: vi.fn().mockResolvedValue('short-lived-token'),
  deactivateStreamChatUsers: vi.fn().mockResolvedValue(undefined),
}));

import { KiloClawInstance } from './kiloclaw-instance';
import * as flyClient from '../fly/client';
import { FlyApiError } from '../fly/client';
import * as db from '../db';
import * as gatewayEnv from '../gateway/env';
import * as regions from './regions';
import { resolveLatestVersion } from '../lib/image-version';
import { setupDefaultStreamChatChannel } from '../stream-chat/client';
import { verifyKiloToken } from '@kilocode/worker-utils';
import {
  ALARM_INTERVAL_RUNNING_MS,
  ALARM_INTERVAL_STARTING_MS,
  ALARM_INTERVAL_DESTROYING_MS,
  ALARM_INTERVAL_IDLE_MS,
  ALARM_JITTER_MS,
  SELF_HEAL_THRESHOLD,
  STARTING_TIMEOUT_MS,
  RESTARTING_TIMEOUT_MS,
  RECOVERING_TIMEOUT_MS,
  STALE_PROVISION_THRESHOLD_MS,
} from '../config';

// ============================================================================
// Test harness
// ============================================================================

/**
 * Find a structured doWarn call by message substring and verify the JSON envelope.
 * Returns the parsed log payload for further assertions.
 */
function expectStructuredWarn(spy: Mock, messageSubstring: string) {
  const call = spy.mock.calls.find(
    (c: unknown[]) => typeof c[0] === 'string' && c[0].includes(messageSubstring)
  );
  if (!call) throw new Error(`Expected a warn call containing "${messageSubstring}"`);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
  const parsed: Record<string, unknown> = JSON.parse(call[0] as string);
  expect(parsed.tag).toBe('kiloclaw_do');
  expect(parsed.level).toBe('warn');
  expect(typeof parsed.message === 'string' && parsed.message.includes(messageSubstring)).toBe(
    true
  );
  expect(parsed.error).toBeDefined();
  return parsed;
}

function createFakeStorage() {
  const store = new Map<string, unknown>();
  let alarmTime: number | null = null;

  return {
    get(keys: string | string[]): unknown {
      if (typeof keys === 'string') {
        return store.get(keys);
      }
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
  const writeDataPoint = vi.fn();
  return {
    FLY_API_TOKEN: 'test-token',
    FLY_APP_NAME: 'test-app',
    FLY_REGION: 'eu,us',
    GATEWAY_TOKEN_SECRET: 'test-secret',
    NEXTAUTH_SECRET: 'test-nextauth-secret-at-least-32-chars',
    WORKER_ENV: 'development',
    KILOCLAW_INSTANCE: {} as unknown,
    KILOCLAW_APP: {
      idFromName: vi.fn().mockReturnValue('fake-do-id'),
      get: vi.fn().mockReturnValue(appStub),
    } as unknown,
    HYPERDRIVE: { connectionString: 'postgresql://fake' } as unknown,
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown,
    KILOCLAW_AE: {
      writeDataPoint,
    } as unknown,
  };
}

function analyticsEvents(env: ReturnType<typeof createFakeEnv>): Record<string, unknown>[] {
  const dataset = env.KILOCLAW_AE as { writeDataPoint: Mock };
  return dataset.writeDataPoint.mock.calls.map(call => call[0] as Record<string, unknown>);
}

function analyticsEventsByName(
  env: ReturnType<typeof createFakeEnv>,
  eventName: string
): Record<string, unknown>[] {
  return analyticsEvents(env).filter(call => {
    const blobs = call.blobs;
    return Array.isArray(blobs) && blobs[0] === eventName;
  });
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
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

async function seedStarting(
  storage: ReturnType<typeof createFakeStorage>,
  overrides: Record<string, unknown> = {}
) {
  await seedProvisioned(storage, {
    status: 'starting',
    startingAt: Date.now(),
    lastStartedAt: null,
    ...overrides,
  });
}

async function seedRestarting(
  storage: ReturnType<typeof createFakeStorage>,
  overrides: Record<string, unknown> = {}
) {
  await seedProvisioned(storage, {
    status: 'restarting',
    flyMachineId: 'machine-1',
    restartingAt: Date.now(),
    ...overrides,
  });
}

async function seedRecovering(
  storage: ReturnType<typeof createFakeStorage>,
  overrides: Record<string, unknown> = {}
) {
  await seedProvisioned(storage, {
    status: 'recovering',
    flyMachineId: null,
    recoveryStartedAt: Date.now(),
    ...overrides,
  });
}

function dockerProviderState(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'docker-local',
    containerName: 'kiloclaw-sandbox-1',
    volumeName: 'kiloclaw-root-sandbox-1',
    hostPort: 45001,
    ...overrides,
  };
}

async function seedDockerInstance(
  storage: ReturnType<typeof createFakeStorage>,
  overrides: Record<string, unknown> = {}
) {
  await seedProvisioned(storage, {
    provider: 'docker-local',
    flyMachineId: null,
    flyVolumeId: null,
    flyRegion: null,
    providerState: dockerProviderState(),
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
  // Returns 404 for /_kilo/pairing/* so controller-first pairing falls back to fly exec.
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
      if (typeof url === 'string' && url.includes('/_kilo/pairing/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      // Root path probe — return non-502
      return Promise.resolve({ ok: true, status: 200 });
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('two-phase destroy', () => {
  it('throws with status 404 when instance was never provisioned', async () => {
    const { instance } = createInstance();

    const err: Error & { status?: number } = await instance.destroy().then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error & { status?: number }) => e
    );

    expect(err.message).toBe('Instance not provisioned');
    expect(err.status).toBe(404);
  });

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
      providerState: {
        provider: 'fly',
        appName: 'acct-test',
        machineId: 'machine-1',
        volumeId: 'vol-1',
        region: 'iad',
      },
      pendingDestroyMachineId: 'machine-1',
      pendingDestroyVolumeId: 'vol-1',
    });

    // First alarm: machine delete succeeds, volume still fails
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockRejectedValue(new FlyApiError('timeout', 503, 'retry'));

    await instance.alarm();

    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('vol-1');
    expect(storage._store.get('providerState')).toEqual({
      provider: 'fly',
      appName: 'acct-test',
      machineId: null,
      volumeId: 'vol-1',
      region: 'iad',
    });
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

  it('fully destroys docker-local instances when container and volume deletes succeed', async () => {
    const env = {
      ...createFakeEnv(),
      DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750',
    };
    const { instance, storage } = createInstance(undefined, env);
    await seedRunning(storage, {
      provider: 'docker-local',
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
      providerState: {
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      },
    });

    vi.mocked(fetch).mockImplementation(async input => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/containers/kiloclaw-sandbox-1?force=true')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    await instance.destroy();

    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });

  it('retries docker-local destroy over multiple alarms when storage deletion fails', async () => {
    const env = {
      ...createFakeEnv(),
      DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750',
    };
    const { storage } = createInstance(undefined, env);
    await seedProvisioned(storage, {
      provider: 'docker-local',
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
      providerState: {
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      },
      pendingDestroyMachineId: 'kiloclaw-sandbox-1',
      pendingDestroyVolumeId: 'kiloclaw-root-sandbox-1',
    });

    vi.mocked(fetch).mockImplementation(async input => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/containers/kiloclaw-sandbox-1?force=true')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response('volume busy', { status: 409 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    const { instance } = createInstance(storage, env);
    await instance.alarm();

    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('kiloclaw-root-sandbox-1');
    expect(storage._store.get('providerState')).toEqual({
      provider: 'docker-local',
      containerName: null,
      volumeName: 'kiloclaw-root-sandbox-1',
      hostPort: null,
    });

    vi.mocked(fetch).mockImplementation(async input => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    const { instance: retryInstance } = createInstance(storage, env);
    await retryInstance.alarm();

    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });
});

describe('destroy: recover bound machine from volume', () => {
  // Recovery tests use hex machine IDs matching real Fly format (MACHINE_ID_RE = /^[a-z0-9]+$/)
  const recoveredMachineId = '3d8de100be4289';

  it('recovers bound machine from volume and completes destroy in one alarm', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: recoveredMachineId,
      state: 'attached',
    });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const { instance } = createInstance(storage);
    await instance.alarm();

    // Recovery populated pendingDestroyMachineId, then both deletes succeeded → finalized
    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });

  it('completes destroy over two alarms after machine recovery', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    // Alarm 1: getVolume returns attached machine, destroyMachine succeeds,
    // but deleteVolume still fails (e.g. Fly needs a moment to unbind)
    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: recoveredMachineId,
      state: 'attached',
    });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockRejectedValue(
      new FlyApiError('failed_precondition: volume is currently bound to machine', 412, '{}')
    );

    const { instance: inst1 } = createInstance(storage);
    await inst1.alarm();

    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('vol-1');
    expect(storage._store.size).toBeGreaterThan(0);

    // Alarm 2: volume delete succeeds. No recovery needed (machine already cleared).
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const { instance: inst2 } = createInstance(storage);
    await inst2.alarm();

    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });

  it('skips recovery when pendingDestroyMachineId already set', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: 'machine-1',
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: 'machine-1',
      pendingDestroyVolumeId: 'vol-1',
    });

    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const { instance } = createInstance(storage);
    await instance.alarm();

    // getVolume should NOT have been called (recovery skipped)
    expect(flyClient.getVolume).not.toHaveBeenCalled();
    expect(storage._store.size).toBe(0);
  });

  it('handles getVolume 404 during destroy recovery', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    // Volume already gone
    (flyClient.getVolume as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    // deleteVolume will also see 404 → treated as success
    (flyClient.deleteVolume as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));

    const { instance } = createInstance(storage);
    await instance.alarm();

    // Both treated as gone → full cleanup
    expect(storage._store.size).toBe(0);
  });

  it('handles getVolume transient error during destroy recovery', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    // Recovery fails with transient error
    (flyClient.getVolume as Mock).mockRejectedValue(new FlyApiError('server error', 500, 'fail'));
    // Volume delete also fails (machine still bound)
    (flyClient.deleteVolume as Mock).mockRejectedValue(
      new FlyApiError('failed_precondition: bound', 412, '{}')
    );

    const { instance } = createInstance(storage);
    await instance.alarm();

    // Recovery failed, volume still pending → alarm rescheduled
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('vol-1');
    expect(storage._store.get('pendingDestroyMachineId')).toBeNull();
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('ignores null attached_machine_id from getVolume', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    // Volume exists but no machine attached
    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: null,
      state: 'detached',
    });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const { instance } = createInstance(storage);
    await instance.alarm();

    // No machine recovered, but volume delete succeeded → finalized
    expect(flyClient.destroyMachine).not.toHaveBeenCalled();
    expect(storage._store.size).toBe(0);
  });

  it('persists flyMachineId alongside pendingDestroyMachineId on recovery', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: recoveredMachineId,
      state: 'attached',
    });
    // Machine delete fails so we can inspect persisted state before finalization
    (flyClient.destroyMachine as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'fail')
    );
    (flyClient.deleteVolume as Mock).mockRejectedValue(
      new FlyApiError('failed_precondition', 412, '{}')
    );

    const { instance } = createInstance(storage);
    await instance.alarm();

    expect(flyClient.getVolume).toHaveBeenCalledTimes(1);
    expect(flyClient.destroyMachine).toHaveBeenCalledTimes(1);
    expect(storage._store.get('pendingDestroyMachineId')).toBe(recoveredMachineId);
    expect(storage._store.get('flyMachineId')).toBe(recoveredMachineId);
  });

  it('respects bound machine recovery cooldown', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
      lastBoundMachineRecoveryAt: Date.now(), // just checked
    });

    // Volume delete still fails (machine bound)
    (flyClient.deleteVolume as Mock).mockRejectedValue(
      new FlyApiError('failed_precondition: bound', 412, '{}')
    );

    const { instance } = createInstance(storage);
    await instance.alarm();

    // getVolume should NOT have been called — cooldown active
    expect(flyClient.getVolume).not.toHaveBeenCalled();
    expect(storage._store.get('pendingDestroyVolumeId')).toBe('vol-1');
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('retries bound machine recovery after cooldown expires', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
      lastBoundMachineRecoveryAt: Date.now() - 6 * 60 * 1000, // 6 min ago, past 5 min cooldown
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: recoveredMachineId,
      state: 'attached',
    });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const { instance } = createInstance(storage);
    await instance.alarm();

    // Cooldown expired → getVolume called → recovery → full cleanup
    expect(flyClient.getVolume).toHaveBeenCalledTimes(1);
    expect(storage._store.size).toBe(0);
    expect(storage._getAlarm()).toBeNull();
  });
});

describe('destroy error tracking', () => {
  it('persists structured destroy error on volume delete failure', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: null,
      state: 'detached',
    });
    (flyClient.deleteVolume as Mock).mockRejectedValue(
      new FlyApiError(
        'failed_precondition: volume is currently bound to machine: abc123',
        412,
        '{}'
      )
    );

    const { instance } = createInstance(storage);
    await instance.alarm();

    expect(storage._store.get('lastDestroyErrorOp')).toBe('volume');
    expect(storage._store.get('lastDestroyErrorStatus')).toBe(412);
    expect(storage._store.get('lastDestroyErrorMessage')).toContain('failed_precondition');
    expect(storage._store.get('lastDestroyErrorAt')).toBeTypeOf('number');
  });

  it('clears destroy error on successful delete', async () => {
    const { storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'destroying',
      flyMachineId: null,
      flyVolumeId: 'vol-1',
      pendingDestroyMachineId: null,
      pendingDestroyVolumeId: 'vol-1',
      lastDestroyErrorOp: 'volume',
      lastDestroyErrorStatus: 412,
      lastDestroyErrorMessage: 'old error',
      lastDestroyErrorAt: Date.now() - 60_000,
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-1',
      attached_machine_id: null,
      state: 'detached',
    });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const { instance } = createInstance(storage);
    await instance.alarm();

    // Error fields cleared after successful volume delete
    expect(storage._store.has('lastDestroyErrorOp')).toBe(false);
  });
});

describe('reconciliation: machine status sync', () => {
  it('transitions running to recovering after threshold failures and launches recovery once', async () => {
    const { storage } = createInstance();
    await seedRunning(storage);

    // Machine reports stopped
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    // Need SELF_HEAL_THRESHOLD consecutive alarms
    for (let i = 0; i < SELF_HEAL_THRESHOLD; i++) {
      const { instance: inst, waitUntilPromises } = createInstance(storage);
      await inst.alarm();
      if (i === SELF_HEAL_THRESHOLD - 1) {
        expect(waitUntilPromises).toHaveLength(1);
      }
    }

    expect(storage._store.get('status')).toBe('recovering');
    expect(storage._store.get('healthCheckFailCount')).toBe(0);
    expect(storage._store.get('recoveryStartedAt')).not.toBeNull();
  });

  it("does not trigger unexpected-stop recovery when Fly reports 'created'", async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'created', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(waitUntilPromises).toHaveLength(0);
    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('healthCheckFailCount')).toBe(0);
    expect(storage._store.get('recoveryStartedAt')).toBeUndefined();
  });

  it('does not relaunch automatic recovery on subsequent alarms while already recovering', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-new',
    });

    await instance.alarm();

    expect(waitUntilPromises).toHaveLength(0);
  });

  it('does not clean up a pending recovery volume while recovery is still in progress', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      pendingRecoveryVolumeId: 'vol-recovery',
      recoveryStartedAt: Date.now(),
    });

    await instance.alarm();

    expect(flyClient.getVolume).not.toHaveBeenCalledWith(expect.anything(), 'vol-recovery');
    expect(flyClient.deleteVolume).not.toHaveBeenCalledWith(expect.anything(), 'vol-recovery');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBe('vol-recovery');
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

describe('unexpected stop recovery', () => {
  it('relocates to a different region, preserves the old volume when snapshots exist, and returns to running', async () => {
    const env = createFakeEnv();
    env.FLY_REGION = 'iad,ord,cdg';
    const { storage } = createInstance(undefined, env);
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped', config: {} });
    (flyClient.getVolume as Mock).mockImplementation(async (_config: unknown, volumeId: string) => {
      if (volumeId === 'vol-1') {
        return {
          id: 'vol-1',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'iad',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      if (volumeId === 'vol-recovery') {
        return {
          id: 'vol-recovery',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      throw new Error(`unexpected volume lookup ${volumeId}`);
    });
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-recovery',
      region: 'ord',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-recovery',
      region: 'ord',
    });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.listVolumeSnapshots as Mock).mockResolvedValue([
      { id: 'snap-1', created_at: new Date().toISOString() },
    ]);

    let finalWaitUntilPromises: Promise<unknown>[] = [];
    for (let i = 0; i < SELF_HEAL_THRESHOLD; i++) {
      const { instance, waitUntilPromises } = createInstance(storage, env);
      await instance.alarm();
      finalWaitUntilPromises = waitUntilPromises;
    }

    await Promise.all(finalWaitUntilPromises);

    expect((flyClient.createVolumeWithFallback as Mock).mock.calls[0][2]).toEqual(
      expect.arrayContaining(['ord', 'cdg'])
    );
    expect((flyClient.createVolumeWithFallback as Mock).mock.calls[0][2]).not.toContain('iad');
    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('flyMachineId')).toBe('machine-recovery');
    expect(storage._store.get('flyVolumeId')).toBe('vol-recovery');
    expect(storage._store.get('flyRegion')).toBe('ord');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBeNull();
    expect(storage._store.get('recoveryPreviousVolumeId')).toBe('vol-1');
    expect(storage._store.get('recoveryPreviousVolumeCleanupAfter')).toBeGreaterThan(Date.now());
    expect(flyClient.deleteVolume).not.toHaveBeenCalledWith(expect.anything(), 'vol-1');
  });

  it('hands off to recovering reconcile when replacement machine startup times out', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-old',
      flyVolumeId: 'vol-1',
      flyRegion: 'iad',
    });

    (flyClient.getVolume as Mock).mockImplementation(async (_config: unknown, volumeId: string) => {
      if (volumeId === 'vol-1') {
        return {
          id: 'vol-1',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'iad',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      if (volumeId === 'vol-recovery') {
        return {
          id: 'vol-recovery',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      throw new Error(`unexpected volume lookup ${volumeId}`);
    });
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-recovery',
      region: 'ord',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-recovery',
      region: 'ord',
    });
    (flyClient.waitForState as Mock).mockRejectedValue(
      new FlyApiError(
        'Fly API waitForState(started) failed (408): {"error":"deadline_exceeded"}',
        408,
        '{"error":"deadline_exceeded"}'
      )
    );
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);

    await (
      instance as unknown as { recoverUnexpectedStopInBackground: () => Promise<void> }
    ).recoverUnexpectedStopInBackground();

    expect(storage._store.get('status')).toBe('recovering');
    expect(storage._store.get('flyMachineId')).toBe('machine-recovery');
    expect(storage._store.get('flyVolumeId')).toBe('vol-1');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBe('vol-recovery');
    expect(storage._store.get('lastRecoveryErrorMessage')).toBeUndefined();
    expect(flyClient.deleteVolume).not.toHaveBeenCalled();
  });

  it('stays recovering when reconcile sees the replacement machine still in created state', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-recovery',
      flyVolumeId: 'vol-1',
      pendingRecoveryVolumeId: 'vol-recovery',
      recoveryStartedAt: Date.now(),
    });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'created', config: {} });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('recovering');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBe('vol-recovery');
    expect(flyClient.deleteVolume).not.toHaveBeenCalled();
  });

  it('completes recovery from alarm reconcile once the replacement machine reaches started', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-recovery',
      flyVolumeId: 'vol-1',
      pendingRecoveryVolumeId: 'vol-recovery',
      recoveryStartedAt: Date.now(),
      flyRegion: 'iad',
    });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'started', config: {} });
    (flyClient.getVolume as Mock).mockImplementation(async (_config: unknown, volumeId: string) => {
      if (volumeId === 'vol-recovery') {
        return {
          id: 'vol-recovery',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      if (volumeId === 'vol-1') {
        return {
          id: 'vol-1',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'iad',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      throw new Error(`unexpected volume lookup ${volumeId}`);
    });
    (flyClient.listVolumeSnapshots as Mock).mockResolvedValue([]);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('flyMachineId')).toBe('machine-recovery');
    expect(storage._store.get('flyVolumeId')).toBe('vol-recovery');
    expect(storage._store.get('flyRegion')).toBe('ord');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBeNull();
    expect(storage._store.get('recoveryPreviousVolumeId')).toBeNull();
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-1');
  });

  it('fails recovery through shared cleanup when reconcile sees the replacement machine is gone', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-recovery',
      flyVolumeId: 'vol-1',
      pendingRecoveryVolumeId: 'vol-recovery',
      recoveryStartedAt: Date.now(),
    });

    (flyClient.getMachine as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-recovery',
      name: 'sandbox-1',
      state: 'detached',
      size_gb: 10,
      region: 'ord',
      attached_machine_id: null,
      created_at: new Date().toISOString(),
    });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBeNull();
    expect(storage._store.get('lastRecoveryErrorMessage')).toBe(
      'unexpected stop recovery replacement machine disappeared'
    );
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-recovery');
  });

  it('deletes the old volume immediately when it has no snapshots, force-destroying any attached machine first', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-1',
      flyVolumeId: 'vol-1',
      flyRegion: 'iad',
    });

    (flyClient.getVolume as Mock).mockImplementation(async (_config: unknown, volumeId: string) => {
      if (volumeId === 'vol-1') {
        return {
          id: 'vol-1',
          name: 'sandbox-1',
          state: 'attached',
          size_gb: 10,
          region: 'iad',
          attached_machine_id: 'machine-attached',
          created_at: new Date().toISOString(),
        };
      }
      if (volumeId === 'vol-recovery') {
        return {
          id: 'vol-recovery',
          name: 'sandbox-1',
          state: 'detached',
          size_gb: 10,
          region: 'ord',
          attached_machine_id: null,
          created_at: new Date().toISOString(),
        };
      }
      throw new Error(`unexpected volume lookup ${volumeId}`);
    });
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-recovery',
      region: 'ord',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({
      id: 'machine-recovery',
      region: 'ord',
    });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.getMachine as Mock).mockResolvedValue({
      config: { metadata: { kiloclaw_sandbox_id: 'sandbox-1' } },
    });
    (flyClient.listVolumeSnapshots as Mock).mockResolvedValue([]);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await (
      instance as unknown as { recoverUnexpectedStopInBackground: () => Promise<void> }
    ).recoverUnexpectedStopInBackground();

    expect(flyClient.destroyMachine).toHaveBeenCalledWith(expect.anything(), 'machine-1', true);
    expect(flyClient.destroyMachine).toHaveBeenCalledWith(
      expect.anything(),
      'machine-attached',
      true
    );
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-1');
    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('recoveryPreviousVolumeId')).toBeNull();
    expect(storage._store.get('recoveryPreviousVolumeCleanupAfter')).toBeNull();
  });

  it('cleans up retained recovery volumes after the TTL, force-destroying any attached machine first', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'stopped',
      flyMachineId: null,
      flyVolumeId: 'vol-current',
      recoveryPreviousVolumeId: 'vol-old',
      recoveryPreviousVolumeCleanupAfter: Date.now() - 1_000,
    });

    (flyClient.getVolume as Mock).mockImplementation(async (_config: unknown, volumeId: string) => {
      if (volumeId === 'vol-old') {
        return {
          id: 'vol-old',
          name: 'sandbox-1',
          state: 'attached',
          size_gb: 10,
          region: 'iad',
          attached_machine_id: 'machine-old',
          created_at: new Date().toISOString(),
        };
      }
      return {
        id: 'vol-current',
        name: 'sandbox-1',
        state: 'detached',
        size_gb: 10,
        region: 'iad',
        attached_machine_id: null,
        created_at: new Date().toISOString(),
      };
    });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.getMachine as Mock).mockResolvedValue({
      config: { metadata: { kiloclaw_sandbox_id: 'sandbox-1' } },
    });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.alarm();

    expect(flyClient.destroyMachine).toHaveBeenCalledWith(expect.anything(), 'machine-old', true);
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-old');
    expect(storage._store.get('recoveryPreviousVolumeId')).toBeNull();
    expect(storage._store.get('recoveryPreviousVolumeCleanupAfter')).toBeNull();
  });

  it('allows admin cleanup of a retained recovery volume and clears the retention fields', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'running',
      recoveryPreviousVolumeId: 'vol-old',
      recoveryPreviousVolumeCleanupAfter: Date.now() + 60_000,
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-old',
      name: 'sandbox-1',
      state: 'attached',
      size_gb: 10,
      region: 'iad',
      attached_machine_id: 'machine-old',
      created_at: new Date().toISOString(),
    });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.getMachine as Mock).mockResolvedValue({
      config: { metadata: { kiloclaw_sandbox_id: 'sandbox-1' } },
    });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    const result = await instance.cleanupRecoveryPreviousVolume();

    expect(result).toEqual({ ok: true, deletedVolumeId: 'vol-old' });
    expect(flyClient.destroyMachine).toHaveBeenCalledWith(expect.anything(), 'machine-old', true);
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-old');
    expect(storage._store.get('recoveryPreviousVolumeId')).toBeNull();
    expect(storage._store.get('recoveryPreviousVolumeCleanupAfter')).toBeNull();
  });

  it('times out recovering instances through the shared failure cleanup path', async () => {
    const { instance, storage } = createInstance();
    await seedRecovering(storage, {
      flyMachineId: 'machine-recovery',
      pendingRecoveryVolumeId: 'vol-recovery',
      recoveryStartedAt: Date.now() - RECOVERING_TIMEOUT_MS - 1_000,
    });

    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-recovery',
      name: 'sandbox-1',
      state: 'detached',
      size_gb: 10,
      region: 'ord',
      attached_machine_id: null,
      created_at: new Date().toISOString(),
    });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);

    await instance.alarm();

    expect(flyClient.destroyMachine).toHaveBeenCalledWith(
      expect.anything(),
      'machine-recovery',
      true
    );
    expect(flyClient.deleteVolume).toHaveBeenCalledWith(expect.anything(), 'vol-recovery');
    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('pendingRecoveryVolumeId')).toBeNull();
    expect(storage._store.get('lastRecoveryErrorMessage')).toBe(
      'unexpected stop recovery timed out'
    );
  });

  it('refuses retained volume cleanup when the attached machine belongs to a different sandbox', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'running',
      recoveryPreviousVolumeId: 'vol-old',
      recoveryPreviousVolumeCleanupAfter: Date.now() + 60_000,
    });

    (flyClient.getVolume as Mock).mockResolvedValue({
      id: 'vol-old',
      name: 'sandbox-1',
      state: 'attached',
      size_gb: 10,
      region: 'iad',
      attached_machine_id: 'machine-other',
      created_at: new Date().toISOString(),
    });
    (flyClient.getMachine as Mock).mockResolvedValue({
      config: { metadata: { kiloclaw_sandbox_id: 'sandbox-other' } },
    });

    await expect(instance.cleanupRecoveryPreviousVolume()).rejects.toThrow(
      'Refusing to destroy attached machine machine-other'
    );
    expect(flyClient.destroyMachine).not.toHaveBeenCalled();
    expect(flyClient.deleteVolume).not.toHaveBeenCalled();
    expect(storage._store.get('recoveryPreviousVolumeId')).toBe('vol-old');
    expect(storage._store.get('recoveryPreviousVolumeCleanupAfter')).not.toBeNull();
  });
});

describe('reconciliation: Fly failed state', () => {
  it("immediately transitions running → stopped on Fly 'failed' (no threshold)", async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'failed', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    // Single alarm should be enough — no SELF_HEAL_THRESHOLD wait
    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('healthCheckFailCount')).toBe(0);
    expect(storage._store.get('lastStoppedAt')).not.toBeNull();
  });

  it("immediately transitions starting → stopped on Fly 'failed' and clears startingAt", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, { flyMachineId: 'machine-1' });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'failed', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('startingAt')).toBeNull();
    expect(storage._store.get('lastStoppedAt')).not.toBeNull();
  });

  it("is a no-op when already stopped and Fly reports 'failed'", async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: 'machine-1' });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'failed', config: {} });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
  });

  it("live check marks stopped in-memory on Fly 'failed'", async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'failed',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    // First call returns cached 'running'; live check fires in background
    const result1 = await instance.getStatus();
    await Promise.all(waitUntilPromises);

    // Second call sees in-memory update from live check
    const result2 = await instance.getStatus();

    expect(result1.status).toBe('running'); // fire-and-forget: cached
    expect(result2.status).toBe('stopped'); // updated in-memory by live check
    // Storage is NOT updated — alarm loop owns persistence
    expect(storage._store.get('status')).toBe('running');
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

describe('buildUserEnvVars API key refresh', () => {
  async function callBuildUserEnvVars(instance: KiloClawInstance) {
    await (instance as unknown as { loadState: () => Promise<void> }).loadState();
    return await (
      instance as unknown as {
        buildUserEnvVars: () => Promise<{
          envVars: Record<string, string>;
          bootstrapEnv: Record<string, string>;
          minSecretsVersion: number;
        }>;
      }
    ).buildUserEnvVars();
  }

  beforeEach(() => {
    (gatewayEnv.buildEnvVars as Mock).mockClear();
    (db.findPepperByUserId as Mock).mockResolvedValue({
      id: 'user-1',
      api_token_pepper: 'pepper-1',
    });
  });

  it('mints a fresh key, persists it, and passes it to buildEnvVars', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stale-key',
      kilocodeApiKeyExpiresAt: '2026-12-01T00:00:00.000Z',
    });

    const result = await callBuildUserEnvVars(instance);

    expect(result.minSecretsVersion).toBe(1);
    expect(db.findPepperByUserId).toHaveBeenCalledTimes(1);
    expect(gatewayEnv.buildEnvVars).toHaveBeenCalledTimes(1);

    const options = (gatewayEnv.buildEnvVars as Mock).mock.calls[0][3] as {
      kilocodeApiKey?: string;
    };
    expect(options.kilocodeApiKey).toBeTypeOf('string');
    expect(options.kilocodeApiKey).not.toBe('stale-key');
    expect(storage._store.get('kilocodeApiKey')).toBe(options.kilocodeApiKey);
    expect(storage._store.get('kilocodeApiKeyExpiresAt')).toBeTypeOf('string');

    const payload = await verifyKiloToken(
      options.kilocodeApiKey!,
      'test-nextauth-secret-at-least-32-chars'
    );
    expect(payload.kiloUserId).toBe('user-1');
    expect(payload.apiTokenPepper).toBe('pepper-1');
    expect(payload.env).toBe('development');
  });

  it('falls back to the stored key when Hyperdrive is unavailable', async () => {
    const env = createFakeEnv();
    env.HYPERDRIVE = { connectionString: '' } as never;
    const { instance, storage } = createInstance(createFakeStorage(), env);
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-12-01T00:00:00.000Z',
    });

    await callBuildUserEnvVars(instance);

    expect(db.findPepperByUserId).not.toHaveBeenCalled();
    const options = (gatewayEnv.buildEnvVars as Mock).mock.calls[0][3] as {
      kilocodeApiKey?: string;
    };
    expect(options.kilocodeApiKey).toBe('stored-key');
    expect(storage._store.get('kilocodeApiKey')).toBe('stored-key');
  });

  it('rejects when Hyperdrive is unavailable and the stored key is expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));

    const env = createFakeEnv();
    env.HYPERDRIVE = { connectionString: '' } as never;
    const { instance, storage } = createInstance(createFakeStorage(), env);
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-03-10T11:59:59.000Z',
    });

    await expect(callBuildUserEnvVars(instance)).rejects.toThrow(
      'Cannot build env vars: stored KiloCode API key expired and fresh mint unavailable'
    );
    expect(db.findPepperByUserId).not.toHaveBeenCalled();
    expect(gatewayEnv.buildEnvVars).not.toHaveBeenCalled();
  });

  it('falls back to the stored key and logs when the user is missing', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-12-01T00:00:00.000Z',
    });
    (db.findPepperByUserId as Mock).mockResolvedValueOnce(null);

    await callBuildUserEnvVars(instance);

    expect(console.warn).toHaveBeenCalledWith('[DO] mintFreshApiKey: user not found in DB');
    const options = (gatewayEnv.buildEnvVars as Mock).mock.calls[0][3] as {
      kilocodeApiKey?: string;
    };
    expect(options.kilocodeApiKey).toBe('stored-key');
  });

  it('falls back to the stored key and logs when the DB lookup throws', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-12-01T00:00:00.000Z',
    });
    const err = new Error('db down');
    (db.findPepperByUserId as Mock).mockRejectedValueOnce(err);

    await callBuildUserEnvVars(instance);

    const warningCall = (console.warn as Mock).mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('buildUserEnvVars: failed to mint fresh API key') &&
        call[0].includes('db down')
    );
    expect(warningCall).toBeDefined();
    const options = (gatewayEnv.buildEnvVars as Mock).mock.calls[0][3] as {
      kilocodeApiKey?: string;
    };
    expect(options.kilocodeApiKey).toBe('stored-key');
  });

  it('rejects when minting fails and the stored key is expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));

    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-03-10T11:59:59.000Z',
    });
    const err = new Error('db down');
    (db.findPepperByUserId as Mock).mockRejectedValueOnce(err);

    await expect(callBuildUserEnvVars(instance)).rejects.toThrow(
      'Cannot build env vars: stored KiloCode API key expired and fresh mint unavailable'
    );
    const warningCall = (console.warn as Mock).mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('buildUserEnvVars: failed to mint fresh API key') &&
        call[0].includes('db down')
    );
    expect(warningCall).toBeDefined();
    expect(gatewayEnv.buildEnvVars).not.toHaveBeenCalled();
  });

  it('falls back to the stored key and logs when minting times out', async () => {
    vi.useFakeTimers();

    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-12-01T00:00:00.000Z',
    });
    (db.findPepperByUserId as Mock).mockImplementationOnce(() => new Promise(() => undefined));

    const buildPromise = callBuildUserEnvVars(instance);
    await vi.advanceTimersByTimeAsync(5_000);
    await buildPromise;

    const warningCall = (console.warn as Mock).mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        call[0].includes('buildUserEnvVars: failed to mint fresh API key') &&
        call[0].includes('API key mint timed out')
    );
    expect(warningCall).toBeDefined();

    const options = (gatewayEnv.buildEnvVars as Mock).mock.calls[0][3] as {
      kilocodeApiKey?: string;
    };
    expect(options.kilocodeApiKey).toBe('stored-key');
  });

  it('rejects env building when NEXTAUTH_SECRET is missing', async () => {
    const env = {
      ...createFakeEnv(),
      NEXTAUTH_SECRET: undefined,
    } as unknown as ReturnType<typeof createFakeEnv>;
    const { instance, storage } = createInstance(createFakeStorage(), env);
    await seedProvisioned(storage, {
      kilocodeApiKey: 'stored-key',
      kilocodeApiKeyExpiresAt: '2026-12-01T00:00:00.000Z',
    });

    await expect(callBuildUserEnvVars(instance)).rejects.toThrow(
      'Cannot build env vars: NEXTAUTH_SECRET missing'
    );
    expect(db.findPepperByUserId).not.toHaveBeenCalled();
    expect(gatewayEnv.buildEnvVars).not.toHaveBeenCalled();
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

describe('start: not provisioned', () => {
  it('throws with status 404 when instance was never provisioned', async () => {
    const { instance } = createInstance();

    const err: Error & { status?: number } = await instance.start('user-1').then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error & { status?: number }) => e
    );

    expect(err.message).toBe('Instance not provisioned');
    expect(err.status).toBe(404);
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

  it('clears the stale machine id before retrying replacement creation after a 404', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped' });

    (flyClient.getMachine as Mock).mockRejectedValue(new FlyApiError('not found', 404, '{}'));
    (flyClient.createMachine as Mock).mockRejectedValue(new Error('create failed'));
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await expect(instance.start('user-1')).rejects.toThrow('create failed');

    expect(storage._store.get('flyMachineId')).toBeNull();
    expect(storage._store.get('providerState')).toEqual(
      expect.objectContaining({
        provider: 'fly',
        appName: null,
        machineId: null,
        volumeId: 'vol-1',
      })
    );
  });

  it('persists machine size backfill before start completion for legacy instances', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, {
      status: 'stopped',
      machineSize: null,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'stopped',
      config: { guest: { cpus: 4, memory_mb: 8192, cpu_kind: 'performance' } },
    });
    (flyClient.updateMachine as Mock).mockRejectedValue(new Error('update failed'));
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await expect(instance.start('user-1')).rejects.toThrow('update failed');

    expect(storage._store.get('machineSize')).toEqual({
      cpus: 4,
      memory_mb: 8192,
      cpu_kind: 'performance',
    });
  });
});

describe('startExistingMachine: failed Fly machine', () => {
  it('restarts a failed machine via updateMachine instead of timing out', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyMachineId: 'machine-1' });

    // Machine is in 'failed' state on Fly
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'failed', config: {} });
    (flyClient.updateMachine as Mock).mockResolvedValue({});
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.start('user-1');

    // updateMachine should have been called (not just waitForState)
    expect(flyClient.updateMachine).toHaveBeenCalled();
    expect(storage._store.get('status')).toBe('running');
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

import { selectRecoveryCandidate } from './machine-recovery';
import {
  parseRegions,
  deprioritizeRegion,
  shuffleRegions,
  isMetaRegion,
  prepareRegions,
  resolveRegions,
  FLY_REGIONS_KV_KEY,
} from './regions';
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

  it("recovers failed machine as 'stopped'", async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: null });

    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.listMachines as Mock).mockResolvedValue([
      fakeMachine({
        id: 'failed-machine',
        state: 'failed',
        region: 'ord',
        config: { image: 'test:latest', mounts: [{ volume: 'vol-1', path: '/root' }] },
      }),
    ]);

    await instance.alarm();

    expect(storage._store.get('flyMachineId')).toBe('failed-machine');
    expect(storage._store.get('status')).toBe('stopped');
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

describe('start: metadata recovery re-arms alarm', () => {
  it('schedules alarm when recovery finds a running machine and start fast-paths', async () => {
    const { instance, storage } = createInstance();
    // Instance has identity but lost its machine ID; status is stopped.
    await seedProvisioned(storage, { flyMachineId: null, status: 'stopped' });

    // attemptMetadataRecovery will find a started machine and set status to 'running'
    (flyClient.listMachines as Mock).mockResolvedValue([
      fakeMachine({
        id: 'recovered-machine',
        state: 'started',
        region: 'iad',
        config: { image: 'test:latest', mounts: [{ volume: 'vol-1', path: '/root' }] },
      }),
    ]);
    // getMachine confirms the machine is started (used by the fast-path check)
    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });

    await instance.start('user-1');

    // Fast-path returned: no machine creation
    expect(flyClient.createMachine).not.toHaveBeenCalled();
    // Status should be running
    expect(storage._store.get('status')).toBe('running');
    // Alarm must have been scheduled (not null)
    expect(storage._getAlarm()).not.toBeNull();
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

  it('updateChannels dual-writes to encryptedSecrets (no interleave drift)', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    // Write via legacy path
    await instance.updateChannels({ telegramBotToken: fakeEnvelope });

    // channels uses field keys, encryptedSecrets uses env var names
    const channels = storage._store.get('channels') as Record<string, unknown>;
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(channels.telegramBotToken).toEqual(fakeEnvelope);
    expect(secrets.TELEGRAM_BOT_TOKEN).toEqual(fakeEnvelope);
  });

  it('interleaving updateChannels and updateSecrets keeps storage in sync', async () => {
    const discordEnvelope = { ...fakeEnvelope, encryptedData: 'discord-data' };
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    // Step 1: set telegram via updateSecrets (new path)
    await instance.updateSecrets({ telegramBotToken: fakeEnvelope });

    // Step 2: set discord via updateChannels (legacy path, delegates to updateSecrets)
    const result = await instance.updateChannels({ discordBotToken: discordEnvelope });

    // Both should be present via legacy response
    expect(result.telegram).toBe(true);
    expect(result.discord).toBe(true);

    // channels uses field keys, encryptedSecrets uses env var names
    const channels = storage._store.get('channels') as Record<string, unknown>;
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(channels.telegramBotToken).toEqual(fakeEnvelope);
    expect(channels.discordBotToken).toEqual(discordEnvelope);
    expect(secrets.TELEGRAM_BOT_TOKEN).toEqual(fakeEnvelope);
    expect(secrets.DISCORD_BOT_TOKEN).toEqual(discordEnvelope);
  });
});

// ============================================================================
// updateSecrets
// ============================================================================

describe('updateSecrets', () => {
  const fakeEnvelope = {
    encryptedData: 'data',
    encryptedDEK: 'dek',
    algorithm: 'rsa-aes-256-gcm' as const,
    version: 1 as const,
  };

  it('stores env var names in encryptedSecrets but field keys in channels', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.updateSecrets({ telegramBotToken: fakeEnvelope });

    expect(result.configured).toContain('telegramBotToken');
    // channels uses field keys (for decryptChannelTokens backward compat)
    const channels = storage._store.get('channels') as Record<string, unknown>;
    expect(channels.telegramBotToken).toEqual(fakeEnvelope);
    // encryptedSecrets uses env var names (for buildEnvVars/mergeEnvVarsWithSecrets)
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.TELEGRAM_BOT_TOKEN).toEqual(fakeEnvelope);
    expect(secrets.telegramBotToken).toBeUndefined();
  });

  it('removes a secret when null is passed', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { telegramBotToken: fakeEnvelope },
      encryptedSecrets: { TELEGRAM_BOT_TOKEN: fakeEnvelope },
    });

    const result = await instance.updateSecrets({ telegramBotToken: null });

    expect(result.configured).not.toContain('telegramBotToken');
    expect(storage._store.get('channels')).toBeNull();
    expect(storage._store.get('encryptedSecrets')).toBeNull();
  });

  it('merges with existing secrets — setting telegram preserves discord', async () => {
    const discordEnvelope = { ...fakeEnvelope, encryptedData: 'discord-data' };
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { discordBotToken: discordEnvelope },
      encryptedSecrets: { DISCORD_BOT_TOKEN: discordEnvelope },
    });

    const result = await instance.updateSecrets({ telegramBotToken: fakeEnvelope });

    expect(result.configured).toContain('telegramBotToken');
    expect(result.configured).toContain('discordBotToken');
    const channels = storage._store.get('channels') as Record<string, unknown>;
    expect(channels.telegramBotToken).toEqual(fakeEnvelope);
    expect(channels.discordBotToken).toEqual(discordEnvelope);
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.TELEGRAM_BOT_TOKEN).toEqual(fakeEnvelope);
    expect(secrets.DISCORD_BOT_TOKEN).toEqual(discordEnvelope);
  });

  it('saving Brave API key disables Exa mode', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      kiloExaSearchMode: 'kilo-proxy',
    });

    await instance.updateSecrets({ braveSearchApiKey: fakeEnvelope });

    expect(storage._store.get('kiloExaSearchMode')).toBe('disabled');
  });

  it('reads from legacy channels field when encryptedSecrets is empty', async () => {
    const { instance, storage } = createInstance();
    // Simulate legacy state: only channels field, no encryptedSecrets
    await seedProvisioned(storage, {
      channels: { telegramBotToken: fakeEnvelope },
    });

    const discordEnvelope = { ...fakeEnvelope, encryptedData: 'discord-data' };
    const result = await instance.updateSecrets({ discordBotToken: discordEnvelope });

    // Should see both: legacy telegram + new discord
    expect(result.configured).toContain('telegramBotToken');
    expect(result.configured).toContain('discordBotToken');
  });

  it('removing all secrets sets both storage fields to null', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { telegramBotToken: fakeEnvelope },
      encryptedSecrets: { TELEGRAM_BOT_TOKEN: fakeEnvelope },
    });

    const result = await instance.updateSecrets({ telegramBotToken: null });

    expect(result.configured).toEqual([]);
    expect(storage._store.get('channels')).toBeNull();
    expect(storage._store.get('encryptedSecrets')).toBeNull();
  });

  it('sets both slack tokens and dual-writes to channels', async () => {
    const slackBotEnvelope = { ...fakeEnvelope, encryptedData: 'slack-bot' };
    const slackAppEnvelope = { ...fakeEnvelope, encryptedData: 'slack-app' };
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.updateSecrets({
      slackBotToken: slackBotEnvelope,
      slackAppToken: slackAppEnvelope,
    });

    expect(result.configured).toContain('slackBotToken');
    expect(result.configured).toContain('slackAppToken');
    const channels = storage._store.get('channels') as Record<string, unknown>;
    expect(channels.slackBotToken).toEqual(slackBotEnvelope);
    expect(channels.slackAppToken).toEqual(slackAppEnvelope);
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.SLACK_BOT_TOKEN).toEqual(slackBotEnvelope);
    expect(secrets.SLACK_APP_TOKEN).toEqual(slackAppEnvelope);
  });

  it('clears both slack tokens simultaneously', async () => {
    const slackBotEnvelope = { ...fakeEnvelope, encryptedData: 'slack-bot' };
    const slackAppEnvelope = { ...fakeEnvelope, encryptedData: 'slack-app' };
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { slackBotToken: slackBotEnvelope, slackAppToken: slackAppEnvelope },
      encryptedSecrets: { SLACK_BOT_TOKEN: slackBotEnvelope, SLACK_APP_TOKEN: slackAppEnvelope },
    });

    const result = await instance.updateSecrets({
      slackBotToken: null,
      slackAppToken: null,
    });

    expect(result.configured).not.toContain('slackBotToken');
    expect(result.configured).not.toContain('slackAppToken');
    expect(storage._store.get('channels')).toBeNull();
    expect(storage._store.get('encryptedSecrets')).toBeNull();
  });

  it('second updateSecrets call does not accumulate phantom entries', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    // First call: set telegram
    await instance.updateSecrets({ telegramBotToken: fakeEnvelope });

    // Second call: set discord — telegram should persist, no phantom keys
    const discordEnvelope = { ...fakeEnvelope, encryptedData: 'discord-data' };
    const result = await instance.updateSecrets({ discordBotToken: discordEnvelope });

    expect(result.configured).toEqual(
      expect.arrayContaining(['telegramBotToken', 'discordBotToken'])
    );
    expect(result.configured).toHaveLength(2);

    // encryptedSecrets should have exactly 2 env var keys, no field key duplicates
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    const secretKeys = Object.keys(secrets).sort();
    expect(secretKeys).toEqual(['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']);

    // channels should have exactly 2 field keys
    const channels = storage._store.get('channels') as Record<string, unknown>;
    const channelKeys = Object.keys(channels).sort();
    expect(channelKeys).toEqual(['discordBotToken', 'telegramBotToken']);
  });

  it('configured return uses field keys not env var names', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.updateSecrets({ telegramBotToken: fakeEnvelope });

    // Should return field keys, not env var names
    expect(result.configured).toContain('telegramBotToken');
    expect(result.configured).not.toContain('TELEGRAM_BOT_TOKEN');
  });

  it('rejects partial clear of allFieldsRequired entry', async () => {
    const slackBotEnvelope = { ...fakeEnvelope, encryptedData: 'slack-bot' };
    const slackAppEnvelope = { ...fakeEnvelope, encryptedData: 'slack-app' };
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { slackBotToken: slackBotEnvelope, slackAppToken: slackAppEnvelope },
      encryptedSecrets: { SLACK_BOT_TOKEN: slackBotEnvelope, SLACK_APP_TOKEN: slackAppEnvelope },
    });

    // Removing only one Slack token should fail — allFieldsRequired
    await expect(instance.updateSecrets({ slackBotToken: null })).rejects.toThrow(
      'Invalid secret patch: Slack requires all fields to be set together'
    );
  });

  // ─── Custom (non-catalog) secrets ─────────────────────────────────

  it('stores custom secrets by env var name in encryptedSecrets', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };

    await instance.updateSecrets({ MY_CUSTOM_KEY: customEnvelope });

    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.MY_CUSTOM_KEY).toEqual(customEnvelope);
  });

  it('removes custom secrets when null is passed', async () => {
    const { instance, storage } = createInstance();
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };
    await seedProvisioned(storage, {
      encryptedSecrets: { MY_CUSTOM_KEY: customEnvelope },
    });

    await instance.updateSecrets({ MY_CUSTOM_KEY: null });

    const secrets = storage._store.get('encryptedSecrets');
    expect(secrets).toBeNull();
  });

  it('preserves catalog secrets when adding custom secrets', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      channels: { telegramBotToken: fakeEnvelope },
      encryptedSecrets: { TELEGRAM_BOT_TOKEN: fakeEnvelope },
    });
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };

    await instance.updateSecrets({ MY_CUSTOM_KEY: customEnvelope });

    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.TELEGRAM_BOT_TOKEN).toEqual(fakeEnvelope);
    expect(secrets.MY_CUSTOM_KEY).toEqual(customEnvelope);
  });

  it('preserves custom secrets when updating catalog secrets', async () => {
    const { instance, storage } = createInstance();
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };
    await seedProvisioned(storage, {
      encryptedSecrets: { MY_CUSTOM_KEY: customEnvelope },
    });

    await instance.updateSecrets({ telegramBotToken: fakeEnvelope });

    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.MY_CUSTOM_KEY).toEqual(customEnvelope);
    expect(secrets.TELEGRAM_BOT_TOKEN).toEqual(fakeEnvelope);
  });

  it('enforces custom secret count limit', async () => {
    const { instance, storage } = createInstance();
    // Seed 50 custom secrets (the max)
    const existingSecrets: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      existingSecrets[`SECRET_${i}`] = { ...fakeEnvelope, encryptedData: `val-${i}` };
    }
    await seedProvisioned(storage, { encryptedSecrets: existingSecrets });

    // Adding one more should fail
    await expect(
      instance.updateSecrets({ SECRET_OVERFLOW: { ...fakeEnvelope, encryptedData: 'overflow' } })
    ).rejects.toThrow('Custom secret limit exceeded');
  });

  it('stores config path metadata alongside secrets', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };

    await instance.updateSecrets(
      { MY_KEY: customEnvelope },
      { MY_KEY: { configPath: 'models.providers.openai.apiKey' } }
    );

    const meta = storage._store.get('customSecretMeta') as Record<string, unknown>;
    expect(meta).toEqual({ MY_KEY: { configPath: 'models.providers.openai.apiKey' } });
  });

  it('removes config path metadata when secret is deleted', async () => {
    const { instance, storage } = createInstance();
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };
    await seedProvisioned(storage, {
      encryptedSecrets: { MY_KEY: customEnvelope },
      customSecretMeta: { MY_KEY: { configPath: 'talk.apiKey' } },
    });

    await instance.updateSecrets({ MY_KEY: null });

    const meta = storage._store.get('customSecretMeta');
    expect(meta).toBeNull();
  });

  it('updates config path metadata without changing value', async () => {
    const { instance, storage } = createInstance();
    const customEnvelope = { ...fakeEnvelope, encryptedData: 'custom-value' };
    await seedProvisioned(storage, {
      encryptedSecrets: { MY_KEY: customEnvelope },
      customSecretMeta: { MY_KEY: { configPath: 'talk.apiKey' } },
    });

    // Empty secrets patch, only meta update
    await instance.updateSecrets({}, { MY_KEY: { configPath: 'cron.webhookToken' } });

    const meta = storage._store.get('customSecretMeta') as Record<string, unknown>;
    expect(meta).toEqual({ MY_KEY: { configPath: 'cron.webhookToken' } });
    // Secret value unchanged
    const secrets = storage._store.get('encryptedSecrets') as Record<string, unknown>;
    expect(secrets.MY_KEY).toEqual(customEnvelope);
  });

  it('rejects duplicate config paths', async () => {
    const { instance, storage } = createInstance();
    const envelope1 = { ...fakeEnvelope, encryptedData: 'val-1' };
    const envelope2 = { ...fakeEnvelope, encryptedData: 'val-2' };
    await seedProvisioned(storage, {
      encryptedSecrets: { KEY_A: envelope1 },
      customSecretMeta: { KEY_A: { configPath: 'talk.apiKey' } },
    });

    await expect(
      instance.updateSecrets({ KEY_B: envelope2 }, { KEY_B: { configPath: 'talk.apiKey' } })
    ).rejects.toThrow('Config path "talk.apiKey" is already used by secret "KEY_A"');
  });
});

// ============================================================================
// updateGoogleCredentials
// ============================================================================

describe('updateGoogleCredentials', () => {
  it('persists gmailPushOidcEmail from credentials', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGoogleCredentials({
      gogConfigTarball: {
        encryptedData: 'enc-data',
        encryptedDEK: 'enc-dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      },
      email: 'user@example.com',
      gmailPushOidcEmail: 'gmail-push@my-project.iam.gserviceaccount.com',
    });

    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gmailPushOidcEmail: 'gmail-push@my-project.iam.gserviceaccount.com',
      })
    );
    expect(storage._store.get('gmailPushOidcEmail')).toBe(
      'gmail-push@my-project.iam.gserviceaccount.com'
    );
  });

  it('sets gmailPushOidcEmail to null when not provided in credentials', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      gmailPushOidcEmail: 'old@project.iam.gserviceaccount.com',
    });

    await instance.updateGoogleCredentials({
      gogConfigTarball: {
        encryptedData: 'enc-data',
        encryptedDEK: 'enc-dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      },
      email: 'user@example.com',
    });

    expect(storage._store.get('gmailPushOidcEmail')).toBeNull();
  });

  it('enables gmailNotificationsEnabled when storing Google credentials', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGoogleCredentials({
      gogConfigTarball: {
        encryptedData: 'enc-data',
        encryptedDEK: 'enc-dek',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      },
      email: 'user@example.com',
      gmailPushOidcEmail: 'sa@project.iam.gserviceaccount.com',
    });

    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gmailNotificationsEnabled: true,
      })
    );
    expect(storage._store.get('gmailNotificationsEnabled')).toBe(true);
  });
});

// ============================================================================
// clearGoogleCredentials
// ============================================================================

describe('clearGoogleCredentials', () => {
  it('sets googleCredentials to null and gmailNotificationsEnabled to false in storage', async () => {
    const { instance, storage } = createInstance();
    const fakeCredentials = {
      clientSecretJson: 'secret',
      oauthTokensJson: 'tokens',
    };
    await seedProvisioned(storage, {
      googleCredentials: fakeCredentials,
      gmailNotificationsEnabled: true,
      gmailPushOidcEmail: 'gmail-push@project.iam.gserviceaccount.com',
    });

    const putSpy = vi.spyOn(storage, 'put');

    const result = await instance.clearGoogleCredentials();

    expect(result.googleConnected).toBe(false);
    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        googleCredentials: null,
        gmailNotificationsEnabled: false,
        gmailPushOidcEmail: null,
      })
    );
    expect(storage._store.get('googleCredentials')).toBeNull();
    expect(storage._store.get('gmailNotificationsEnabled')).toBe(false);
    expect(storage._store.get('gmailPushOidcEmail')).toBeNull();
  });
});

// ============================================================================
// updateGmailNotifications
// ============================================================================

describe('updateGmailNotifications', () => {
  const fakeCredentials = {
    gogConfigTarball: {
      encryptedData: 'enc-data',
      encryptedDEK: 'enc-dek',
      algorithm: 'rsa-aes-256-gcm' as const,
      version: 1 as const,
    },
    email: 'user@example.com',
  };

  it('enables notifications when Google credentials exist', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      googleCredentials: fakeCredentials,
      gmailNotificationsEnabled: false,
    });

    const putSpy = vi.spyOn(storage, 'put');

    const result = await instance.updateGmailNotifications(true);

    expect(result.gmailNotificationsEnabled).toBe(true);
    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gmailNotificationsEnabled: true,
      })
    );
    expect(storage._store.get('gmailNotificationsEnabled')).toBe(true);
  });

  it('throws when enabling without a connected Google account', async () => {
    const { instance, storage } = createInstance();
    // Seed without googleCredentials so it defaults to null
    await seedProvisioned(storage, { gmailNotificationsEnabled: false });

    await expect(instance.updateGmailNotifications(true)).rejects.toThrow(
      'Cannot enable Gmail notifications without a connected Google account'
    );
  });

  it('disables notifications regardless of credentials', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      googleCredentials: fakeCredentials,
      gmailNotificationsEnabled: true,
    });

    const putSpy = vi.spyOn(storage, 'put');

    const result = await instance.updateGmailNotifications(false);

    expect(result.gmailNotificationsEnabled).toBe(false);
    expect(putSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gmailNotificationsEnabled: false,
      })
    );
    expect(storage._store.get('gmailNotificationsEnabled')).toBe(false);
  });
});

// ============================================================================
// updateGmailHistoryId
// ============================================================================

describe('updateGmailHistoryId', () => {
  it('stores historyId when none exists', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { gmailLastHistoryId: null });

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGmailHistoryId('100');

    expect(putSpy).toHaveBeenCalledWith(expect.objectContaining({ gmailLastHistoryId: '100' }));
    expect(storage._store.get('gmailLastHistoryId')).toBe('100');
  });

  it('updates when new value is greater', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { gmailLastHistoryId: '100' });

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGmailHistoryId('200');

    expect(putSpy).toHaveBeenCalledWith(expect.objectContaining({ gmailLastHistoryId: '200' }));
    expect(storage._store.get('gmailLastHistoryId')).toBe('200');
  });

  it('ignores when new value is equal', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { gmailLastHistoryId: '100' });

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGmailHistoryId('100');

    expect(putSpy).not.toHaveBeenCalled();
    expect(storage._store.get('gmailLastHistoryId')).toBe('100');
  });

  it('ignores when new value is lower', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { gmailLastHistoryId: '200' });

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGmailHistoryId('100');

    expect(putSpy).not.toHaveBeenCalled();
    expect(storage._store.get('gmailLastHistoryId')).toBe('200');
  });

  it('ignores invalid (non-numeric) input', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { gmailLastHistoryId: '100' });

    const putSpy = vi.spyOn(storage, 'put');

    await instance.updateGmailHistoryId('not-a-number');

    expect(putSpy).not.toHaveBeenCalled();
    expect(storage._store.get('gmailLastHistoryId')).toBe('100');
  });
});

// ============================================================================
// getGmailOidcEmail
// ============================================================================

describe('getGmailOidcEmail', () => {
  it('returns stored gmailPushOidcEmail', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      gmailPushOidcEmail: 'gmail-push@my-project.iam.gserviceaccount.com',
    });

    const result = await instance.getGmailOidcEmail();

    expect(result).toEqual({
      gmailPushOidcEmail: 'gmail-push@my-project.iam.gserviceaccount.com',
    });
  });

  it('returns null when no email stored', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.getGmailOidcEmail();

    expect(result).toEqual({ gmailPushOidcEmail: null });
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
  it('removes failed region entirely with 3+ distinct regions', () => {
    expect(deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'dfw')).toEqual(['yyz', 'cdg']);
  });

  it('removes middle region entirely with 3+ distinct regions', () => {
    expect(deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'yyz')).toEqual(['dfw', 'cdg']);
  });

  it('removes last region entirely with 3+ distinct regions', () => {
    expect(deprioritizeRegion(['dfw', 'yyz', 'cdg'], 'cdg')).toEqual(['dfw', 'yyz']);
  });

  it('removes all duplicates of failed region with 3+ distinct', () => {
    expect(deprioritizeRegion(['dfw', 'dfw', 'yyz', 'cdg'], 'dfw')).toEqual(['yyz', 'cdg']);
  });

  it('moves failed region to end with only 2 distinct regions', () => {
    expect(deprioritizeRegion(['dfw', 'yyz'], 'dfw')).toEqual(['yyz', 'dfw']);
  });

  it('moves failed region to end with 2 distinct including duplicates', () => {
    expect(deprioritizeRegion(['dfw', 'dfw', 'yyz'], 'dfw')).toEqual(['yyz', 'dfw']);
  });

  it('returns list unchanged when failed region is not in list', () => {
    expect(deprioritizeRegion(['dfw', 'yyz'], 'iad')).toEqual(['dfw', 'yyz']);
  });

  it('returns list unchanged when failedRegion is null', () => {
    expect(deprioritizeRegion(['dfw', 'yyz'], null)).toEqual(['dfw', 'yyz']);
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
// isMetaRegion + prepareRegions + resolveRegions
// ============================================================================

describe('isMetaRegion', () => {
  it('returns true for eu', () => {
    expect(isMetaRegion('eu')).toBe(true);
  });

  it('returns true for us', () => {
    expect(isMetaRegion('us')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMetaRegion('EU')).toBe(true);
    expect(isMetaRegion('Us')).toBe(true);
  });

  it('returns false for specific regions', () => {
    expect(isMetaRegion('dfw')).toBe(false);
    expect(isMetaRegion('iad')).toBe(false);
    expect(isMetaRegion('cdg')).toBe(false);
    expect(isMetaRegion('lhr')).toBe(false);
  });
});

describe('prepareRegions', () => {
  it('does not shuffle when all regions are meta', () => {
    const result = prepareRegions(['eu', 'us']);
    expect(result).toEqual(['eu', 'us']);
  });

  it('does not shuffle a single meta region', () => {
    expect(prepareRegions(['eu'])).toEqual(['eu']);
  });

  it('shuffles when all regions are specific', () => {
    const input = ['dfw', 'ord', 'lax', 'iad', 'cdg', 'arn'];
    const orderings = new Set<string>();
    for (let i = 0; i < 50; i++) {
      orderings.add(prepareRegions([...input]).join(','));
    }
    expect(orderings.size).toBeGreaterThan(1);
  });

  it('shuffles when mix of meta and specific regions', () => {
    const input = ['dfw', 'eu', 'ord', 'us'];
    const orderings = new Set<string>();
    for (let i = 0; i < 50; i++) {
      orderings.add(prepareRegions([...input]).join(','));
    }
    expect(orderings.size).toBeGreaterThan(1);
  });

  it('preserves all elements including duplicates', () => {
    const result = prepareRegions(['dfw', 'dfw', 'ord']);
    expect(result.sort()).toEqual(['dfw', 'dfw', 'ord'].sort());
  });

  it('does not mutate the input array', () => {
    const input = ['dfw', 'ord', 'lax'];
    const copy = [...input];
    prepareRegions(input);
    expect(input).toEqual(copy);
  });
});

describe('resolveRegions', () => {
  function createMockKV(value: string | null = null) {
    const getMock = vi.fn().mockResolvedValue(value);
    const kv = { get: getMock, put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace;
    return { kv, getMock };
  }

  it('reads from KV when value is present', async () => {
    const { kv, getMock } = createMockKV('dfw,ord,lax');
    const result = await resolveRegions(kv, 'eu,us');
    // Specific regions → shuffled, but all elements preserved
    expect(result.sort()).toEqual(['dfw', 'lax', 'ord']);
    expect(getMock).toHaveBeenCalledWith(FLY_REGIONS_KV_KEY);
  });

  it('falls back to env FLY_REGION when KV is empty', async () => {
    const { kv } = createMockKV(null);
    const result = await resolveRegions(kv, 'eu,us');
    // Meta regions → not shuffled
    expect(result).toEqual(['eu', 'us']);
  });

  it('falls back to DEFAULT_FLY_REGION when both KV and env are missing', async () => {
    const { kv } = createMockKV(null);
    const result = await resolveRegions(kv, undefined);
    // DEFAULT_FLY_REGION is 'eu,us' → meta → not shuffled
    expect(result).toEqual(['eu', 'us']);
  });

  it('applies shuffle to specific regions from KV', async () => {
    const { kv } = createMockKV('arn,cdg,iad,ams,fra,lhr');
    const orderings = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const result = await resolveRegions(kv, undefined);
      orderings.add(result.join(','));
    }
    expect(orderings.size).toBeGreaterThan(1);
  });

  it('does not shuffle meta regions from KV', async () => {
    const { kv } = createMockKV('us,eu');
    const result = await resolveRegions(kv, undefined);
    expect(result).toEqual(['us', 'eu']);
  });

  it('preserves duplicates for shuffle biasing', async () => {
    const { kv } = createMockKV('dfw,dfw,ord');
    const result = await resolveRegions(kv, undefined);
    expect(result.sort()).toEqual(['dfw', 'dfw', 'ord']);
  });

  it('falls back to env when KV read throws', async () => {
    const getMock = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    const kv = { get: getMock, put: vi.fn(), delete: vi.fn() } as unknown as KVNamespace;
    const result = await resolveRegions(kv, 'eu,us');
    expect(result).toEqual(['eu', 'us']);
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
  // Reset listMachines to return [] so metadata recovery is a no-op in these tests.
  beforeEach(() => {
    (flyClient.listMachines as Mock).mockResolvedValue([]);
  });

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

  it('performs region check even when machine already exists', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped' });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockResolvedValue({ id: 'machine-1' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    // Return matching region so no drift is detected
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });

    await instance.start('user-1');

    // getVolume is now called for region validation even when flyMachineId is set,
    // to catch drift between the cached flyRegion and the actual volume region.
    expect(flyClient.getVolume).toHaveBeenCalledWith(expect.anything(), 'vol-1');
    // Region was not changed since volume matches stored flyRegion
    expect(storage._store.get('flyRegion')).toBe('iad');
  });
});

// ============================================================================
// 412 insufficient resources recovery
// ============================================================================

describe('start: 412 insufficient resources recovery', () => {
  // Reset listMachines to return [] so metadata recovery is a no-op in these tests.
  beforeEach(() => {
    (flyClient.listMachines as Mock).mockResolvedValue([]);
  });

  it('fresh provision (never started): deletes volume and creates fresh with deprioritized regions', async () => {
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
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
        compute: expect.objectContaining({ cpus: 1, memory_mb: 3072 }) as unknown,
      })
    );
    // Regions are passed in configured order, and deprioritize is a no-op here
    // because 'iad' is not in FLY_REGION='eu,us'.
    expect(regions412Call[2] as string[]).toEqual(['eu', 'us']);
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

    const recoveryEvents = analyticsEventsByName(env, 'instance.start_capacity_recovery');
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0].blobs).toEqual(
      expect.arrayContaining(['instance.start_capacity_recovery', 'user-1', 'do'])
    );
    expect(recoveryEvents[0].blobs).toContain('fly_412_insufficient_resources');
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
        compute: expect.objectContaining({ cpus: 1, memory_mb: 3072 }) as unknown,
      })
    );
    const forkCreateVolumeCall = (flyClient.createVolumeWithFallback as Mock).mock
      .calls[0][1] as Record<string, unknown>;
    expect(forkCreateVolumeCall.size_gb).toBeUndefined();
    // Regions are passed in configured order.
    expect(regionsForkCall[2] as string[]).toEqual(['eu', 'us']);
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
        compute: expect.objectContaining({ cpus: 1, memory_mb: 3072 }) as unknown,
      })
    );
    const updateForkCreateVolumeCall = (flyClient.createVolumeWithFallback as Mock).mock
      .calls[0][1] as Record<string, unknown>;
    expect(updateForkCreateVolumeCall.size_gb).toBeUndefined();
    // Regions are passed in configured order then deprioritized.
    expect(regionsUpdateCall[2] as string[]).toEqual(['eu', 'us']);
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

  it('preserves the old machine id if retry creation fails after a transient destroy failure', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped', lastStartedAt: Date.now() - 60_000 });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.destroyMachine as Mock).mockRejectedValue(
      new FlyApiError('server error', 500, 'internal')
    );
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });
    (flyClient.createMachine as Mock).mockRejectedValueOnce(
      new FlyApiError('still no resources', 500, '{"error":"no capacity"}')
    );

    await expect(instance.start('user-1')).rejects.toThrow('still no resources');

    expect(storage._store.get('flyMachineId')).toBe('machine-1');
    expect(storage._store.get('flyVolumeId')).toBe('vol-new');
    expect(storage._store.get('providerState')).toEqual({
      provider: 'fly',
      appName: null,
      machineId: 'machine-1',
      volumeId: 'vol-new',
      region: 'cdg',
    });
  });

  it('persists replacement volume state before deleting the old volume during capacity recovery', async () => {
    const storage = createFakeStorage();
    const originalPut = storage.put.bind(storage);
    storage.put = (entries: Record<string, unknown>) => {
      if (
        entries.providerState &&
        typeof entries.providerState === 'object' &&
        entries.providerState !== null &&
        'volumeId' in entries.providerState &&
        entries.providerState.volumeId === 'vol-new'
      ) {
        throw new Error('persist replacement volume failed');
      }
      originalPut(entries);
    };

    const { instance } = createInstance(storage);
    await seedRunning(storage, { status: 'stopped', lastStartedAt: Date.now() - 60_000 });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });

    await expect(instance.start('user-1')).rejects.toThrow('persist replacement volume failed');

    expect(flyClient.deleteVolume).not.toHaveBeenCalled();
  });

  it('clears the abandoned volume before creating a fresh no-user-data replacement', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      status: 'stopped',
      flyMachineId: 'machine-1',
      flyVolumeId: 'vol-1',
      flyRegion: 'iad',
      lastStartedAt: null,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError('insufficient resources', 412, '{"error":"insufficient resources"}')
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockRejectedValue(new Error('create failed'));

    await expect(instance.start('user-1')).rejects.toThrow('create failed');

    expect(storage._store.get('flyMachineId')).toBeNull();
    expect(storage._store.get('flyVolumeId')).toBeNull();
    expect(storage._store.get('providerState')).toEqual({
      provider: 'fly',
      appName: null,
      machineId: null,
      volumeId: null,
      region: null,
    });
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
// start: region eviction on machine-creation capacity errors
// ============================================================================

describe('start: evicts region from KV on machine-creation capacity error', () => {
  beforeEach(() => {
    (flyClient.listMachines as Mock).mockResolvedValue([]);
  });

  it('evicts flyRegion from KV when createMachine returns 403 quota exceeded', async () => {
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedProvisioned(storage, { flyMachineId: null, lastStartedAt: null, flyRegion: 'lhr' });
    const evictSpy = vi.spyOn(regions, 'evictCapacityRegionFromKV').mockResolvedValue(undefined);

    (flyClient.createMachine as Mock)
      .mockRejectedValueOnce(
        new FlyApiError(
          'Fly API createMachine failed (403)',
          403,
          '{"error":"organization \\"Kilo\\" is using 3194880 MB of memory in lhr which is over the allowed quota. please consider other regions"}'
        )
      )
      .mockResolvedValueOnce({ id: 'machine-retry', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'lhr' });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });

    await instance.start('user-1');

    expect(evictSpy).toHaveBeenCalledWith(env.KV_CLAW_CACHE, env, 'lhr');
    expect(storage._store.get('flyRegion')).toBe('cdg');
    expect(storage._store.get('status')).toBe('running');
    evictSpy.mockRestore();
  });

  it('does NOT evict flyRegion from KV on 409 insufficient memory (transient)', async () => {
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedProvisioned(storage, { flyMachineId: null, lastStartedAt: null, flyRegion: 'dfw' });
    const evictSpy = vi.spyOn(regions, 'evictCapacityRegionFromKV').mockResolvedValue(undefined);

    (flyClient.createMachine as Mock)
      .mockRejectedValueOnce(
        new FlyApiError(
          'insufficient memory',
          409,
          '{"error":"aborted: insufficient resources available to fulfill request: could not reserve resource for machine: insufficient memory available to fulfill request"}'
        )
      )
      .mockResolvedValueOnce({ id: 'machine-retry', region: 'sjc' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'dfw' });
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'sjc',
    });

    await instance.start('user-1');

    expect(evictSpy).not.toHaveBeenCalled();
    evictSpy.mockRestore();
  });

  it('evicts flyRegion from KV when updateMachine returns 403 during startExistingMachine', async () => {
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedRunning(storage, {
      status: 'stopped',
      lastStartedAt: Date.now() - 60_000,
      flyRegion: 'lhr',
    });
    const evictSpy = vi.spyOn(regions, 'evictCapacityRegionFromKV').mockResolvedValue(undefined);

    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'stopped' });
    (flyClient.updateMachine as Mock).mockRejectedValue(
      new FlyApiError(
        'Fly API updateMachine failed (403)',
        403,
        '{"error":"organization \\"Kilo\\" is using 3194880 MB of memory in lhr which is over the allowed quota. please consider other regions"}'
      )
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'lhr' });
    (flyClient.destroyMachine as Mock).mockResolvedValue(undefined);
    (flyClient.deleteVolume as Mock).mockResolvedValue(undefined);
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-new',
      region: 'cdg',
    });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-new', region: 'cdg' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.start('user-1');

    expect(evictSpy).toHaveBeenCalledWith(env.KV_CLAW_CACHE, env, 'lhr');
    expect(storage._store.get('flyRegion')).toBe('cdg');
    evictSpy.mockRestore();
  });

  it('does not evict when flyRegion is null', async () => {
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedProvisioned(storage, { flyMachineId: null, lastStartedAt: null, flyRegion: null });
    const evictSpy = vi.spyOn(regions, 'evictCapacityRegionFromKV').mockResolvedValue(undefined);

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

    expect(evictSpy).not.toHaveBeenCalled();
    evictSpy.mockRestore();
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

  it('throws with status 404 when instance was never provisioned', async () => {
    const { instance } = createInstance();

    const err: Error & { status?: number } = await instance.stop().then(
      () => {
        throw new Error('expected rejection');
      },
      (e: Error & { status?: number }) => e
    );

    expect(err.message).toBe('Instance not provisioned');
    expect(err.status).toBe(404);
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

    expect(result).toEqual({ success: false, message: 'Approval failed: request not found' });
  });
});

// ============================================================================
// Controller-first pairing (try controller, fall back to fly exec)
// ============================================================================

import { GatewayControllerError } from './gateway-controller-types';

describe('controller-first pairing', () => {
  it('channel list via controller — returns only requests, strips lastUpdated', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requests: [{ code: 'ABC', id: 'r1', channel: 'telegram' }],
          lastUpdated: '2026-03-12T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await instance.listPairingRequests();

    expect(result).toEqual({ requests: [{ code: 'ABC', id: 'r1', channel: 'telegram' }] });
    expect(result).not.toHaveProperty('lastUpdated');
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel list via controller works for docker-local without flyMachineId', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requests: [{ code: 'DOCKER1', id: 'r-docker', channel: 'telegram' }],
          lastUpdated: '2026-04-13T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await instance.listPairingRequests(true);

    expect(result).toEqual({
      requests: [{ code: 'DOCKER1', id: 'r-docker', channel: 'telegram' }],
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:45001/_kilo/pairing/channels?refresh=true'
    );
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel list fallback on 404 — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: JSON.stringify({ requests: [{ code: 'XYZ', id: 'r2', channel: 'discord' }] }),
      stderr: '',
    });

    const result = await instance.listPairingRequests();

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].code).toBe('XYZ');
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel list fallback on 401 with controller_route_unavailable — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ code: 'controller_route_unavailable', error: 'Unauthorized' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: JSON.stringify({ requests: [{ code: 'QRS', id: 'r3', channel: 'slack' }] }),
      stderr: '',
    });

    const result = await instance.listPairingRequests();

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].code).toBe('QRS');
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel list throws on bare 401 — no fallback (genuine auth failure)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.listPairingRequests()).rejects.toThrow('Unauthorized');
    fetchSpy.mockRestore();
  });

  it('channel list throws on 500 — no fallback', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.listPairingRequests()).rejects.toSatisfy((err: unknown) => {
      return err instanceof GatewayControllerError && err.status === 500;
    });

    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel list logs console.warn before re-throwing non-route error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const warnSpy = vi.spyOn(console, 'warn');

    await expect(instance.listPairingRequests()).rejects.toThrow();

    expectStructuredWarn(warnSpy, 'listPairingRequests controller call failed');
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('channel list throws on 502 — no fallback', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Bad gateway' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.listPairingRequests()).rejects.toSatisfy((err: unknown) => {
      return err instanceof GatewayControllerError && err.status === 502;
    });

    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device list via controller — returns only requests', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requests: [{ requestId: 'abc-123', deviceId: 'dev-1', role: 'operator' }],
          lastUpdated: '2026-03-12T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await instance.listDevicePairingRequests();

    expect(result).toEqual({
      requests: [{ requestId: 'abc-123', deviceId: 'dev-1', role: 'operator' }],
    });
    expect(result).not.toHaveProperty('lastUpdated');
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve via controller — returns success', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, message: 'Pairing approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: true, message: 'Pairing approved' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve via controller works for docker-local without flyMachineId', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, message: 'Pairing approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: true, message: 'Pairing approved' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:45001/_kilo/pairing/channels/approve'
    );
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve returns redeploy-required when non-Fly controller route is unavailable', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({
      success: false,
      message: 'Controller pairing route unavailable; redeploy required',
    });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve 400 with { error } body — returns failure without throwing', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid channel name' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: false, message: 'Invalid channel name' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve 400 with { success, message } body — surfaces real error text', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    // Controller approve routes return { success: false, message } on validation failures
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, message: 'Invalid pairing code' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: false, message: 'Invalid pairing code' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve fallback on 404 — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: 'approved',
      stderr: '',
    });

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: true, message: 'Pairing approved' });
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device approve via controller — returns success', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, message: 'Device pairing approved' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: true, message: 'Device pairing approved' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device list via controller works for docker-local without flyMachineId', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requests: [{ requestId: 'req-docker', deviceId: 'dev-docker', role: 'operator' }],
          lastUpdated: '2026-04-13T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await instance.listDevicePairingRequests(true);

    expect(result).toEqual({
      requests: [{ requestId: 'req-docker', deviceId: 'dev-docker', role: 'operator' }],
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:45001/_kilo/pairing/devices?refresh=true'
    );
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device approve fallback on 404 — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: 'approved',
      stderr: '',
    });

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: true, message: 'Device pairing approved' });
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device approve 400 with { error } body — returns failure without throwing', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid request ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: false, message: 'Invalid request ID' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device approve 400 with { success, message } body — surfaces real error text', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    // Controller approve routes return { success: false, message } on validation failures
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, message: 'Invalid request ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: false, message: 'Invalid request ID' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device list fallback on 404 — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: JSON.stringify({ requests: [{ requestId: 'r1', deviceId: 'd1' }] }),
      stderr: '',
    });

    const result = await instance.listDevicePairingRequests();

    expect(result.requests).toHaveLength(1);
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device list throws on 500 — no fallback', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.listDevicePairingRequests()).rejects.toSatisfy((err: unknown) => {
      return err instanceof GatewayControllerError && err.status === 500;
    });

    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device list logs console.warn before re-throwing non-route error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const warnSpy = vi.spyOn(console, 'warn');

    await expect(instance.listDevicePairingRequests()).rejects.toThrow();

    expectStructuredWarn(warnSpy, 'listDevicePairingRequests controller call failed');
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('channel approve throws on 500 — no fallback', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.approvePairingRequest('telegram', 'ABC123')).rejects.toSatisfy(
      (err: unknown) => err instanceof GatewayControllerError && err.status === 500
    );

    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel approve logs console.warn before re-throwing non-route error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const warnSpy = vi.spyOn(console, 'warn');

    await expect(instance.approvePairingRequest('telegram', 'ABC123')).rejects.toThrow();

    expectStructuredWarn(warnSpy, 'approvePairingRequest controller call failed');
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('device approve throws on 500 — no fallback', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      instance.approveDevicePairingRequest('58f4ac67-12b4-4f6e-adee-ff3463a7c30c')
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof GatewayControllerError && err.status === 500
    );

    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device approve logs console.warn before re-throwing non-route error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const warnSpy = vi.spyOn(console, 'warn');

    await expect(
      instance.approveDevicePairingRequest('58f4ac67-12b4-4f6e-adee-ff3463a7c30c')
    ).rejects.toThrow();

    expectStructuredWarn(warnSpy, 'approveDevicePairingRequest controller call failed');
    warnSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('device list fallback on 401 with controller_route_unavailable — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'Unauthorized', code: 'controller_route_unavailable' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: JSON.stringify({ requests: [{ requestId: 'r1', deviceId: 'd1' }] }),
      stderr: '',
    });

    const result = await instance.listDevicePairingRequests();

    expect(result.requests).toHaveLength(1);
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device list throws on bare 401 — no fallback (genuine auth failure)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(instance.listDevicePairingRequests()).rejects.toThrow('Unauthorized');
    fetchSpy.mockRestore();
  });

  it('channel list with forceRefresh — appends ?refresh=true to controller URL', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requests: [],
          lastUpdated: '2026-03-12T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await instance.listPairingRequests(true);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://acct-test.fly.dev/_kilo/pairing/channels?refresh=true'
    );
    fetchSpy.mockRestore();
  });

  it('channel approve fallback on 401 with controller_route_unavailable — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'Unauthorized', code: 'controller_route_unavailable' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: 'approved',
      stderr: '',
    });

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: true, message: 'Pairing approved' });
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('device approve fallback on 401 with controller_route_unavailable — runs fly exec', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'Unauthorized', code: 'controller_route_unavailable' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        )
      );

    (flyClient.execCommand as Mock).mockResolvedValue({
      exit_code: 0,
      stdout: 'approved',
      stderr: '',
    });

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: true, message: 'Device pairing approved' });
    expect(flyClient.execCommand).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('channel list returns empty when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.listPairingRequests();

    expect(result).toEqual({ requests: [] });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('channel approve returns failure when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.approvePairingRequest('telegram', 'ABC123');

    expect(result).toEqual({ success: false, message: 'Instance is not running' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('device list returns empty when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.listDevicePairingRequests();

    expect(result).toEqual({ requests: [] });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('device approve returns failure when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.approveDevicePairingRequest(
      '58f4ac67-12b4-4f6e-adee-ff3463a7c30c'
    );

    expect(result).toEqual({ success: false, message: 'Instance is not running' });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('channel list served from KV cache when controller returns 404 — skips fly exec', async () => {
    const env = createFakeEnv();
    const cachedData = { requests: [{ code: 'KV1', id: 'kv-r1', channel: 'slack' }] };
    const kv = env.KV_CLAW_CACHE as { get: Mock };
    kv.get.mockResolvedValueOnce(cachedData);

    const { instance, storage } = createInstance(createFakeStorage(), env);
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const result = await instance.listPairingRequests();

    expect(result).toEqual({ requests: [{ code: 'KV1', id: 'kv-r1', channel: 'slack' }] });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('device list served from KV cache when controller returns 404 — skips fly exec', async () => {
    const env = createFakeEnv();
    const cachedData = {
      requests: [{ requestId: 'kv-dev-1', deviceId: 'dev-1', role: 'operator' }],
    };
    const kv = env.KV_CLAW_CACHE as { get: Mock };
    kv.get.mockResolvedValueOnce(cachedData);

    const { instance, storage } = createInstance(createFakeStorage(), env);
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const result = await instance.listDevicePairingRequests();

    expect(result).toEqual({
      requests: [{ requestId: 'kv-dev-1', deviceId: 'dev-1', role: 'operator' }],
    });
    expect(flyClient.execCommand).not.toHaveBeenCalled();
  });

  it('device list with forceRefresh — appends ?refresh=true to controller URL', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyAppName: 'acct-test' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requests: [],
          lastUpdated: '2026-03-12T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await instance.listDevicePairingRequests(true);

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://acct-test.fly.dev/_kilo/pairing/devices?refresh=true'
    );
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// Kilo CLI run controller routing
// ============================================================================

describe('kilo CLI run routing', () => {
  it('starts a Kilo CLI run for docker-local via controller without flyMachineId', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, startedAt: '2026-04-13T18:45:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.startKiloCliRun('fix the thing');

    expect(result).toEqual({ ok: true, startedAt: '2026-04-13T18:45:00.000Z' });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:45001/_kilo/cli-run/start');
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('gets Kilo CLI run status for docker-local via controller without flyMachineId', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const controllerStatus = {
      hasRun: true,
      status: 'running',
      output: 'working',
      exitCode: null,
      startedAt: '2026-04-13T18:45:00.000Z',
      completedAt: null,
      prompt: 'fix the thing',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(controllerStatus), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.getKiloCliRunStatus();

    expect(result).toEqual(controllerStatus);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:45001/_kilo/cli-run/status');
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns { conflict } from startKiloCliRun when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage); // status: 'provisioned', not 'running'

    const result = await instance.startKiloCliRun('fix something');

    expect(result).toEqual({
      conflict: {
        code: 'kilo_cli_run_instance_not_running',
        error: 'Instance is not running',
      },
    });
  });

  it('returns { conflict } from startKiloCliRun when controller returns 409', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'kilo_cli_run_already_active',
          error: 'A Kilo CLI run is already in progress',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const result = await instance.startKiloCliRun('fix something');

    expect(result).toEqual({
      conflict: {
        code: 'kilo_cli_run_already_active',
        error: 'A Kilo CLI run is already in progress',
      },
    });
    fetchSpy.mockRestore();
  });

  it('uses the start-specific code when controller start returns an unstructured 409', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'A Kilo CLI run is already in progress' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.startKiloCliRun('fix something');

    expect(result).toEqual({
      conflict: {
        code: 'kilo_cli_run_already_active',
        error: 'A Kilo CLI run is already in progress',
      },
    });
    fetchSpy.mockRestore();
  });

  it('returns { conflict } from cancelKiloCliRun when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage); // status: 'provisioned', not 'running'

    const result = await instance.cancelKiloCliRun();

    expect(result).toEqual({
      conflict: {
        code: 'kilo_cli_run_instance_not_running',
        error: 'Instance is not running',
      },
    });
  });

  it('returns { conflict } from cancelKiloCliRun when controller returns 409', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'kilo_cli_run_no_active_run',
          error: 'No active run to cancel',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const result = await instance.cancelKiloCliRun();

    expect(result).toEqual({
      conflict: {
        code: 'kilo_cli_run_no_active_run',
        error: 'No active run to cancel',
      },
    });
    fetchSpy.mockRestore();
  });

  it('uses the cancel-specific code when controller cancel returns an unrecognized 409', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'No active run to cancel' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.cancelKiloCliRun();

    expect(result).toEqual({
      conflict: {
        code: 'kilo_cli_run_no_active_run',
        error: 'No active run to cancel',
      },
    });
    fetchSpy.mockRestore();
  });

  it('cancels a Kilo CLI run for docker-local via controller without flyMachineId', async () => {
    const { instance, storage } = createInstance();
    await seedDockerInstance(storage, { status: 'running' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const result = await instance.cancelKiloCliRun();

    expect(result).toEqual({ ok: true });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:45001/_kilo/cli-run/cancel');
    expect(flyClient.execCommand).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// provision: auto-start
// ============================================================================

describe('provision: auto-start after fresh provision', () => {
  // Reset listMachines to return [] so metadata recovery is a no-op in these tests.
  beforeEach(() => {
    (flyClient.listMachines as Mock).mockResolvedValue([]);
  });

  it('persists fly provider metadata alongside legacy fields', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('provider')).toBe('fly');
    expect(storage._store.get('providerState')).toEqual({
      provider: 'fly',
      appName: 'claw-user-1',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'iad',
    });
  });

  it('persists user timezone from provision config', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', { userTimezone: 'Europe/Amsterdam' });
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('userTimezone')).toBe('Europe/Amsterdam');

    await instance.provision('user-1', { userTimezone: null });

    expect(storage._store.get('userTimezone')).toBeNull();
  });

  it('creates the initial volume in the freshly ensured Fly app', async () => {
    const env = createFakeEnv();
    const { instance, waitUntilPromises } = createInstance(undefined, env);

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect((flyClient.createVolumeWithFallback as Mock).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        appName: 'claw-user-1',
      })
    );
  });

  it('calls start() on fresh provision and ends in running state', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    const result = await instance.provision('user-1', {});

    expect(result.sandboxId).toBeDefined();
    // provision() returns before start() runs: waitUntil defers the promise,
    // so status must be 'starting' here — not 'running'.
    expect(storage._store.get('status')).toBe('starting');

    // Await background tasks to let start() complete
    await Promise.all(waitUntilPromises);

    expect(flyClient.createMachine).toHaveBeenCalled();
    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('flyMachineId')).toBe('machine-1');
  });

  it('wires capacity eviction callback during initial volume provisioning', async () => {
    const env = createFakeEnv();
    const { instance, waitUntilPromises } = createInstance(undefined, env);
    const evictSpy = vi.spyOn(regions, 'evictCapacityRegionFromKV').mockResolvedValue(undefined);

    (flyClient.createVolumeWithFallback as Mock).mockImplementation(
      async (
        _config: unknown,
        _request: unknown,
        _regions: string[],
        options?: { onCapacityError?: (failedRegion: string) => void | Promise<void> }
      ) => {
        await options?.onCapacityError?.('arn');
        return { id: 'vol-1', region: 'yyz' };
      }
    );
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'yyz' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'yyz' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect(evictSpy).toHaveBeenCalledWith(env.KV_CLAW_CACHE, env, 'arn');
    evictSpy.mockRestore();
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

  it('hydrates legacy fly fields from providerState on reload', async () => {
    const storage = createFakeStorage();
    await seedRunning(storage, {
      provider: 'fly',
      providerState: {
        provider: 'fly',
        appName: 'acct-provider-only',
        machineId: 'machine-from-provider',
        volumeId: 'vol-from-provider',
        region: 'ord',
      },
      flyAppName: null,
      flyMachineId: null,
      flyVolumeId: null,
      flyRegion: null,
    });
    const { instance } = createInstance(storage);

    await instance.stop();

    expect(flyClient.stopMachineAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ appName: 'acct-provider-only' }),
      'machine-from-provider'
    );
    expect(storage._store.get('status')).toBe('stopped');
  });

  it('routes legacy fly-only persisted state without provider fields', async () => {
    const storage = createFakeStorage();
    await seedRunning(storage, {
      flyAppName: 'acct-legacy-only',
      flyMachineId: 'machine-legacy',
      flyVolumeId: 'vol-legacy',
      flyRegion: 'ord',
    });
    const { instance } = createInstance(storage);

    const routingTarget = await instance.getRoutingTarget();

    expect(routingTarget).toEqual({
      origin: 'https://acct-legacy-only.fly.dev',
      headers: {
        'fly-force-instance-id': 'machine-legacy',
      },
    });
  });

  it('reports provider in debug state for legacy fly-only persisted state', async () => {
    const storage = createFakeStorage();
    Object.assign(storage, { getAlarm: vi.fn().mockResolvedValue(null) });
    await seedRunning(storage, {
      flyAppName: 'acct-legacy-only',
      flyMachineId: 'machine-legacy',
      flyVolumeId: 'vol-legacy',
      flyRegion: 'ord',
    });
    const { instance } = createInstance(storage);

    const debugState = await instance.getDebugState();

    expect(debugState.provider).toBe('fly');
    expect(debugState.flyAppName).toBe('acct-legacy-only');
    expect(debugState.flyMachineId).toBe('machine-legacy');
  });

  it('backfills provider state when a legacy fly-only DO is next persisted', async () => {
    const storage = createFakeStorage();
    await seedRunning(storage, {
      flyAppName: 'acct-legacy-only',
      flyMachineId: 'machine-legacy',
      flyVolumeId: 'vol-legacy',
      flyRegion: 'ord',
    });
    const { instance } = createInstance(storage);

    (flyClient.stopMachineAndWait as Mock).mockResolvedValue(undefined);

    await instance.stop();

    expect(flyClient.stopMachineAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ appName: 'acct-legacy-only' }),
      'machine-legacy'
    );
    expect(storage._store.get('provider')).toBe('fly');
    expect(storage._store.get('providerState')).toEqual({
      provider: 'fly',
      appName: 'acct-legacy-only',
      machineId: 'machine-legacy',
      volumeId: 'vol-legacy',
      region: 'ord',
    });
  });

  it('does not leave the hot DO on an unsupported provider after failed provision', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    await expect(instance.provision('user-1', {}, { provider: 'northflank' })).rejects.toThrow(
      'Provider northflank is not implemented yet'
    );

    expect(storage._store.get('userId')).toBeUndefined();
    expect(storage._store.get('provider')).toBeUndefined();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('provider')).toBe('fly');
    expect(storage._store.get('status')).toBe('running');
  });
});

describe('startAsync: catch handler writes stopped state on pre-machine failure', () => {
  it('transitions to stopped immediately when start() throws before machine creation', async () => {
    const env = createFakeEnv();
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    // createMachine throws — no machine ID is ever persisted
    (flyClient.createMachine as Mock).mockRejectedValue(new Error('Fly API unavailable'));

    await instance.provision('user-1', {});
    // Status is 'starting' immediately after provision() returns
    expect(storage._store.get('status')).toBe('starting');

    // Drain waitUntil promises — catch handler should fire and write stopped
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('startingAt')).toBeNull();
    expect(storage._store.get('flyMachineId')).toBeFalsy();
    expect(storage._store.get('lastStartErrorMessage')).toBe('Fly API unavailable');
    expect(storage._store.get('lastStartErrorAt')).toBeGreaterThan(0);

    const failedEvents = analyticsEventsByName(env, 'instance.provisioning_failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].blobs).toContain('no_machine_created');
    expect(failedEvents[0].blobs).toContain('Fly API unavailable');
  });

  it('does NOT overwrite state when start() fails after machine ID is persisted', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    // Machine is created (ID will be persisted) but waitForState throws
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'created' });
    (flyClient.waitForState as Mock).mockRejectedValue(new Error('timeout waiting for started'));

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    // Machine ID was persisted — catch handler must not overwrite to stopped.
    // reconcileStarting handles the transition by checking Fly state.
    expect(storage._store.get('flyMachineId')).toBe('machine-1');
    expect(storage._store.get('status')).toBe('starting');
    // Error fields should NOT be populated for post-machine failures
    expect(storage._store.get('lastStartErrorMessage')).toBeFalsy();
    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });

  it('does NOT overwrite Fly state when start() fails after machine ID is persisted and inspect would fail', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.getMachine as Mock).mockRejectedValue(new Error('transient Fly API failure'));
    (flyClient.waitForState as Mock).mockRejectedValue(new Error('timeout waiting for started'));

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('flyMachineId')).toBe('machine-1');
    expect(storage._store.get('status')).toBe('starting');
    expect(storage._store.get('lastStartErrorMessage')).toBeFalsy();
    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });

  it('transitions docker-local to stopped when start fails after deterministic names are seeded', async () => {
    const env = {
      ...createFakeEnv(),
      DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750',
      DOCKER_LOCAL_PORT_RANGE: '45000-45010',
    };
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);
    await seedDockerInstance(storage, {
      status: 'provisioned',
      providerState: dockerProviderState({ hostPort: null }),
    });

    vi.mocked(fetch).mockImplementation(async input => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response(JSON.stringify({ Name: 'kiloclaw-root-sandbox-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/containers/json?all=1')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/json')) {
        return new Response('', { status: 404 });
      }
      if (url.includes('/containers/create?name=kiloclaw-sandbox-1')) {
        return new Response('create failed', { status: 500 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    await instance.startAsync();
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('startingAt')).toBeNull();
    expect(storage._store.get('lastStartErrorMessage')).toContain('create failed');
    expect(storage._store.get('providerState')).toEqual(dockerProviderState({ hostPort: 45000 }));
  });
});

describe('non-Fly runtime reconciliation via alarm', () => {
  it("transitions a docker-local starting runtime to 'running' when inspect reports running", async () => {
    const env = { ...createFakeEnv(), DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750' };
    const { instance, storage } = createInstance(undefined, env);
    await seedDockerInstance(storage, {
      status: 'starting',
      startingAt: Date.now(),
      lastStartedAt: null,
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          Id: 'container-1',
          Name: '/kiloclaw-sandbox-1',
          State: { Running: true, Status: 'running' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('startingAt')).toBeNull();
    expect(storage._store.get('lastStartedAt')).toBeGreaterThan(0);
  });

  it("transitions a docker-local restarting runtime to 'running' when inspect reports running", async () => {
    const env = { ...createFakeEnv(), DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750' };
    const { instance, storage } = createInstance(undefined, env);
    await seedDockerInstance(storage, {
      status: 'restarting',
      restartingAt: Date.now(),
      lastRestartErrorMessage: 'previous failure',
      lastRestartErrorAt: Date.now() - 1_000,
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          Id: 'container-1',
          Name: '/kiloclaw-sandbox-1',
          State: { Running: true, Status: 'running' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('restartingAt')).toBeNull();
    expect(storage._store.get('lastRestartErrorMessage')).toBeNull();
    expect(storage._store.get('lastRestartErrorAt')).toBeNull();
  });

  it("transitions a docker-local running runtime to 'stopped' when inspect reports missing", async () => {
    const env = { ...createFakeEnv(), DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750' };
    const { instance, storage } = createInstance(undefined, env);
    await seedDockerInstance(storage, {
      status: 'running',
      lastStoppedAt: null,
    });
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('lastStoppedAt')).toBeGreaterThan(0);
    expect(storage._getAlarm()).not.toBeNull();
  });

  it('keeps the alarm chain alive for idle docker-local statuses', async () => {
    const env = { ...createFakeEnv(), DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750' };
    const { instance, storage } = createInstance(undefined, env);
    await seedDockerInstance(storage, {
      status: 'stopped',
      lastStoppedAt: Date.now(),
    });

    await instance.alarm();

    expect(fetch).not.toHaveBeenCalled();
    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._getAlarm()).not.toBeNull();
  });
});

describe('start failure analytics events', () => {
  it('emits instance.provisioning_failed when reconcile times out with no machine', async () => {
    vi.useFakeTimers();
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedStarting(storage, {
      flyMachineId: null,
      startingAt: Date.now() - STARTING_TIMEOUT_MS - 1,
      lastStartErrorMessage: 'timed out bootstrapping',
    });

    await instance.alarm();

    const failedEvents = analyticsEventsByName(env, 'instance.provisioning_failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].blobs).toContain('starting_timeout');
    expect(failedEvents[0].blobs).toContain('timed out bootstrapping');
  });

  it('emits instance.provisioning_failed when Fly reports failed state during reconcile', async () => {
    vi.useFakeTimers();
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedStarting(storage, {
      flyMachineId: 'machine-1',
      startingAt: Date.now() - 1_000,
    });
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'failed' });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });

    await instance.alarm();

    const failedEvents = analyticsEventsByName(env, 'instance.provisioning_failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].blobs).toContain('fly_failed_state');
    expect(failedEvents[0].blobs).toContain('fly machine entered failed state');
  });

  it('does not emit instance.provisioning_failed for a running machine that later fails', async () => {
    vi.useFakeTimers();
    const env = createFakeEnv();
    const { instance, storage } = createInstance(undefined, env);
    await seedRunning(storage, {
      flyMachineId: 'machine-1',
    });
    (flyClient.getMachine as Mock).mockResolvedValue({ state: 'failed' });

    await instance.alarm();

    const failedEvents = analyticsEventsByName(env, 'instance.provisioning_failed');
    expect(failedEvents).toHaveLength(0);
  });
});

describe('manual and crash recovery analytics events', () => {
  it('can record manual start success events through Analytics Engine payloads', () => {
    const env = createFakeEnv();
    const dataset = env.KILOCLAW_AE as { writeDataPoint: Mock };

    dataset.writeDataPoint({
      blobs: [
        'instance.manual_start_succeeded',
        'user-1',
        'http',
        '/api/platform/start',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
      doubles: [12, 0],
      indexes: ['instance.manual_start_succeeded'],
    });

    const successEvents = analyticsEventsByName(env, 'instance.manual_start_succeeded');
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0].blobs).toEqual(
      expect.arrayContaining(['instance.manual_start_succeeded', 'user-1', 'http'])
    );
  });

  it('can record crash recovery failure events through Analytics Engine payloads', () => {
    const env = createFakeEnv();
    const dataset = env.KILOCLAW_AE as { writeDataPoint: Mock };

    dataset.writeDataPoint({
      blobs: [
        'instance.crash_recovery_failed',
        'user-1',
        'http',
        '',
        'restart failed',
        'acct-test',
        'machine-1',
        'sandbox-1',
        'running',
        '',
        '',
        '',
        '',
      ],
      doubles: [34, 0],
      indexes: ['instance.crash_recovery_failed'],
    });

    const failureEvents = analyticsEventsByName(env, 'instance.crash_recovery_failed');
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0].blobs).toEqual(
      expect.arrayContaining(['instance.crash_recovery_failed', 'user-1', 'http', 'restart failed'])
    );
  });
});

describe('provision: instance feature flags', () => {
  // Reset listMachines to return [] so metadata recovery is a no-op in these tests.
  beforeEach(() => {
    (flyClient.listMachines as Mock).mockResolvedValue([]);
  });

  it('sets DEFAULT_INSTANCE_FEATURES on first provision', async () => {
    const { instance, storage } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});

    const features = storage._store.get('instanceFeatures') as string[];
    expect(features).toEqual([
      'npm-global-prefix',
      'pip-global-prefix',
      'uv-global-prefix',
      'kilo-cli',
    ]);
  });

  it('preserves existing features on re-provision (does not reset to defaults)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, {
      instanceFeatures: ['some-old-feature'],
    });

    await instance.provision('user-1', { kilocodeApiKey: 'new-key' });

    const features = storage._store.get('instanceFeatures') as string[];
    expect(features).toEqual(['some-old-feature']);
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
    (db.getActivePersonalInstance as Mock).mockResolvedValue(null);
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
// restartMachine image tag override
// ============================================================================

describe('restartMachine image tag override', () => {
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

    const result = await instance.restartMachine();

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

    const result = await instance.restartMachine({ imageTag: 'latest' });

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

    const result = await instance.restartMachine({ imageTag: 'latest' });

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

    const result = await instance.restartMachine({ imageTag: '2026.2.25-abc123' });

    expect(result.success).toBe(true);
    expect(resolveLatestVersion).not.toHaveBeenCalled();
    expect(storage._store.get('trackedImageTag')).toBe('2026.2.25-abc123');
    expect(storage._store.get('openclawVersion')).toBeNull();
    expect(storage._store.get('imageVariant')).toBeNull();
  });
});

// ============================================================================
// Proactive API key refresh via reconciliation
// ============================================================================

describe('reconcileApiKeyExpiry', () => {
  /** Set up fetch mock to handle env patch RPCs alongside default health-probe responses. */
  function mockControllerFetch(opts: {
    envPatchResponse?: { ok: boolean; signaled: boolean };
    envPatchStatus?: number;
    envPatchError?: boolean;
  }) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/_kilo/env/patch')) {
          if (opts.envPatchError) {
            return Promise.reject(new Error('push failed'));
          }
          return Promise.resolve({
            ok: (opts.envPatchStatus ?? 200) >= 200 && (opts.envPatchStatus ?? 200) < 300,
            status: opts.envPatchStatus ?? 200,
            text: () =>
              Promise.resolve(
                JSON.stringify(opts.envPatchResponse ?? { ok: true, signaled: true })
              ),
          });
        }
        // Default: health probe
        if (typeof url === 'string' && url.includes('/_kilo/gateway/status')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ state: 'running' }),
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      })
    );
  }

  /** Helper: seed a running instance with an API key that expires soon */
  function nearExpiryOverrides(hoursUntilExpiry = 24) {
    return {
      flyMachineId: 'machine-1',
      flyAppName: 'acct-test',
      kilocodeApiKey: 'old-jwt',
      kilocodeApiKeyExpiresAt: new Date(Date.now() + hoursUntilExpiry * 3600000).toISOString(),
    };
  }

  it('refreshes key via push when controller supports env patch', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, nearExpiryOverrides(24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.updateMachine as Mock).mockResolvedValue({});

    mockControllerFetch({ envPatchResponse: { ok: true, signaled: true } });

    await instance.alarm();

    // Should have persisted new expiry
    const newExpiresAt = storage._store.get('kilocodeApiKeyExpiresAt') as string;
    expect(newExpiresAt).toBeDefined();
    expect(newExpiresAt).not.toBe(nearExpiryOverrides(24).kilocodeApiKeyExpiresAt);

    // Fly config persisted with skipLaunch + minSecretsVersion
    expect(flyClient.updateMachine).toHaveBeenCalledWith(
      expect.any(Object),
      'machine-1',
      expect.objectContaining({ env: expect.any(Object) as unknown }),
      expect.objectContaining({
        skipLaunch: true,
        minSecretsVersion: expect.any(Number) as unknown,
      })
    );

    // Push succeeded via in-process env patch. Extra updateMachine calls may
    // occur elsewhere in this test file, so only assert the skipLaunch update.
    expect(
      (flyClient.updateMachine as Mock).mock.calls.some(
        ([, machineId, , options]) =>
          machineId === 'machine-1' &&
          typeof options === 'object' &&
          options !== null &&
          'skipLaunch' in (options as Record<string, unknown>) &&
          (options as { skipLaunch?: boolean }).skipLaunch === true
      )
    ).toBe(true);
  });

  it('skips refresh when key is far from expiry', async () => {
    const { instance, storage } = createInstance();
    // 5 days away — beyond the 3-day threshold
    await seedRunning(storage, nearExpiryOverrides(5 * 24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    mockControllerFetch({});

    await instance.alarm();

    expect(storage._store.get('kilocodeApiKey')).toBe('old-jwt');
  });

  it('persists Fly config when push returns 404 (old controller)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, nearExpiryOverrides(24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.updateMachine as Mock).mockResolvedValue({});

    mockControllerFetch({ envPatchStatus: 404 });

    await instance.alarm();

    // Key persisted — Fly config has the new key for next natural restart
    const newKey = storage._store.get('kilocodeApiKey') as string;
    expect(newKey).toBeDefined();
    expect(newKey).not.toBe('old-jwt');

    // Only one updateMachine call (persist with skipLaunch), no forced restart
    expect(flyClient.updateMachine).toHaveBeenCalledTimes(1);
    expect(flyClient.updateMachine).toHaveBeenCalledWith(
      expect.any(Object),
      'machine-1',
      expect.objectContaining({ env: expect.any(Object) as unknown }),
      expect.objectContaining({ skipLaunch: true })
    );
  });

  it('persists Fly config when push fails with network error', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, nearExpiryOverrides(24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.updateMachine as Mock).mockResolvedValue({});

    mockControllerFetch({ envPatchError: true });

    await instance.alarm();

    // Key persisted despite push failure (Fly config was updated)
    const newKey = storage._store.get('kilocodeApiKey') as string;
    expect(newKey).toBeDefined();
    expect(newKey).not.toBe('old-jwt');

    // Only persist call, no forced restart
    expect(flyClient.updateMachine).toHaveBeenCalledTimes(1);
  });

  it('persists Fly config when signaled is false', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, nearExpiryOverrides(24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.updateMachine as Mock).mockResolvedValue({});

    mockControllerFetch({ envPatchResponse: { ok: true, signaled: false } });

    await instance.alarm();

    // Key persisted
    const newKey = storage._store.get('kilocodeApiKey') as string;
    expect(newKey).toBeDefined();
    expect(newKey).not.toBe('old-jwt');

    // Only persist call, no forced restart
    expect(flyClient.updateMachine).toHaveBeenCalledTimes(1);
  });

  it('persists key even when Fly config update fails (push succeeded)', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, nearExpiryOverrides(24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.updateMachine as Mock).mockRejectedValue(new Error('fly api down'));

    mockControllerFetch({ envPatchResponse: { ok: true, signaled: true } });

    await instance.alarm();

    // Key persisted because push succeeded (gateway has new key in process.env)
    const newKey = storage._store.get('kilocodeApiKey') as string;
    expect(newKey).toBeDefined();
    expect(newKey).not.toBe('old-jwt');
    expect(storage._store.get('kilocodeApiKeyExpiresAt')).toBeDefined();
  });

  it('does not persist key when both push and Fly config update fail', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, nearExpiryOverrides(24));

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });
    (flyClient.updateMachine as Mock).mockRejectedValue(new Error('fly api down'));

    mockControllerFetch({ envPatchError: true });

    await instance.alarm();

    // Key must NOT be persisted — gateway still has old key
    expect(storage._store.get('kilocodeApiKey')).toBe('old-jwt');
  });

  it('skips entirely when instance is not running', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, {
      ...nearExpiryOverrides(24),
      status: 'stopped',
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'stopped',
      config: { env: {}, mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('kilocodeApiKey')).toBe('old-jwt');
  });
});

// ============================================================================
// 'starting' status
// ============================================================================

describe("provision: async start sets status to 'starting'", () => {
  it("sets status='starting' immediately and fires start() via waitUntil", async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});

    // provision() returned; waitUntil defers the background start() promise,
    // so status must be 'starting' at this point — not yet 'running'.
    expect(storage._store.get('status')).toBe('starting');

    // Await all background tasks to let start() complete.
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('flyMachineId')).toBe('machine-1');
  });

  it('skips async start on re-provision of existing instance', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.createMachine as Mock).mockClear();

    await instance.provision('user-1', { kilocodeApiKey: 'new-key' });

    expect(flyClient.createMachine).not.toHaveBeenCalled();
    expect(storage._store.get('status')).toBe('running');
  });
});

describe("status guards: 'starting'", () => {
  it('stop() is a no-op when starting', async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, { flyMachineId: 'machine-1' });

    await instance.stop();

    expect(storage._store.get('status')).toBe('starting');
    expect(flyClient.stopMachineAndWait).not.toHaveBeenCalled();
  });

  it('startAsync() rejects when destroying', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'destroying' });

    await expect(instance.startAsync()).rejects.toThrow(
      'Cannot start: instance is being destroyed'
    );
  });

  it('background start() aborts if instance was destroyed while starting', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});
    expect(storage._store.get('status')).toBe('starting');

    // Simulate destroy happening while start() is in flight
    storage._store.set('status', 'destroying');

    // Let the background start() complete — it should see 'destroying' and bail
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('destroying');
  });

  it('background start() aborts if storage was fully deleted (post-deleteAll)', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();

    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);

    await instance.provision('user-1', {});
    expect(storage._store.get('status')).toBe('starting');

    // Simulate full storage wipe (as finalizeDestroyIfComplete does via deleteAll)
    storage._store.clear();

    // Let the background start() complete — status is undefined, should bail
    await Promise.all(waitUntilPromises);

    // Storage should remain empty — start() must not resurrect the instance
    expect(storage._store.get('status')).toBeUndefined();
  });
});

describe("alarm cadence: 'starting'", () => {
  it('schedules fast alarm for starting instances', async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, { flyMachineId: 'machine-1' });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'starting',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    const alarm = storage._getAlarm();
    expect(alarm).not.toBeNull();
    const delta = alarm! - Date.now();
    expect(delta).toBeGreaterThanOrEqual(ALARM_INTERVAL_STARTING_MS);
    expect(delta).toBeLessThanOrEqual(ALARM_INTERVAL_STARTING_MS + ALARM_JITTER_MS + 100);
  });
});

describe('reconcileStarting: Fly-driven status transitions', () => {
  it("transitions to 'running' when Fly machine is started", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, { flyMachineId: 'machine-1', lastStartedAt: null });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('healthCheckFailCount')).toBe(0);
    // lastStartedAt should be backfilled since it was null
    expect(storage._store.get('lastStartedAt')).not.toBeNull();
  });

  it("transitions to 'stopped' when Fly machine is 404", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, { flyMachineId: 'machine-1' });

    (flyClient.getMachine as Mock).mockRejectedValue(
      new FlyApiError('not found', 404, 'machine not found')
    );

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('flyMachineId')).toBeNull();
  });

  it("stays 'starting' when flyMachineId is not yet set (start in progress)", async () => {
    const { instance, storage } = createInstance();
    // No flyMachineId — start() hasn't created the machine yet
    await seedStarting(storage);

    await instance.alarm();

    // Status remains starting; getMachine was NOT called
    expect(storage._store.get('status')).toBe('starting');
    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });

  it("falls back to 'stopped' when startingAt exceeds STARTING_TIMEOUT_MS (no machine)", async () => {
    const { instance, storage } = createInstance();
    // Seed with a startingAt older than the timeout — no machine ID (start() never completed)
    await seedStarting(storage, {
      startingAt: Date.now() - STARTING_TIMEOUT_MS - 1000,
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('startingAt')).toBeNull();
    // getMachine should NOT have been called — no flyMachineId to check
    expect(flyClient.getMachine).not.toHaveBeenCalled();
  });

  it('checks Fly before timing out when flyMachineId is set and machine is started', async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, {
      flyMachineId: 'machine-1',
      startingAt: Date.now() - STARTING_TIMEOUT_MS - 1000,
    });

    // Machine actually started on Fly — timeout should NOT force 'stopped'
    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // syncStatusWithFly should have transitioned to 'running' despite the timeout
    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('startingAt')).toBeNull();
    expect(storage._store.get('lastStartedAt')).not.toBeNull();
  });

  it("falls back to 'stopped' on timeout when flyMachineId is set but machine not started", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, {
      flyMachineId: 'machine-1',
      startingAt: Date.now() - STARTING_TIMEOUT_MS - 1000,
    });

    // Machine exists but still in 'created' state after 5 min
    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'created',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // Checked Fly first, but machine wasn't started — timeout kicks in
    expect(flyClient.getMachine).toHaveBeenCalledWith(expect.anything(), 'machine-1');
    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('startingAt')).toBeNull();
  });
});

describe("syncStatusWithFly: backfill lastStartedAt on 'starting' → 'running'", () => {
  it("sets lastStartedAt when transitioning from 'starting' to 'running'", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, { flyMachineId: 'machine-1', lastStartedAt: null });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    expect(storage._store.get('lastStartedAt')).toBeGreaterThan(0);
  });

  it('does not overwrite existing lastStartedAt when already running', async () => {
    const existingStartedAt = Date.now() - 10_000;
    const { instance, storage } = createInstance();
    await seedRunning(storage, { lastStartedAt: existingStartedAt });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1' });

    await instance.alarm();

    // lastStartedAt should be unchanged (already running, no sync_status transition)
    expect(storage._store.get('lastStartedAt')).toBe(existingStartedAt);
  });
});

describe("syncStatusWithFly: 'destroyed' Fly state clears flyMachineId", () => {
  it("clears flyMachineId and sets status to 'stopped' when Fly reports destroyed", async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'destroyed',
      config: { mounts: [] },
    });

    await instance.alarm();

    expect(storage._store.get('flyMachineId')).toBeNull();
    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('lastStoppedAt')).toBeGreaterThan(0);
    expect(storage._store.get('healthCheckFailCount')).toBe(0);
  });

  it('keeps providerState in sync when the machine id is cleared during reconcile', async () => {
    const storage = createFakeStorage();
    await seedRunning(storage, {
      provider: 'fly',
      providerState: {
        provider: 'fly',
        appName: 'acct-provider-only',
        machineId: 'machine-1',
        volumeId: 'vol-1',
        region: 'iad',
      },
    });
    const { instance: firstInstance } = createInstance(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'destroyed',
      config: { mounts: [] },
    });

    await firstInstance.alarm();

    expect(storage._store.get('flyMachineId')).toBeNull();
    expect(storage._store.get('providerState')).toEqual({
      provider: 'fly',
      appName: 'acct-provider-only',
      machineId: null,
      volumeId: 'vol-1',
      region: 'iad',
    });

    (flyClient.stopMachineAndWait as Mock).mockClear();
    const { instance: reloadedInstance } = createInstance(storage);
    await reloadedInstance.stop();

    expect(flyClient.stopMachineAndWait).not.toHaveBeenCalled();
  });

  it("clears flyMachineId from 'stopped' status when Fly reports destroyed", async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'stopped', lastStoppedAt: Date.now() - 60_000 });

    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'destroyed',
      config: { mounts: [] },
    });

    await instance.alarm();

    expect(storage._store.get('flyMachineId')).toBeNull();
    expect(storage._store.get('status')).toBe('stopped');
  });
});

describe('reconcileStarting: transient Fly API errors respect starting timeout', () => {
  it("stays 'starting' on transient error when NOT timed out", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, {
      flyMachineId: 'machine-1',
      startingAt: Date.now() - 60_000, // 1 min ago, well within timeout
    });

    // getMachine throws a transient error (not 404)
    (flyClient.getMachine as Mock).mockRejectedValue(new Error('connection timeout'));

    await instance.alarm();

    // Should remain in 'starting' — transient error, not yet timed out
    expect(storage._store.get('status')).toBe('starting');
    expect(storage._store.get('startingAt')).not.toBeNull();
  });

  it("falls back to 'stopped' on transient error when timed out", async () => {
    const { instance, storage } = createInstance();
    await seedStarting(storage, {
      flyMachineId: 'machine-1',
      startingAt: Date.now() - STARTING_TIMEOUT_MS - 1000, // past timeout
    });

    // getMachine throws a transient error (not 404)
    (flyClient.getMachine as Mock).mockRejectedValue(new Error('connection timeout'));

    await instance.alarm();

    // Should fall back to 'stopped' — transient error + timed out
    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('startingAt')).toBeNull();
  });
});

// ============================================================================
// start: concurrent call guard
// ============================================================================

describe('start: concurrent calls do not create duplicate machines', () => {
  it('second start() returns early when first is still in progress', async () => {
    const { instance, storage } = createInstance();
    // Provisioned instance with no flyMachineId — metadata recovery will "find" a machine.
    await seedProvisioned(storage, { flyMachineId: null, status: 'stopped' });

    // Make listMachines slow so the first start() is still in-flight when we
    // fire the second one. Use a deferred promise so we control resolution.
    let resolveListMachines!: (v: unknown[]) => void;
    const listMachinesPromise = new Promise<unknown[]>(r => {
      resolveListMachines = r;
    });
    (flyClient.listMachines as Mock).mockReturnValue(listMachinesPromise);

    // Fire the first start() — it will block inside attemptMetadataRecovery
    const firstStart = instance.start('user-1');

    // Give it a microtask tick so it enters the await
    await Promise.resolve();

    // Fire the second start() — should return immediately due to the guard
    const secondStart = instance.start('user-1');
    await secondStart; // resolves immediately (no-op)

    // Now let the first start() proceed: recovery finds a running machine
    resolveListMachines([
      fakeMachine({
        id: 'recovered-machine',
        state: 'started',
        region: 'iad',
        config: { image: 'test:latest', mounts: [{ volume: 'vol-1', path: '/root' }] },
      }),
    ]);
    (flyClient.getMachine as Mock).mockResolvedValue({
      state: 'started',
      config: { mounts: [{ volume: 'vol-1', path: '/root' }] },
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });

    await firstStart;

    // createMachine should NOT have been called — no duplicate
    expect(flyClient.createMachine).not.toHaveBeenCalled();
    // listMachines called exactly once (only from the first start)
    expect(flyClient.listMachines).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// restartMachine live check race guard
// ============================================================================

describe('restartMachine restartingAt guard', () => {
  beforeEach(() => {
    (flyClient.stopMachineAndWait as Mock).mockResolvedValue(undefined);
    (flyClient.updateMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      instance_id: 'inst-updated-001',
    });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });
  });

  it('syncStatusFromLiveCheck skips when restartingAt is set', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);
    (flyClient.getMachine as Mock).mockClear();
    const inFlightStatus = await instance.getStatus();
    expect(inFlightStatus.status).toBe('restarting');
    expect(flyClient.getMachine).not.toHaveBeenCalled();

    await Promise.all(waitUntilPromises);

    // The async restart then finishes and the persisted state transitions back to running.
    const finalStatus = await instance.getStatus();
    expect(finalStatus.status).toBe('running');
  });

  it('persists restarting state immediately and clears restartingAt in storage on success', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);
    expect(storage._store.get('status')).toBe('restarting');
    expect(storage._store.get('restartingAt')).toBeTruthy();

    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('restartingAt')).toBeNull();
    expect(storage._store.get('lastRestartErrorMessage')).toBeNull();
  });

  it('does not falsely recover when background failed but machine reports started', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.updateMachine as Mock).mockRejectedValueOnce(new Error('Fly API error'));

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);

    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('restarting');
    expect(storage._store.get('lastRestartErrorMessage')).toBe('Fly API error');

    // Machine is still started with old config — update never ran.
    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    // Reconcile must NOT clear the error or declare success — the update
    // never happened, so started means old config is still running.
    expect(storage._store.get('status')).toBe('restarting');
    expect(storage._store.get('lastRestartErrorMessage')).toBe('Fly API error');
  });

  it('allows restart from stopped when a machine exists', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage, { status: 'stopped' });

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);
    expect(storage._store.get('status')).toBe('running');
  });

  it('rejects restart when no machine exists', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { flyMachineId: null });

    const result = await instance.restartMachine();

    expect(result).toEqual({ success: false, error: 'No machine exists' });
  });

  it('rejects restart during busy states', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'starting' });

    const result = await instance.restartMachine();

    expect(result).toEqual({ success: false, error: 'Instance is busy' });
  });

  it('rejects restart while destroying', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, { status: 'destroying' });

    const result = await instance.restartMachine();

    expect(result).toEqual({ success: false, error: 'Instance is busy' });
  });

  it('rejects restart while already restarting', async () => {
    const { instance, storage } = createInstance();
    await seedRestarting(storage);

    const result = await instance.restartMachine();

    expect(result).toEqual({ success: false, error: 'Instance is busy' });
  });

  it('rejects restart while provisioned even if a machine id exists', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { flyMachineId: 'machine-1' });

    const result = await instance.restartMachine();

    expect(result).toEqual({ success: false, error: 'Instance is busy' });
  });

  it('keeps restarting status on timeout while Fly remains transient (replacing)', async () => {
    const { instance, storage } = createInstance();
    await seedRestarting(storage, {
      restartingAt: Date.now() - RESTARTING_TIMEOUT_MS - 1_000,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'replacing',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('restarting');
    expect(storage._store.get('lastRestartErrorMessage')).toBe(
      'Restart is taking longer than expected; still reconciling while the machine remains replacing'
    );
  });

  it('keeps restarting status on timeout while Fly remains transient (updating)', async () => {
    const { instance, storage } = createInstance();
    await seedRestarting(storage, {
      restartingAt: Date.now() - RESTARTING_TIMEOUT_MS - 1_000,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'updating',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('restarting');
    expect(storage._store.get('lastRestartErrorMessage')).toBe(
      'Restart is taking longer than expected; still reconciling while the machine remains updating'
    );
  });

  it('transitions to stopped on terminal stopped state during restart reconcile', async () => {
    const { instance, storage } = createInstance();
    await seedRestarting(storage, {
      restartingAt: Date.now() - RESTARTING_TIMEOUT_MS - 1_000,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'stopped',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('restartingAt')).toBeNull();
    expect(storage._store.get('lastRestartErrorMessage')).toBe(
      'Restart is taking longer than expected; still reconciling while the machine remains stopped'
    );
  });

  it('preserves restart error when Fly reports failed during reconcile', async () => {
    const { instance, storage } = createInstance();
    await seedRestarting(storage, {
      restartingAt: Date.now() - RESTARTING_TIMEOUT_MS - 1_000,
      lastRestartErrorMessage: 'prior restart error',
      lastRestartErrorAt: Date.now() - 2_000,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'failed',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('stopped');
    expect(storage._store.get('restartingAt')).toBeNull();
    expect(storage._store.get('lastRestartErrorMessage')).toBe('prior restart error');
  });

  it('does not falsely mark restart successful when update never ran but machine is still started', async () => {
    const { instance, storage } = createInstance();
    // restartUpdateSent defaults to false — updateMachine() never ran
    await seedRestarting(storage);

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('restarting');
  });

  it('marks success when updateMachine was sent but waitForState timed out and Fly eventually started', async () => {
    const { instance, storage } = createInstance();
    // updateMachine ran successfully, but waitForState timed out in background
    await seedRestarting(storage, {
      restartUpdateSent: true,
      lastRestartErrorMessage: 'waitForState timed out',
      lastRestartErrorAt: Date.now() - 30_000,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('restartingAt')).toBeNull();
    expect(storage._store.get('restartUpdateSent')).toBe(false);
    expect(storage._store.get('lastRestartErrorMessage')).toBeNull();
  });

  it('handles restart reconciliation after a fresh DO instance loads persisted state', async () => {
    const storage = createFakeStorage();
    await seedRestarting(storage, { restartUpdateSent: true });

    const { instance } = createInstance(storage);

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('restartingAt')).toBeNull();
  });

  it('preserves existing lastStartedAt when reconcile marks restart successful', async () => {
    const { instance, storage } = createInstance();
    const existingLastStartedAt = Date.now() - 60_000;
    await seedRestarting(storage, {
      restartUpdateSent: true,
      lastStartedAt: existingLastStartedAt,
    });

    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });

    await instance.alarm();

    expect(storage._store.get('status')).toBe('running');
    expect(storage._store.get('restartingAt')).toBeNull();
    expect(storage._store.get('lastStartedAt')).toBe(existingLastStartedAt);
  });

  it('records restart errors durably on failure', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.updateMachine as Mock).mockRejectedValueOnce(new Error('Fly API error'));

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);
    expect(storage._store.get('lastRestartErrorMessage')).toBe('Fly API error');
    expect(storage._store.get('lastRestartErrorAt')).toBeGreaterThan(0);
  });

  it('treats waitForState timeout after update as expected when restartUpdateSent was persisted mid-flight', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    (flyClient.updateMachine as Mock).mockResolvedValueOnce({
      id: 'machine-1',
      instance_id: 'inst-updated-001',
    });
    (flyClient.getMachine as Mock).mockResolvedValueOnce({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });
    (flyClient.waitForState as Mock).mockRejectedValueOnce(
      new FlyApiError('timeout', 408, 'timed out waiting for start')
    );

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);

    expect(storage._store.get('status')).toBe('restarting');
    expect(storage._store.get('restartUpdateSent')).toBe(true);
    expect(storage._store.get('lastRestartErrorMessage')).toBeNull();
    expect(storage._store.get('lastRestartErrorAt')).toBeNull();
  });

  it('background restart aborts without writing state if instance was destroyed concurrently', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    // Make updateMachine simulate destroy clearing storage mid-flight
    (flyClient.updateMachine as Mock).mockImplementation(async () => {
      // Simulate destroy() running during the update
      storage._store.clear();
    });

    const result = await instance.restartMachine();
    expect(result.success).toBe(true);

    await Promise.all(waitUntilPromises);

    // Storage should remain empty — background must not recreate partial state
    expect(storage._store.has('lastRestartErrorMessage')).toBe(false);
    expect(storage._store.has('restartUpdateSent')).toBe(false);
  });

  it('clears restart errors at the beginning of a retry attempt', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage, {
      lastRestartErrorMessage: 'old restart error',
      lastRestartErrorAt: Date.now() - 10_000,
    });

    const result = await instance.restartMachine();

    expect(result.success).toBe(true);
    expect(storage._store.get('lastRestartErrorMessage')).toBeNull();
    expect(storage._store.get('lastRestartErrorAt')).toBeNull();
  });
});

// ============================================================================
// Volume reassociation (admin)
// ============================================================================

describe('listCandidateVolumes', () => {
  it('returns all usable volumes with isCurrent flag', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1' });

    (flyClient.listVolumes as Mock).mockResolvedValueOnce([
      {
        id: 'vol-1',
        name: 'kiloclaw_sb1',
        state: 'attached',
        size_gb: 1,
        region: 'iad',
        attached_machine_id: 'mach-1',
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'vol-2',
        name: 'kiloclaw_sb1_old',
        state: 'detached',
        size_gb: 1,
        region: 'iad',
        attached_machine_id: null,
        created_at: '2024-12-01T00:00:00Z',
      },
      {
        id: 'vol-3',
        name: 'kiloclaw_sb1_destroyed',
        state: 'destroyed',
        size_gb: 1,
        region: 'iad',
        attached_machine_id: null,
        created_at: '2024-11-01T00:00:00Z',
      },
    ]);

    const result = await instance.listCandidateVolumes();

    expect(result.currentVolumeId).toBe('vol-1');
    // Destroyed volumes are filtered out
    expect(result.volumes).toHaveLength(2);
    expect(result.volumes[0].id).toBe('vol-1');
    expect(result.volumes[0].isCurrent).toBe(true);
    expect(result.volumes[1].id).toBe('vol-2');
    expect(result.volumes[1].isCurrent).toBe(false);
  });

  it('filters out destroying volumes', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1' });

    (flyClient.listVolumes as Mock).mockResolvedValueOnce([
      {
        id: 'vol-1',
        name: 'v1',
        state: 'attached',
        size_gb: 1,
        region: 'iad',
        attached_machine_id: null,
        created_at: '2025-01-01T00:00:00Z',
      },
      {
        id: 'vol-4',
        name: 'v4',
        state: 'destroying',
        size_gb: 1,
        region: 'iad',
        attached_machine_id: null,
        created_at: '2025-01-01T00:00:00Z',
      },
    ]);

    const result = await instance.listCandidateVolumes();
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0].id).toBe('vol-1');
  });
});

describe('reassociateVolume', () => {
  it('rejects when instance is not provisioned', async () => {
    const { instance } = createInstance();
    // No seedProvisioned — userId is null
    await expect(instance.reassociateVolume('vol-2', 'fixing wrong volume')).rejects.toThrow(
      'Instance is not provisioned'
    );
  });

  it('rejects when instance is not stopped', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    await expect(instance.reassociateVolume('vol-2', 'fixing wrong volume')).rejects.toThrow(
      'Instance must be stopped before reassociating volume'
    );
  });

  it('rejects when new volume is the same as current', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1' });

    await expect(instance.reassociateVolume('vol-1', 'fixing wrong volume')).rejects.toThrow(
      'New volume ID is the same as the current volume'
    );
  });

  it('rejects when volume is not found in Fly', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1' });

    (flyClient.getVolume as Mock).mockRejectedValueOnce(new FlyApiError('not found', 404, '{}'));

    await expect(instance.reassociateVolume('vol-bad', 'fixing wrong volume')).rejects.toThrow(
      'Volume vol-bad not found in this Fly app'
    );
  });

  it('rejects when volume is in destroyed state', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1' });

    (flyClient.getVolume as Mock).mockResolvedValueOnce({
      id: 'vol-dead',
      name: 'v',
      state: 'destroyed',
      size_gb: 1,
      region: 'iad',
      attached_machine_id: null,
      created_at: '2025-01-01T00:00:00Z',
    });

    await expect(instance.reassociateVolume('vol-dead', 'fixing wrong volume')).rejects.toThrow(
      'Volume vol-dead is in state "destroyed" and cannot be used'
    );
  });

  it('successfully reassociates volume on stopped instance', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1', flyRegion: 'iad' });

    (flyClient.getVolume as Mock).mockResolvedValueOnce({
      id: 'vol-2',
      name: 'kiloclaw_sb1_fork',
      state: 'detached',
      size_gb: 1,
      region: 'ewr',
      attached_machine_id: null,
      created_at: '2025-01-01T00:00:00Z',
    });

    const result = await instance.reassociateVolume('vol-2', 'fixing wrong volume after migration');

    expect(result.previousVolumeId).toBe('vol-1');
    expect(result.newVolumeId).toBe('vol-2');
    expect(result.newRegion).toBe('ewr');

    // Verify storage was updated
    expect(storage._store.get('flyVolumeId')).toBe('vol-2');
    expect(storage._store.get('flyRegion')).toBe('ewr');
  });

  it('updates region when reassociating to volume in different region', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped', flyVolumeId: 'vol-1', flyRegion: 'iad' });

    (flyClient.getVolume as Mock).mockResolvedValueOnce({
      id: 'vol-3',
      name: 'v3',
      state: 'created',
      size_gb: 2,
      region: 'lax',
      attached_machine_id: null,
      created_at: '2025-01-01T00:00:00Z',
    });

    const result = await instance.reassociateVolume('vol-3', 'moving to west coast region');

    expect(result.newRegion).toBe('lax');
    expect(storage._store.get('flyRegion')).toBe('lax');
  });
});

// ============================================================================
// resizeMachine
// ============================================================================

describe('resizeMachine', () => {
  it('rejects when instance is not provisioned', async () => {
    const { instance } = createInstance();
    await expect(
      instance.resizeMachine({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' })
    ).rejects.toThrow('Instance is not provisioned');
  });

  it('rejects when instance is being destroyed', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'destroying' });

    await expect(
      instance.resizeMachine({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' })
    ).rejects.toThrow('Cannot resize: instance is being destroyed');
  });

  it('rejects when instance is restoring', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'restoring' });

    await expect(
      instance.resizeMachine({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' })
    ).rejects.toThrow('Cannot resize: instance is restoring from snapshot');
  });

  it('rejects when instance is recovering', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'recovering' });

    await expect(
      instance.resizeMachine({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' })
    ).rejects.toThrow('Cannot resize: instance is recovering');
  });

  it('persists new machine size and returns previous', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, {
      machineSize: { cpus: 2, memory_mb: 3072, cpu_kind: 'shared' },
    });

    const result = await instance.resizeMachine({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' });

    expect(result.previousSize).toEqual({ cpus: 2, memory_mb: 3072, cpu_kind: 'shared' });
    expect(result.newSize).toEqual({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' });
    const stored = storage._store.get('machineSize') as { cpus: number; memory_mb: number };
    expect(stored.cpus).toBe(4);
    expect(stored.memory_mb).toBe(3072);
  });

  it('returns null previousSize when no prior size set', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.resizeMachine({
      cpus: 1,
      memory_mb: 3072,
      cpu_kind: 'performance',
    });

    expect(result.previousSize).toBeNull();
    expect(result.newSize).toEqual({ cpus: 1, memory_mb: 3072, cpu_kind: 'performance' });
  });

  it('allows resize when instance is running', async () => {
    const { instance, storage } = createInstance();
    await seedRunning(storage);

    const result = await instance.resizeMachine({ cpus: 4, memory_mb: 3072, cpu_kind: 'shared' });

    expect(result.newSize.cpus).toBe(4);
  });

  it('allows resize when instance is stopped', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { status: 'stopped' });

    const result = await instance.resizeMachine({
      cpus: 2,
      memory_mb: 4096,
      cpu_kind: 'performance',
    });

    expect(result.newSize).toEqual({ cpus: 2, memory_mb: 4096, cpu_kind: 'performance' });
  });
});

// ============================================================================
// updateExecPreset
// ============================================================================

describe('updateExecPreset', () => {
  it('persists exec security and ask to DO storage', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.updateExecPreset({ security: 'full', ask: 'off' });

    expect(result.execSecurity).toBe('full');
    expect(result.execAsk).toBe('off');
    expect(storage._store.get('execSecurity')).toBe('full');
    expect(storage._store.get('execAsk')).toBe('off');
  });

  it('updates only the fields that are provided', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    await instance.updateExecPreset({ security: 'full' });

    expect(storage._store.get('execSecurity')).toBe('full');
    expect(storage._store.get('execAsk')).toBeUndefined();
  });

  it('returns current state when no fields are provided', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { execSecurity: 'full', execAsk: 'off' });

    const result = await instance.updateExecPreset({});

    expect(result.execSecurity).toBe('full');
    expect(result.execAsk).toBe('off');
  });
});

describe('updateBotIdentity', () => {
  it('persists bot identity fields to DO storage', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage);

    const result = await instance.updateBotIdentity({
      botName: 'Milo',
      botNature: 'Operations copilot',
      botVibe: 'Dry wit',
      botEmoji: '🤖',
    });

    expect(result).toEqual({
      botName: 'Milo',
      botNature: 'Operations copilot',
      botVibe: 'Dry wit',
      botEmoji: '🤖',
    });
    expect(storage._store.get('botName')).toBe('Milo');
    expect(storage._store.get('botNature')).toBe('Operations copilot');
    expect(storage._store.get('botVibe')).toBe('Dry wit');
    expect(storage._store.get('botEmoji')).toBe('🤖');
  });

  it('writes IDENTITY.md on running instances', async () => {
    const env = createFakeEnv();
    env.FLY_APP_NAME = 'bot-app';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, path: 'workspace/IDENTITY.md' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { instance, storage } = createInstance(undefined, env);
    await seedProvisioned(storage, {
      status: 'running',
      flyMachineId: 'machine-1',
      sandboxId: 'sandbox-1',
    });

    await instance.updateBotIdentity({ botName: 'Milo' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bot-app.fly.dev/_kilo/bot-identity',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          botName: 'Milo',
          botNature: null,
          botVibe: null,
          botEmoji: null,
        }),
      })
    );
    vi.unstubAllGlobals();
  });
});

describe('tryMarkInstanceReady', () => {
  it('returns shouldNotify: true on first call and persists the flag', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { instanceReadyEmailSent: false });

    const result = await instance.tryMarkInstanceReady();

    expect(result).toEqual({ shouldNotify: true, userId: 'user-1' });
    expect(storage._store.get('instanceReadyEmailSent')).toBe(true);
  });

  it('returns shouldNotify: false on subsequent calls', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { instanceReadyEmailSent: false });

    await instance.tryMarkInstanceReady();
    const result = await instance.tryMarkInstanceReady();

    expect(result).toEqual({ shouldNotify: false, userId: 'user-1' });
  });

  it('returns shouldNotify: false when flag is already persisted', async () => {
    const { instance, storage } = createInstance();
    await seedProvisioned(storage, { instanceReadyEmailSent: true });

    const putSpy = vi.spyOn(storage, 'put');
    const result = await instance.tryMarkInstanceReady();

    expect(result).toEqual({ shouldNotify: false, userId: 'user-1' });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it('suppresses email for legacy instances without the field (migration)', async () => {
    const { instance, storage } = createInstance();
    // Seed a provisioned instance WITHOUT instanceReadyEmailSent in storage.
    // The migration in loadState treats this as already-sent to prevent
    // spurious emails to pre-existing instances after deploy.
    await seedProvisioned(storage);

    const result = await instance.tryMarkInstanceReady();

    expect(result).toEqual({ shouldNotify: false, userId: 'user-1' });
  });

  it('allows email for newly provisioned instances with the field explicitly set', async () => {
    const { instance, storage } = createInstance();
    // New instances created after deploy will have the field explicitly in storage.
    await seedProvisioned(storage, { instanceReadyEmailSent: false });

    const result = await instance.tryMarkInstanceReady();

    expect(result).toEqual({ shouldNotify: true, userId: 'user-1' });
    expect(storage._store.get('instanceReadyEmailSent')).toBe(true);
  });
});

// ============================================================================
// Stream Chat backfill
// ============================================================================

describe('Stream Chat backfill on provision', () => {
  beforeEach(() => {
    (flyClient.createVolumeWithFallback as Mock).mockResolvedValue({
      id: 'vol-1',
      region: 'iad',
    });
    (flyClient.getVolume as Mock).mockResolvedValue({ id: 'vol-1', region: 'iad' });
    (flyClient.createMachine as Mock).mockResolvedValue({ id: 'machine-1', region: 'iad' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (setupDefaultStreamChatChannel as Mock).mockClear();
  });

  it('provisions Stream Chat on first provision when env vars are present', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect(setupDefaultStreamChatChannel).toHaveBeenCalledOnce();
    expect(storage._store.get('streamChatApiKey')).toBe('sc-api-key');
    expect(storage._store.get('streamChatBotUserId')).toBe('bot-sandbox-1');
    expect(storage._store.get('streamChatBotUserToken')).toBe('sc-bot-token');
    expect(storage._store.get('streamChatChannelId')).toBe('default-sandbox-1');
  });

  it('backfills Stream Chat on re-provision when DO state has no credentials', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage } = createInstance(undefined, env);
    await seedRunning(storage);

    (setupDefaultStreamChatChannel as Mock).mockClear();
    await instance.provision('user-1', { kilocodeApiKey: 'new-key' });

    expect(setupDefaultStreamChatChannel).toHaveBeenCalledOnce();
    expect(storage._store.get('streamChatApiKey')).toBe('sc-api-key');
    expect(storage._store.get('streamChatBotUserId')).toBe('bot-sandbox-1');
    expect(storage._store.get('streamChatBotUserToken')).toBe('sc-bot-token');
    expect(storage._store.get('streamChatChannelId')).toBe('default-sandbox-1');
  });

  it('skips Stream Chat setup on re-provision when credentials already exist', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage } = createInstance(undefined, env);
    await seedRunning(storage, {
      streamChatApiKey: 'existing-key',
      streamChatBotUserId: 'existing-bot',
      streamChatBotUserToken: 'existing-token',
      streamChatChannelId: 'existing-channel',
    });

    (setupDefaultStreamChatChannel as Mock).mockClear();
    await instance.provision('user-1', { kilocodeApiKey: 'new-key' });

    expect(setupDefaultStreamChatChannel).not.toHaveBeenCalled();
    expect(storage._store.get('streamChatApiKey')).toBe('existing-key');
  });

  it('skips Stream Chat when worker env vars are missing', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    // Default env does not have STREAM_CHAT_API_KEY / STREAM_CHAT_API_SECRET

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    expect(setupDefaultStreamChatChannel).not.toHaveBeenCalled();
    expect(storage._store.get('streamChatApiKey')).toBeUndefined();
  });

  it('continues provisioning when Stream Chat setup fails (non-fatal)', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);

    (setupDefaultStreamChatChannel as Mock).mockRejectedValueOnce(
      new Error('Stream Chat API down')
    );

    await instance.provision('user-1', {});
    await Promise.all(waitUntilPromises);

    // Provision succeeded despite Stream Chat failure
    expect(storage._store.get('status')).toBeTruthy();
    expect(storage._store.get('streamChatApiKey')).toBeUndefined();
  });
});

describe('Stream Chat backfill on restartMachine', () => {
  beforeEach(() => {
    (flyClient.updateMachine as Mock).mockResolvedValue({ instance_id: 'inst-1' });
    (flyClient.waitForState as Mock).mockResolvedValue(undefined);
    (flyClient.getMachine as Mock).mockResolvedValue({
      id: 'machine-1',
      state: 'started',
      config: { guest: { cpus: 1, memory_mb: 256, cpu_kind: 'shared' } },
    });
    (setupDefaultStreamChatChannel as Mock).mockClear();
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
        return Promise.resolve({ ok: true, status: 200 });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('backfills Stream Chat on restart when DO state has no credentials', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);
    await seedRunning(storage);

    const result = await instance.restartMachine();
    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);

    expect(setupDefaultStreamChatChannel).toHaveBeenCalledOnce();
    expect(storage._store.get('streamChatApiKey')).toBe('sc-api-key');
    expect(storage._store.get('streamChatBotUserId')).toBe('bot-sandbox-1');
    expect(storage._store.get('streamChatBotUserToken')).toBe('sc-bot-token');
    expect(storage._store.get('streamChatChannelId')).toBe('default-sandbox-1');
  });

  it('skips Stream Chat backfill on restart when credentials already exist', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);
    await seedRunning(storage, {
      streamChatApiKey: 'existing-key',
      streamChatBotUserId: 'existing-bot',
      streamChatBotUserToken: 'existing-token',
      streamChatChannelId: 'existing-channel',
    });

    const result = await instance.restartMachine();
    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);

    expect(setupDefaultStreamChatChannel).not.toHaveBeenCalled();
    expect(storage._store.get('streamChatApiKey')).toBe('existing-key');
  });

  it('continues restart when Stream Chat backfill fails (non-fatal)', async () => {
    const env = createFakeEnv();
    Object.assign(env, {
      STREAM_CHAT_API_KEY: 'sc-key',
      STREAM_CHAT_API_SECRET: 'sc-secret',
    });
    const { instance, storage, waitUntilPromises } = createInstance(undefined, env);
    await seedRunning(storage);

    (setupDefaultStreamChatChannel as Mock).mockRejectedValueOnce(
      new Error('Stream Chat API down')
    );

    const result = await instance.restartMachine();
    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);

    // Restart still completes — Stream Chat failure is non-fatal
    expect(storage._store.get('streamChatApiKey')).toBeUndefined();
    // Machine was still updated
    expect(flyClient.updateMachine).toHaveBeenCalled();
  });

  it('skips Stream Chat backfill when worker env vars are missing', async () => {
    const { instance, storage, waitUntilPromises } = createInstance();
    await seedRunning(storage);

    const result = await instance.restartMachine();
    expect(result.success).toBe(true);
    await Promise.all(waitUntilPromises);

    expect(setupDefaultStreamChatChannel).not.toHaveBeenCalled();
  });
});
