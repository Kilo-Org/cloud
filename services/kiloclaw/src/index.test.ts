import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {},
}));

vi.mock('./routes', async () => {
  const { Hono } = await import('hono');
  const empty = new Hono();
  return {
    accessGatewayRoutes: empty,
    publicRoutes: empty,
    api: empty,
    kiloclaw: empty,
    platform: empty,
    controller: empty,
  };
});

vi.mock('./auth', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', 'user-1');
    await next();
  },
  internalApiMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./middleware/analytics', () => ({
  timingMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./lib/image-version', async () => {
  const actual = await vi.importActual('./lib/image-version');
  return {
    ...actual,
    registerVersionIfNeeded: vi.fn().mockResolvedValue(undefined),
  };
});

import worker from './index';

describe('platform route env validation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rejects platform routes when NEXTAUTH_SECRET is missing', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/api/platform/provision', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': 'secret-123',
        },
        body: JSON.stringify({ userId: 'user-1' }),
      }),
      {
        INTERNAL_API_SECRET: 'secret-123',
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Configuration error' });
    expect(console.error).toHaveBeenCalledWith(
      '[CONFIG] Platform route missing bindings:',
      'NEXTAUTH_SECRET'
    );
  });
});

describe('proxy recovering state', () => {
  it('returns 409 while the instance is recovering', async () => {
    const registryStub = {
      listInstances: vi.fn().mockResolvedValue([
        {
          doKey: 'user-1',
          instanceId: '',
          assignedUserId: 'user-1',
          createdAt: new Date().toISOString(),
          destroyedAt: null,
        },
      ]),
    };
    const instanceStub = {
      getStatus: vi.fn().mockResolvedValue({
        userId: 'user-1',
        sandboxId: 'sandbox-1',
        status: 'recovering',
        flyMachineId: 'machine-1',
        flyAppName: 'test-app',
      }),
    };

    const response = await worker.fetch(
      new Request('https://example.com/'),
      {
        NEXTAUTH_SECRET: 'nextauth-secret',
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_API_TOKEN: 'fly-token',
        FLY_APP_NAME: 'test-app',
        KILOCLAW_REGISTRY: {
          idFromName: vi.fn().mockReturnValue('registry-id'),
          get: vi.fn().mockReturnValue(registryStub),
        },
        KILOCLAW_INSTANCE: {
          idFromName: vi.fn().mockReturnValue('instance-id'),
          get: vi.fn().mockReturnValue(instanceStub),
        },
      } as never,
      { waitUntil: vi.fn() } as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Instance is recovering',
      hint: 'Your instance is being recovered after an unexpected stop. Please wait.',
    });
  });
});
