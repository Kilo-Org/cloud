import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KiloClawEnv } from '../types';
import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import {
  cancelKiloCliRun,
  startKiloCliRun,
} from '../durable-objects/kiloclaw-instance/kilo-cli-run';
import { platform } from './platform';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (p: Promise<unknown>) => p,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** Minimal env whose DO stub rejects with the given error (simulates RPC boundary). */
function envWithDOError(error: Error, writeDataPoint = vi.fn()) {
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
    KILOCLAW_AE: { writeDataPoint },
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

type ControllerTestState = Pick<
  InstanceMutableState,
  | 'status'
  | 'sandboxId'
  | 'provider'
  | 'providerState'
  | 'flyAppName'
  | 'flyMachineId'
  | 'flyVolumeId'
  | 'flyRegion'
>;

type ControllerTestEnv = Pick<KiloClawEnv, 'GATEWAY_TOKEN_SECRET' | 'FLY_APP_NAME' | 'WORKER_ENV'>;

function runningFlyState(): ControllerTestState {
  return {
    status: 'running',
    sandboxId: 'sandbox-1',
    provider: 'fly',
    flyAppName: 'app-1',
    flyMachineId: 'machine-1',
    flyVolumeId: 'volume-1',
    flyRegion: 'iad',
    providerState: {
      provider: 'fly',
      machineId: 'machine-1',
      appName: 'app-1',
      volumeId: 'volume-1',
      region: 'iad',
    },
  };
}

function controllerEnv(): ControllerTestEnv {
  return {
    GATEWAY_TOKEN_SECRET: 'test-gateway-token-secret',
    FLY_APP_NAME: 'app-1',
    WORKER_ENV: 'development',
  };
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
    // "Instance is not running" thrown by DO lifecycle methods (not CLI cancel) stays 500
    // because only "Instance not provisioned" has a correctLostStatus entry.
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

  it('logs the full provision error object while returning a sanitized response', async () => {
    const err = new Error('Fly API allocateIP failed (500): <!DOCTYPE html><html>upstream</html>');
    const writeDataPoint = vi.fn();
    const env = envWithDOError(err, writeDataPoint);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resp = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(resp.status).toBe(500);
    const body = await jsonBody(resp);
    expect(body.error).toBe('provision failed');
    expect(consoleSpy).toHaveBeenCalledWith('[platform] provision failed:', err);
    const provisioningFailureCall = writeDataPoint.mock.calls.find(call =>
      JSON.stringify(call[0]).includes('instance.provisioning_failed')
    );
    expect(provisioningFailureCall).toBeDefined();
    expect(provisioningFailureCall?.[0]).toMatchObject({
      indexes: ['instance.provisioning_failed'],
    });
    const serializedDataPoint = JSON.stringify(provisioningFailureCall?.[0]);
    expect(serializedDataPoint).toContain('fly_api_allocateIP_500');
    expect(serializedDataPoint).toContain('provision failed');
    expect(serializedDataPoint).not.toContain('<!DOCTYPE html>');
    expect(serializedDataPoint).not.toContain('upstream</html>');
  });
});

describe('kilo-cli-run/start: conflict response handling', () => {
  function envWithStartRun(startRun: () => Promise<unknown>) {
    return {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ startKiloCliRun: startRun }),
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

  it('returns 409 when the DO-level start helper converts a controller 409 to conflict', async () => {
    const state = runningFlyState();
    const envForController = controllerEnv();
    const startRun = () =>
      startKiloCliRun(
        state as InstanceMutableState,
        envForController as KiloClawEnv,
        'fix this'
      ).then(response => response);
    const env = envWithStartRun(startRun);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'kilo_cli_run_already_active',
          error: 'A Kilo CLI run is already in progress',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const resp = await platform.request(
      '/kilo-cli-run/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', prompt: 'fix this' }),
      },
      env
    );

    expect(resp.status).toBe(409);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({
      code: 'kilo_cli_run_already_active',
      error: 'A Kilo CLI run is already in progress',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://app-1.fly.dev/_kilo/cli-run/start',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ prompt: 'fix this' }) })
    );
  });

  it('returns 502 when the DO returns a malformed start conflict', async () => {
    const env = envWithStartRun(() => Promise.resolve({ conflict: { error: 'Conflict' } }));

    const resp = await platform.request(
      '/kilo-cli-run/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', prompt: 'fix this' }),
      },
      env
    );

    expect(resp.status).toBe(502);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({
      code: 'upstream_invalid_response',
      error: 'Invalid Kilo CLI conflict response',
    });
  });
});

describe('kilo-cli-run/cancel: conflict response handling', () => {
  function envWithCancelRun(cancelRun: () => Promise<unknown>) {
    return {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ cancelKiloCliRun: cancelRun }),
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

  it('returns 409 when the DO-level cancel helper converts a controller 409 to conflict', async () => {
    const state = runningFlyState();
    const envForController = controllerEnv();
    const cancelRun = () =>
      cancelKiloCliRun(state as InstanceMutableState, envForController as KiloClawEnv).then(
        response => response
      );
    const env = envWithCancelRun(cancelRun);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'kilo_cli_run_no_active_run',
          error: 'No active run to cancel',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const resp = await platform.request(
      '/kilo-cli-run/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(resp.status).toBe(409);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({
      code: 'kilo_cli_run_no_active_run',
      error: 'No active run to cancel',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://app-1.fly.dev/_kilo/cli-run/cancel',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns 502 when the DO returns a malformed cancel conflict', async () => {
    const env = envWithCancelRun(() => Promise.resolve({ conflict: { error: 'Conflict' } }));

    const resp = await platform.request(
      '/kilo-cli-run/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(resp.status).toBe(502);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({
      code: 'upstream_invalid_response',
      error: 'Invalid Kilo CLI conflict response',
    });
  });
});

