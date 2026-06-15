import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KiloClawEnv } from '../types';
import * as DbModule from '../db';
import type { InstanceMutableState } from '../durable-objects/kiloclaw-instance/types';
import {
  cancelDoctorViaController,
  getDoctorViaControllerStatus,
  startDoctorViaController,
} from '../durable-objects/kiloclaw-instance/doctor-run';
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
    HYPERDRIVE: { connectionString: 'postgresql://fake' },
    KILOCLAW_REGISTRY: {
      idFromName: (id: string) => id,
      get: () => ({ repairCompletedProvision: vi.fn().mockResolvedValue(false) }),
    },
    KILOCLAW_BILLING: {
      resolveProvisionEntitlement: vi.fn().mockResolvedValue({
        priceVersion: '2026-05-10',
        selfServiceInstanceType: 'perf-1-3',
      }),
    },
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
    vi.spyOn(DbModule, 'getWorkerDb').mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: '11111111-1111-4111-8111-111111111111',
                    sandbox_id: 'ki_11111111111141118111111111111111',
                    organization_id: null,
                  },
                ]),
            }),
            limit: () => Promise.resolve([{ id: 'subscription-1' }]),
          }),
        }),
      }),
    } as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resp = await platform.request(
      '/provision',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          instanceId: '11111111-1111-4111-8111-111111111111',
        }),
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

