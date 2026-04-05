import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {},
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