describe('sanitizeError: explicit provider support errors', () => {
  it('returns 501 for unsupported providers on provision instead of a generic 500', async () => {
    const provision = vi.fn();
    const env = {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ provision }),
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

    const resp = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'northflank',
        }),
      },
      env
    );

    expect(resp.status).toBe(501);
    expect(await jsonBody(resp)).toEqual({
      error: 'Provider northflank is not implemented yet',
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('returns 400 for docker-local outside development', async () => {
    const provision = vi.fn();
    const env = {
      WORKER_ENV: 'production',
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ provision }),
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

    const resp = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          provider: 'docker-local',
        }),
      },
      env
    );

    expect(resp.status).toBe(400);
    expect(await jsonBody(resp)).toEqual({
      error: 'Provider docker-local is only available in development',
    });
    expect(provision).not.toHaveBeenCalled();
  });
});

describe('openclaw import platform route', () => {
  function envWithImportOpenclawWorkspace(
    importOpenclawWorkspace: (files: Array<{ path: string; content: string }>) => Promise<unknown>,
    getStatus: () => Promise<{ status: string }> | { status: string } = async () => ({
      status: 'running',
    })
  ) {
    return {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ importOpenclawWorkspace, getStatus }),
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

  it('returns 400 for malformed body', async () => {
    const env = envWithImportOpenclawWorkspace(async () => ({ ok: true }));

    const resp = await platform.request(
      '/files/import-openclaw-workspace',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', files: [{ path: 123, content: true }] }),
      },
      env
    );

    expect(resp.status).toBe(400);
    await expect(jsonBody(resp)).resolves.toEqual(
      expect.objectContaining({ error: 'Invalid request' })
    );
  });

  it('returns 400 when files exceeds max count', async () => {
    const importOpenclawWorkspace = vi.fn().mockResolvedValue({ ok: true });
    const env = envWithImportOpenclawWorkspace(importOpenclawWorkspace);

    const files = Array.from({ length: 501 }, (_, idx) => ({
      path: `workspace/memory/note-${idx}.md`,
      content: '# note',
    }));

    const resp = await platform.request(
      '/files/import-openclaw-workspace',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', files }),
      },
      env
    );

    expect(resp.status).toBe(400);
    await expect(jsonBody(resp)).resolves.toEqual(
      expect.objectContaining({ error: 'Invalid request' })
    );
    expect(importOpenclawWorkspace).not.toHaveBeenCalled();
  });

  it('forwards import payload to DO and returns the response', async () => {
    const importOpenclawWorkspace = vi.fn().mockResolvedValue({
      ok: true,
      attemptedWriteCount: 2,
      writtenCount: 2,
      attemptedDeleteCount: 0,
      deletedCount: 0,
      failedCount: 0,
      totalUtf8Bytes: 42,
      failures: [],
    });

    const env = envWithImportOpenclawWorkspace(importOpenclawWorkspace);

    const resp = await platform.request(
      '/files/import-openclaw-workspace?instanceId=11111111-1111-4111-8111-111111111111',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          files: [
            { path: 'workspace/USER.md', content: '# User' },
            { path: 'workspace/MEMORY.md', content: '# Memory' },
          ],
        }),
      },
      env
    );

    expect(resp.status).toBe(200);
    await expect(jsonBody(resp)).resolves.toEqual({
      ok: true,
      attemptedWriteCount: 2,
      writtenCount: 2,
      attemptedDeleteCount: 0,
      deletedCount: 0,
      failedCount: 0,
      totalUtf8Bytes: 42,
      failures: [],
    });
    expect(importOpenclawWorkspace).toHaveBeenCalledWith([
      { path: 'workspace/USER.md', content: '# User' },
      { path: 'workspace/MEMORY.md', content: '# Memory' },
    ]);
  });

  it('returns 404 controller_route_unavailable when DO returns null', async () => {
    const env = envWithImportOpenclawWorkspace(async () => null);

    const resp = await platform.request(
      '/files/import-openclaw-workspace',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          files: [{ path: 'workspace/USER.md', content: '# User' }],
        }),
      },
      env
    );

    expect(resp.status).toBe(404);
    await expect(jsonBody(resp)).resolves.toEqual({
      error: 'OpenClaw import not available (controller too old)',
      code: 'controller_route_unavailable',
    });
  });

  it('returns 503 when instance is not running', async () => {
    const importOpenclawWorkspace = vi.fn().mockResolvedValue({ ok: true });
    const env = envWithImportOpenclawWorkspace(importOpenclawWorkspace, async () => ({
      status: 'stopped',
    }));

    const resp = await platform.request(
      '/files/import-openclaw-workspace',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          files: [{ path: 'workspace/USER.md', content: '# User' }],
        }),
      },
      env
    );

    expect(resp.status).toBe(503);
    await expect(jsonBody(resp)).resolves.toEqual({
      error: 'Instance is not running',
      code: 'instance_not_running',
    });
    expect(importOpenclawWorkspace).not.toHaveBeenCalled();
  });

  it('passes through sanitized openclaw import error code', async () => {
    const upstream = Object.assign(new Error('Import exceeds byte limit'), {
      status: 400,
      code: 'openclaw_import_too_large',
    });
    const env = envWithImportOpenclawWorkspace(async () => {
      throw upstream;
    });

    const resp = await platform.request(
      '/files/import-openclaw-workspace',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          files: [{ path: 'workspace/USER.md', content: '# User' }],
        }),
      },
      env
    );

    expect(resp.status).toBe(400);
    await expect(jsonBody(resp)).resolves.toEqual({
      error: 'Import exceeds byte limit',
      code: 'openclaw_import_too_large',
    });
  });
});
