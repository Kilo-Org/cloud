import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function makeEnv(overrides: Record<string, unknown> = {}) {
  const destroy = vi.fn().mockResolvedValue({
    finalized: true,
    destroyedUserId: 'user-1',
    destroyedSandboxId: 'ki_11111111111141118111111111111111',
    pendingMachineId: null,
    pendingVolumeId: null,
    lastDestroyErrorOp: null,
    lastDestroyErrorStatus: null,
    lastDestroyErrorAt: null,
  });
  return {
    env: {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ destroy, getStatus: vi.fn().mockResolvedValue({ orgId: null }) }),
      },
      KILOCLAW_REGISTRY: {
        idFromName: (id: string) => id,
        get: () => ({
          destroyInstance: vi.fn().mockResolvedValue(undefined),
          listInstances: vi.fn().mockResolvedValue([]),
        }),
      },
      KILOCLAW_AE: { writeDataPoint: vi.fn() },
      KV_CLAW_CACHE: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      },
      ...overrides,
    } as never,
    destroy,
  };
}

function postJson(path: string, body: Record<string, unknown>) {
  return {
    path,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /destroy', () => {
  it('passes an optional destroy reason through to the DO', async () => {
    const { env, destroy } = makeEnv();
    const { path, init } = postJson('/destroy?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
      reason: 'manual_user_request',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      finalized: true,
      destroyedUserId: 'user-1',
      destroyedSandboxId: 'ki_11111111111141118111111111111111',
      pendingMachineId: null,
      pendingVolumeId: null,
      lastDestroyErrorOp: null,
      lastDestroyErrorStatus: null,
      lastDestroyErrorAt: null,
    });
    expect(destroy).toHaveBeenCalledWith({ reason: 'manual_user_request' });
  });

  it('keeps the destroy call backward-compatible when no reason is provided', async () => {
    const { env, destroy } = makeEnv();
    const { path, init } = postJson('/destroy?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true, finalized: true }));
    expect(destroy).toHaveBeenCalledWith(undefined);
  });

  it('returns pending destroy cleanup details from the DO', async () => {
    const { env, destroy } = makeEnv();
    destroy.mockResolvedValueOnce({
      finalized: false,
      destroyedUserId: null,
      destroyedSandboxId: null,
      pendingMachineId: null,
      pendingVolumeId: 'vol-1',
      lastDestroyErrorOp: 'volume',
      lastDestroyErrorStatus: 412,
      lastDestroyErrorAt: 1_777_777_777,
    });
    const { path, init } = postJson('/destroy?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      finalized: false,
      destroyedUserId: null,
      destroyedSandboxId: null,
      pendingMachineId: null,
      pendingVolumeId: 'vol-1',
      lastDestroyErrorOp: 'volume',
      lastDestroyErrorStatus: 412,
      lastDestroyErrorAt: 1_777_777_777,
    });
  });

  it('rejects unknown destroy reasons', async () => {
    const { env, destroy } = makeEnv();
    const { path, init } = postJson('/destroy?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
      reason: 'typoed_reason',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(400);
    expect(destroy).not.toHaveBeenCalled();
  });
});
