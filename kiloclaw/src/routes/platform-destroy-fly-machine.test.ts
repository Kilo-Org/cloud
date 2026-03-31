import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (p: Promise<unknown>) => p,
}));

const testUserId = 'user-1';
const testAppName = 'acct-abc123';
const testMachineId = 'd890abc123';

function makeEnv(overrides: Record<string, unknown> = {}) {
  const forceRetryRecovery = vi.fn().mockResolvedValue(undefined);
  return {
    env: {
      FLY_API_TOKEN: 'fly-test-token',
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ forceRetryRecovery }),
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
    forceRetryRecovery,
  };
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return res.json();
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

describe('POST /destroy-fly-machine', () => {
  let fetchSpy: ReturnType<typeof vi.fn<() => Promise<Response>>>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 })) as ReturnType<
      typeof vi.fn<() => Promise<Response>>
    >;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 and calls Fly API DELETE with force=true', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(200);
    const json = await jsonBody(resp);
    expect(json).toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.machines.dev/v1/apps/${testAppName}/machines/${testMachineId}?force=true`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fly-test-token' },
      }
    );
  });

  it('returns 400 for appName containing URI-special characters, proving the schema is the guard against URL injection', async () => {
    // encodeURIComponent is not needed on the URL construction because the Zod schema
    // never admits any character that would be percent-encoded. This test proves that
    // boundary: a value containing a URI-special character (space, %, +) is rejected
    // at the schema layer and never reaches the Fly API call.
    const { env } = makeEnv();
    for (const badAppName of ['acct abc', 'acct%20abc', 'acct+abc', 'ACCT-ABC']) {
      const { path, init } = postJson('/destroy-fly-machine', {
        userId: testUserId,
        appName: badAppName,
        machineId: testMachineId,
      });
      const resp = await platform.request(path, init, env);
      expect(resp.status).toBe(400);
    }
    // None of the bad inputs reached the Fly API
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for machineId containing URI-special characters, proving the schema is the guard against URL injection', async () => {
    const { env } = makeEnv();
    for (const badMachineId of ['d890 abc', 'd890%abc', 'd890+abc', 'D890ABC']) {
      const { path, init } = postJson('/destroy-fly-machine', {
        userId: testUserId,
        appName: testAppName,
        machineId: badMachineId,
      });
      const resp = await platform.request(path, init, env);
      expect(resp.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('triggers forceRetryRecovery after successful destroy', async () => {
    const { env, forceRetryRecovery } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    await platform.request(path, init, env);

    expect(forceRetryRecovery).toHaveBeenCalled();
  });

  it('returns 503 when FLY_API_TOKEN is not configured', async () => {
    const { env } = makeEnv({ FLY_API_TOKEN: undefined });
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(503);
    const json = await jsonBody(resp);
    expect(json.error).toContain('FLY_API_TOKEN');
  });

  it('wraps Fly API error status and body in error message', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('machine not found', { status: 404 }));
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(404);
    const json = await jsonBody(resp);
    // Implementation wraps the Fly response body: "Fly API error (${status}): ${body}"
    expect(json.error).toBe('Fly API error (404): machine not found');
  });

  it('returns 400 for invalid appName format', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: 'INVALID',
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid machineId format', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: 'BAD-ID!',
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for missing userId', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still returns ok when forceRetryRecovery fails', async () => {
    const forceRetryRecovery = vi.fn().mockRejectedValue(new Error('DO unavailable'));
    const { env } = makeEnv({
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ forceRetryRecovery }),
      },
    });
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(200);
    const json = await jsonBody(resp);
    expect(json).toEqual({ ok: true });
    expect(forceRetryRecovery).toHaveBeenCalled();
  });
});
