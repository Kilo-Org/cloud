import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as DbModule from '../db';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock('../db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getWorkerDb: vi.fn(() => ({})),
    getActivePersonalInstance: vi.fn(),
    getInstanceByIdIncludingDestroyed: vi.fn(),
  };
});

import { platform, resolveInstanceDoKey } from './platform';
import { sandboxIdFromUserId } from '../auth/sandbox-id';
import { getActivePersonalInstance, getInstanceByIdIncludingDestroyed } from '../db';

const currentUserId = '199e2b19-aa40-488d-9442-9a18a620ba68';
const legacyDoKey = 'oauth/google:117453785559478190551';
const legacySandboxId = sandboxIdFromUserId(legacyDoKey);

function makeEnv() {
  const idFromName = vi.fn((id: string) => id);
  const getStatus = vi.fn().mockResolvedValue({
    userId: currentUserId,
    sandboxId: legacySandboxId,
    status: 'running',
    flyMachineId: 'machine-1',
    flyAppName: 'acct-legacy',
  });

  return {
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://fake' },
      KILOCLAW_INSTANCE: {
        idFromName,
        get: () => ({ getStatus, destroy: vi.fn().mockResolvedValue(undefined) }),
      },
      KILOCLAW_AE: { writeDataPoint: vi.fn() },
      KILOCLAW_REGISTRY: {
        idFromName: vi.fn((id: string) => id),
        get: () => ({
          listInstances: vi.fn().mockResolvedValue([]),
          destroyInstance: vi.fn().mockResolvedValue(undefined),
        }),
      },
      KV_CLAW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
    } as never,
    idFromName,
    getStatus,
  };
}

describe('legacy platform DO routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the original legacy DO key from the active instance row', async () => {
    vi.mocked(getActivePersonalInstance).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sandboxId: legacySandboxId,
      orgId: null,
    });

    const { env, idFromName, getStatus } = makeEnv();
    const response = await platform.request(`/status?userId=${currentUserId}`, {}, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        sandboxId: legacySandboxId,
        flyAppName: 'acct-legacy',
      })
    );
    expect(idFromName).toHaveBeenCalledWith(legacyDoKey);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('returns the instanceId for instance-keyed rows when instanceId is omitted', async () => {
    vi.mocked(getActivePersonalInstance).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sandboxId: 'ki_11111111111141118111111111111111',
      orgId: null,
    });

    await expect(
      resolveInstanceDoKey(
        {
          HYPERDRIVE: { connectionString: 'postgresql://fake' },
        } as never,
        currentUserId
      )
    ).resolves.toBe('11111111-1111-4111-8111-111111111111');
  });

  it('falls back to explicit instanceId when fresh provision row is not persisted yet', async () => {
    const freshInstanceId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(getInstanceByIdIncludingDestroyed).mockResolvedValue(null);

    await expect(
      resolveInstanceDoKey(
        {
          HYPERDRIVE: { connectionString: 'postgresql://fake' },
        } as never,
        currentUserId,
        freshInstanceId
      )
    ).resolves.toBe(freshInstanceId);
  });

  it('resolves destroyed legacy rows to original DO key', async () => {
    const legacyInstanceId = '33333333-3333-4333-8333-333333333333';
    vi.mocked(getInstanceByIdIncludingDestroyed).mockResolvedValue({
      id: legacyInstanceId,
      sandboxId: legacySandboxId,
      userId: currentUserId,
      orgId: null,
      inboundEmailEnabled: true,
      provider: 'fly',
    });

    await expect(
      resolveInstanceDoKey(
        {
          HYPERDRIVE: { connectionString: 'postgresql://fake' },
        } as never,
        currentUserId,
        legacyInstanceId
      )
    ).resolves.toBe(legacyDoKey);
  });

  it('destroys preexisting legacy registry rows keyed by the migrated user id', async () => {
    vi.mocked(getActivePersonalInstance).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      sandboxId: legacySandboxId,
      orgId: null,
    });

    const destroyInstance = vi.fn().mockResolvedValue(undefined);
    const listInstances = vi.fn().mockResolvedValue([
      {
        instanceId: '11111111-1111-4111-8111-111111111111',
        doKey: currentUserId,
        assignedUserId: currentUserId,
        createdAt: new Date().toISOString(),
        destroyedAt: null,
      },
    ]);

    const { env } = makeEnv();
    (
      env as unknown as {
        KILOCLAW_REGISTRY: {
          idFromName: (id: string) => string;
          get: () => {
            listInstances: typeof listInstances;
            destroyInstance: typeof destroyInstance;
          };
        };
      }
    ).KILOCLAW_REGISTRY = {
      idFromName: vi.fn((id: string) => id),
      get: () => ({ listInstances, destroyInstance }),
    };

    const response = await platform.request(
      '/destroy',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: currentUserId }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(destroyInstance).toHaveBeenCalledWith(
      `user:${currentUserId}`,
      '11111111-1111-4111-8111-111111111111'
    );
  });
});

describe('resolveInstanceDoKey with instanceId', () => {
  const env = {
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
  } as never;
  const instanceId = '11111111-1111-4111-8111-111111111111';
  const newSandboxId = 'ki_11111111111141118111111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates the UUID to the legacy userId DO key when the instance row is legacy', async () => {
    vi.mocked(getInstanceByIdIncludingDestroyed).mockResolvedValue({
      id: instanceId,
      sandboxId: legacySandboxId,
      userId: currentUserId,
      orgId: null,
      inboundEmailEnabled: false,
      provider: 'fly',
    });

    await expect(resolveInstanceDoKey(env, currentUserId, instanceId)).resolves.toBe(legacyDoKey);
  });

  it('returns the raw UUID when the instance row is instance-keyed', async () => {
    vi.mocked(getInstanceByIdIncludingDestroyed).mockResolvedValue({
      id: instanceId,
      sandboxId: newSandboxId,
      userId: currentUserId,
      orgId: null,
      inboundEmailEnabled: false,
      provider: 'fly',
    });

    await expect(resolveInstanceDoKey(env, currentUserId, instanceId)).resolves.toBe(instanceId);
  });

  it('falls back to the raw UUID when the instance row is missing', async () => {
    vi.mocked(getInstanceByIdIncludingDestroyed).mockResolvedValue(null);

    await expect(resolveInstanceDoKey(env, currentUserId, instanceId)).resolves.toBe(instanceId);
  });

  it('falls back to the raw UUID when the Hyperdrive lookup throws', async () => {
    vi.mocked(getInstanceByIdIncludingDestroyed).mockRejectedValue(new Error('hyperdrive down'));

    await expect(resolveInstanceDoKey(env, currentUserId, instanceId)).resolves.toBe(instanceId);
  });
});
