import { describe, expect, it, vi } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (p: Promise<unknown>) => p,
}));

/** Minimal env whose DO stub rejects with the given error (simulates RPC boundary). */
function envWithDOError(error: Error) {
  return {
    KILOCLAW_INSTANCE: {
      idFromName: (id: string) => id,
      get: () =>
        new Proxy(
          {},
          {
            get: () => () => Promise.reject(error),
          }
        ),
    },
    KILOCLAW_AE: { writeDataPoint: vi.fn() },
    KV_CLAW_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    },
  } as never;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return res.json();
}

describe('sanitizeError: Instance-not-* status correction', () => {
  it('returns 404 for "Instance not provisioned" with no .status (RPC boundary loss)', async () => {
    // Simulates the DO RPC boundary stripping .status from the error
    const err = new Error('Instance not provisioned');
    const env = envWithDOError(err);

    const resp = await platform.request('/status?userId=user-1', {}, env);

    expect(resp.status).toBe(404);
    const body = await jsonBody(resp);
    expect(body.error).toBe('Instance not provisioned');
  });

  it('does not remap "Instance not running" — only exact "Instance not provisioned" is corrected', async () => {
    const err = new Error('Instance not running');
    const env = envWithDOError(err);

    const resp = await platform.request('/status?userId=user-1', {}, env);

    // "Instance not running" is never thrown by DO lifecycle code; only
    // "Instance not provisioned" (status 404) crosses the RPC boundary.
    // Other "Instance not *" messages keep whatever status they have (500 if lost).
    expect(resp.status).toBe(500);
    const body = await jsonBody(resp);
    expect(body.error).toBe('Instance not running');
  });

  it('preserves original status when .status is present (not lost across RPC)', async () => {
    const err = Object.assign(new Error('Instance not provisioned'), { status: 409 });
    const env = envWithDOError(err);

    const resp = await platform.request('/status?userId=user-1', {}, env);

    expect(resp.status).toBe(409);
    const body = await jsonBody(resp);
    expect(body.error).toBe('Instance not provisioned');
  });

  it('does not override status for non-"Instance not" safe errors', async () => {
    // "Instance is not running" uses a different prefix — should stay 500
    const err = new Error('Instance is not running');
    const env = envWithDOError(err);

    const resp = await platform.request('/status?userId=user-1', {}, env);

    expect(resp.status).toBe(500);
    const body = await jsonBody(resp);
    expect(body.error).toBe('Instance is not running');
  });

  it('returns 500 for unknown errors (not safe-listed)', async () => {
    const err = new Error('Something unexpected');
    const env = envWithDOError(err);

    const resp = await platform.request('/status?userId=user-1', {}, env);

    expect(resp.status).toBe(500);
    const body = await jsonBody(resp);
    expect(body.error).toBe('status failed');
  });
});
