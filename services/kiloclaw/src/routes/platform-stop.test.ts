import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function makeEnv(overrides: Record<string, unknown> = {}) {
  const stop = vi.fn().mockResolvedValue({
    stopped: true,
    previousStatus: 'running',
    currentStatus: 'stopped',
    stoppedAt: 1_776_885_000_000,
  });
  return {
    env: {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ stop }),
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
    stop,
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /stop', () => {
  it('passes an optional stop reason through to the DO', async () => {
    const { env, stop } = makeEnv();
    const { path, init } = postJson('/stop?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
      reason: 'trial_inactivity',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      stopped: true,
      previousStatus: 'running',
      currentStatus: 'stopped',
      stoppedAt: 1_776_885_000_000,
    });
    expect(stop).toHaveBeenCalledWith({ reason: 'trial_inactivity' });
  });

  it('keeps the stop call backward-compatible when no reason is provided', async () => {
    const { env, stop } = makeEnv();
    const { path, init } = postJson('/stop', {
      userId: 'user-1',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(stop).toHaveBeenCalledWith(undefined);
  });

  it('rejects unknown stop reasons', async () => {
    const { env, stop } = makeEnv();
    const { path, init } = postJson('/stop', {
      userId: 'user-1',
      reason: 'typoed_reason',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(400);
    expect(stop).not.toHaveBeenCalled();
  });
});