describe('sanitizeOpenclawConfigError: file tree RPC limit', () => {
  it('returns a stable code and bounded message for oversized file trees', async () => {
    const err = new Error(
      'Serialized RPC arguments or return values are limited to 32MiB, but the size of this value was: 37110765 bytes.'
    );
    const env = envWithDOError(err);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resp = await platform.request('/files/tree?userId=user-1', {}, env);

    expect(resp.status).toBe(413);
    await expect(jsonBody(resp)).resolves.toEqual({
      code: 'file_tree_too_large',
      error:
        'File tree is too large to load through the Cloudflare RPC limit (32 MiB; returned 37110765 bytes).',
    });
    expect(consoleSpy).toHaveBeenCalledWith('[platform] files/tree failed:', err.message);
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

describe('doctor-controller: response handling', () => {
  function envWithDoctorStub(stub: Record<string, () => Promise<unknown>>) {
    return {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => stub,
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

  it('returns 200 when the controller doctor start succeeds', async () => {
    const env = envWithDoctorStub({
      startDoctorViaController: () =>
        Promise.resolve({
          ok: true,
          runId: 'run-1',
          startedAt: '2026-05-08T00:00:00.000Z',
        }),
    });

    const resp = await platform.request(
      '/doctor-controller/start?instanceId=11111111-1111-4111-8111-111111111111',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', fix: false }),
      },
      env
    );

    expect(resp.status).toBe(200);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({ ok: true, runId: 'run-1' });
  });

  it('returns 200 when fetching controller doctor status succeeds', async () => {
    const env = envWithDoctorStub({
      getDoctorViaControllerStatus: () =>
        Promise.resolve({
          hasRun: true,
          runId: 'run-1',
          status: 'completed',
          fix: false,
          output: 'doctor output',
          outputBytes: 13,
          outputTruncated: false,
          exitCode: 0,
          startedAt: '2026-05-08T00:00:00.000Z',
          completedAt: '2026-05-08T00:00:01.000Z',
          timedOut: false,
        }),
    });

    const resp = await platform.request(
      '/doctor-controller/status?userId=user-1&instanceId=11111111-1111-4111-8111-111111111111',
      {},
      env
    );

    expect(resp.status).toBe(200);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({
      hasRun: true,
      runId: 'run-1',
      status: 'completed',
      output: 'doctor output',
    });
  });

  it('returns 200 when cancelling controller doctor succeeds', async () => {
    const env = envWithDoctorStub({
      cancelDoctorViaController: () => Promise.resolve({ ok: true }),
    });

    const resp = await platform.request(
      '/doctor-controller/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(resp.status).toBe(200);
    expect(await jsonBody(resp)).toMatchObject({ ok: true });
  });

  it('returns 404 when the controller route is unavailable', async () => {
    const env = envWithDoctorStub({ startDoctorViaController: () => Promise.resolve(null) });

    const resp = await platform.request(
      '/doctor-controller/start',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(resp.status).toBe(404);
    const body = await jsonBody(resp);
    expect(body).toMatchObject({
      code: 'controller_route_unavailable',
      error: 'Doctor runner not available (controller too old)',
    });
  });

  it('returns 409 when the DO helper converts not-running into a conflict', async () => {
    const state = { ...runningFlyState(), status: 'stopped' };
    const envForController = controllerEnv();
    const env = envWithDoctorStub({
      startDoctorViaController: () =>
        startDoctorViaController(
          state as InstanceMutableState,
          envForController as KiloClawEnv,
          true
        ).then(response => response),
    });

    const resp = await platform.request(
      '/doctor-controller/start',
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
      code: 'openclaw_doctor_instance_not_running',
      error: 'Instance is not running',
    });
  });

  it('returns 409 when the controller reports a doctor run is already active', async () => {
    const state = runningFlyState();
    const envForController = controllerEnv();
    const env = envWithDoctorStub({
      startDoctorViaController: () =>
        startDoctorViaController(
          state as InstanceMutableState,
          envForController as KiloClawEnv,
          true
        ).then(response => response),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'openclaw_doctor_already_active',
          error: 'An openclaw doctor run is already in progress',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const resp = await platform.request(
      '/doctor-controller/start',
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
      code: 'openclaw_doctor_already_active',
      error: 'An openclaw doctor run is already in progress',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://app-1.fly.dev/_kilo/doctor/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ fix: true }),
      })
    );
  });

  it('returns 409 when the controller reports no active run to cancel', async () => {
    const state = runningFlyState();
    const envForController = controllerEnv();
    const env = envWithDoctorStub({
      cancelDoctorViaController: () =>
        cancelDoctorViaController(
          state as InstanceMutableState,
          envForController as KiloClawEnv
        ).then(response => response),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'openclaw_doctor_no_active_run',
          error: 'No active doctor run to cancel',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const resp = await platform.request(
      '/doctor-controller/cancel',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1' }),
      },
      env
    );

    expect(resp.status).toBe(409);
    expect(await jsonBody(resp)).toMatchObject({
      code: 'openclaw_doctor_no_active_run',
      error: 'No active doctor run to cancel',
    });
  });

  it('calls the controller status endpoint through the DO helper', async () => {
    const state = runningFlyState();
    const envForController = controllerEnv();
    const env = envWithDoctorStub({
      getDoctorViaControllerStatus: () =>
        getDoctorViaControllerStatus(
          state as InstanceMutableState,
          envForController as KiloClawEnv
        ).then(response => response),
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          hasRun: false,
          runId: null,
          status: null,
          fix: null,
          output: null,
          outputBytes: 0,
          outputTruncated: false,
          exitCode: null,
          startedAt: null,
          completedAt: null,
          timedOut: false,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    );

    const resp = await platform.request('/doctor-controller/status?userId=user-1', {}, env);

    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://app-1.fly.dev/_kilo/doctor/status',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('returns 502 when the DO returns a malformed doctor conflict', async () => {
    const env = envWithDoctorStub({
      startDoctorViaController: () => Promise.resolve({ conflict: { error: 'Conflict' } }),
    });

    const resp = await platform.request(
      '/doctor-controller/start',
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
      error: 'Invalid doctor conflict response',
    });
  });
});

describe('doctor-controller: legacy route removed', () => {
  it('does not serve the old synchronous doctor-controller route', async () => {
    const env = envWithDOError(new Error('should not be called'));

    const resp = await platform.request(
      '/doctor-controller',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'user-1', fix: false }),
      },
      env
    );

    expect(resp.status).toBe(404);
  });
});

describe('sanitizeError: explicit provider support errors', () => {
  it('returns 503 for unconfigured Northflank on provision instead of a generic 500', async () => {
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

    expect(resp.status).toBe(503);
    const body = await jsonBody(resp);
    const errorMessage = body.error;
    if (typeof errorMessage !== 'string') {
      throw new Error('expected string error message in response body');
    }
    expect(errorMessage).toMatch(/^Provider northflank is not configured; missing /);
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

describe('validation-aware config write platform route', () => {
  function envWithWriteOpenclawConfigFile(
    writeOpenclawConfigFile: (...args: unknown[]) => Promise<unknown>
  ) {
    return {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ writeOpenclawConfigFile }),
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

  it('forwards opt-in validation mode and warning responses', async () => {
    const writeOpenclawConfigFile = vi.fn().mockResolvedValue({
      outcome: 'openclaw-validation-warning',
      valid: false,
      reason: 'invalid',
      issues: [{ path: 'gateway.mode', message: 'Expected local' }],
    });
    const env = envWithWriteOpenclawConfigFile(writeOpenclawConfigFile);

    const resp = await platform.request(
      '/files/write-openclaw-config?instanceId=11111111-1111-4111-8111-111111111111',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          content: '{"gateway":{"mode":"remote"}}',
          etag: 'etag-1',
          mode: 'warn-before-write',
        }),
      },
      env
    );

    expect(resp.status).toBe(200);
    await expect(jsonBody(resp)).resolves.toMatchObject({
      outcome: 'openclaw-validation-warning',
      reason: 'invalid',
    });
    expect(writeOpenclawConfigFile).toHaveBeenCalledWith(
      '{"gateway":{"mode":"remote"}}',
      'etag-1',
      'warn-before-write'
    );
  });

  it('fails closed when the running controller lacks the dedicated route', async () => {
    const env = envWithWriteOpenclawConfigFile(async () => null);
    const resp = await platform.request(
      '/files/write-openclaw-config',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 'user-1',
          content: '{"gateway":{"mode":"remote"}}',
          etag: 'etag-1',
          mode: 'warn-before-write',
        }),
      },
      env
    );

    expect(resp.status).toBe(404);
    await expect(jsonBody(resp)).resolves.toEqual({
      error: 'OpenClaw validation-aware writing not available (controller too old)',
      code: 'controller_route_unavailable',
    });
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
