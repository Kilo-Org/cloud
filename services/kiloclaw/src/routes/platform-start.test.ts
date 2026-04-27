import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function makeEnv(overrides: Record<string, unknown> = {}) {
  const start = vi.fn().mockResolvedValue({
    started: true,
    previousStatus: 'stopped',
    currentStatus: 'running',
    startedAt: 1_776_885_000_000,
  });
  return {
    env: {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ start }),
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
    start,
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

describe('POST /start', () => {
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

  it('returns the structured start result from the DO sync start path', async () => {
    const { env, start } = makeEnv();
    const { path, init } = postJson('/start?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      started: true,
      previousStatus: 'stopped',
      currentStatus: 'running',
      startedAt: 1_776_885_000_000,
    });
    expect(start).toHaveBeenCalledWith('user-1', undefined);
  });

  it('passes an optional start reason through to the DO', async () => {
    const { env, start } = makeEnv();
    const { path, init } = postJson('/start?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
      reason: 'manual_user_request',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      started: true,
      previousStatus: 'stopped',
      currentStatus: 'running',
      startedAt: 1_776_885_000_000,
    });
    expect(start).toHaveBeenCalledWith('user-1', { reason: 'manual_user_request' });
  });

  it('returns a structured no-op result when the instance is still stopped', async () => {
    const { env, start } = makeEnv();
    start.mockResolvedValueOnce({
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });
    const { path, init } = postJson('/start', {
      userId: 'user-1',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      started: false,
      previousStatus: 'stopped',
      currentStatus: 'stopped',
      startedAt: null,
    });
  });

  it('rejects unknown start reasons', async () => {
    const { env, start } = makeEnv();
    const { path, init } = postJson('/start', {
      userId: 'user-1',
      reason: 'typoed_reason',
    });

    const response = await platform.request(path, init, env);

    expect(response.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it('logs billing-correlated start requests with propagated context', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/start?instanceId=11111111-1111-4111-8111-111111111111', {
      userId: 'user-1',
    });
    const headers = new Headers(init.headers as Record<string, string>);
    headers.set('x-kiloclaw-billing-run-id', '11111111-1111-4111-8111-111111111111');
    headers.set('x-kiloclaw-billing-sweep', 'trial_inactivity_stop_candidate');
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
        billingSweep: 'trial_inactivity_stop_candidate',
        billingComponent: 'kiloclaw_platform',
        method: 'POST',
        path: '/start',
      })
    );
    expect(findJsonLog('Finished billing-correlated kiloclaw platform request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingSweep: 'trial_inactivity_stop_candidate',
        billingComponent: 'kiloclaw_platform',
        outcome: 'completed',
        method: 'POST',
        path: '/start',
        statusCode: 200,
        userId: 'user-1',
      })
    );
  });
});
