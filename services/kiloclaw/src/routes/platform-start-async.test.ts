import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function makeEnv(overrides: Record<string, unknown> = {}) {
  const startAsync = vi.fn().mockResolvedValue(undefined);
  return {
    env: {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ startAsync }),
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
    startAsync,
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

let loggedValues: unknown[] = [];

function findJsonLog(message: string): Record<string, unknown> | undefined {
  return loggedValues
    .filter((value: unknown): value is string => typeof value === 'string' && value.startsWith('{'))
    .map((value: string) => JSON.parse(value) as Record<string, unknown>)
    .find((record: Record<string, unknown>) => record.message === message);
}

describe('POST /start-async', () => {
  beforeEach(() => {
    loggedValues = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
    vi.spyOn(console, 'error').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 and calls the DO async start path', async () => {
    const { env, startAsync } = makeEnv();
    const { path, init } = postJson(
      '/start-async?instanceId=11111111-1111-4111-8111-111111111111',
      {
        userId: 'user-1',
      }
    );

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(startAsync).toHaveBeenCalledWith('user-1');
  });

  it('logs billing-correlated async start requests with propagated context', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson(
      '/start-async?instanceId=11111111-1111-4111-8111-111111111111',
      {
        userId: 'user-1',
      }
    );
    const headers = new Headers(init.headers as Record<string, string>);
    headers.set('x-kiloclaw-billing-run-id', '11111111-1111-4111-8111-111111111111');
    headers.set('x-kiloclaw-billing-sweep', 'interrupted_auto_resume');
    headers.set('x-kiloclaw-billing-call-id', '22222222-2222-4222-8222-222222222222');
    headers.set('x-kiloclaw-billing-attempt', '2');

    const response = await platform.request(
      path,
      {
        ...init,
        headers,
      },
      env
    );

    expect(response.status).toBe(200);
    expect(findJsonLog('Starting billing-correlated kiloclaw platform request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingSweep: 'interrupted_auto_resume',
        billingComponent: 'kiloclaw_platform',
        method: 'POST',
        path: '/start-async',
      })
    );
    expect(findJsonLog('Finished billing-correlated kiloclaw platform request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingSweep: 'interrupted_auto_resume',
        billingComponent: 'kiloclaw_platform',
        outcome: 'completed',
        method: 'POST',
        path: '/start-async',
        statusCode: 200,
        userId: 'user-1',
      })
    );
  });

  it('surfaces DO guard errors from async start requests', async () => {
    const err = Object.assign(new Error('Cannot start: instance is being destroyed'), {
      status: 409,
    });
    const { env, startAsync } = makeEnv();
    startAsync.mockRejectedValueOnce(err);
    const { path, init } = postJson('/start-async', {
      userId: 'user-1',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'start failed',
    });
  });
});
