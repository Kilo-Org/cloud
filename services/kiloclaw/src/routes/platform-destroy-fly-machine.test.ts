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
  const getProviderMetadata = vi.fn().mockResolvedValue({
    provider: 'fly',
    capabilities: {
      volumeSnapshots: true,
      candidateVolumes: true,
      volumeReassociation: true,
      snapshotRestore: true,
      directMachineDestroy: true,
    },
  });
  return {
    env: {
      FLY_API_TOKEN: 'fly-test-token',
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ forceRetryRecovery, getProviderMetadata }),
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
    getProviderMetadata,
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

let loggedValues: unknown[] = [];

function findJsonLog(message: string): Record<string, unknown> | undefined {
  return loggedValues
    .filter((value: unknown): value is string => typeof value === 'string' && value.startsWith('{'))
    .map((value: string) => JSON.parse(value) as Record<string, unknown>)
    .find((record: Record<string, unknown>) => record.message === message);
}

describe('POST /destroy-fly-machine', () => {
  let fetchSpy: ReturnType<typeof vi.fn<() => Promise<Response>>>;

  beforeEach(() => {
    loggedValues = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      loggedValues.push(value);
    });
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

  it('logs billing-correlated platform requests with propagated context', async () => {
    const { env } = makeEnv();
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });
    const headers = new Headers(init.headers as Record<string, string>);
    headers.set('x-kiloclaw-billing-run-id', '11111111-1111-4111-8111-111111111111');
    headers.set('x-kiloclaw-billing-sweep', 'instance_destruction');
    headers.set('x-kiloclaw-billing-call-id', '22222222-2222-4222-8222-222222222222');
    headers.set('x-kiloclaw-billing-attempt', '2');

    const resp = await platform.request(
      path,
      {
        ...init,
        headers,
      },
      env
    );

    expect(resp.status).toBe(200);
    expect(findJsonLog('Starting billing-correlated kiloclaw platform request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        billingSweep: 'instance_destruction',
        billingCallId: '22222222-2222-4222-8222-222222222222',
        billingAttempt: 2,
        billingComponent: 'kiloclaw_platform',
        event: 'downstream_action',
        outcome: 'started',
        method: 'POST',
        path: '/destroy-fly-machine',
      })
    );
    expect(findJsonLog('Finished billing-correlated kiloclaw platform request')).toEqual(
      expect.objectContaining({
        billingFlow: 'kiloclaw_lifecycle',
        billingRunId: '11111111-1111-4111-8111-111111111111',
        billingSweep: 'instance_destruction',
        billingCallId: '22222222-2222-4222-8222-222222222222',
        billingAttempt: 2,
        billingComponent: 'kiloclaw_platform',
        event: 'downstream_action',
        outcome: 'completed',
        method: 'POST',
        path: '/destroy-fly-machine',
        statusCode: 200,
        userId: testUserId,
      })
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

  it('returns 400 when direct machine destroy is unsupported for the active provider', async () => {
    const { env, getProviderMetadata } = makeEnv();
    getProviderMetadata.mockResolvedValueOnce({
      provider: 'northflank',
      capabilities: {
        volumeSnapshots: false,
        candidateVolumes: false,
        volumeReassociation: false,
        snapshotRestore: false,
        directMachineDestroy: false,
      },
    });
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });

    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(400);
    expect(await jsonBody(resp)).toEqual({
      error: 'destroy-fly-machine is not supported for provider northflank',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still calls the Fly API when provider metadata lookup fails', async () => {
    const { env, getProviderMetadata } = makeEnv();
    getProviderMetadata.mockRejectedValueOnce(new Error('DO unavailable'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { path, init } = postJson('/destroy-fly-machine', {
      userId: testUserId,
      appName: testAppName,
      machineId: testMachineId,
    });

    const resp = await platform.request(path, init, env);

    expect(resp.status).toBe(200);
    expect(await jsonBody(resp)).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.machines.dev/v1/apps/${testAppName}/machines/${testMachineId}?force=true`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer fly-test-token' },
      }
    );
    expect(warnSpy).toHaveBeenCalled();
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
    const getProviderMetadata = vi.fn().mockResolvedValue({
      provider: 'fly',
      capabilities: {
        volumeSnapshots: true,
        candidateVolumes: true,
        volumeReassociation: true,
        snapshotRestore: true,
        directMachineDestroy: true,
      },
    });
    const { env } = makeEnv({
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ forceRetryRecovery, getProviderMetadata }),
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
