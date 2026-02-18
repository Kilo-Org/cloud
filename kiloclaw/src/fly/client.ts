/**
 * Fly.io Machines API client.
 *
 * Thin HTTP wrapper for creating, starting, stopping, and destroying
 * Fly Machines and Volumes. Used by KiloClawInstance DO to manage
 * per-user compute instances.
 *
 * API docs: https://fly.io/docs/machines/api/machines-resource/
 */

import type {
  FlyMachine,
  FlyMachineConfig,
  FlyVolume,
  CreateVolumeRequest,
  CreateMachineRequest,
  FlyWaitableState,
  MachineExecRequest,
  MachineExecResponse,
} from './types';

const FLY_API_BASE = 'https://api.machines.dev';

export type FlyClientConfig = {
  apiToken: string;
  appName: string;
};

/** Structured error from the Fly Machines API. */
export class FlyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = 'FlyApiError';
  }
}

async function flyFetch(
  config: FlyClientConfig,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${FLY_API_BASE}/v1/apps/${config.appName}${path}`;
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  return resp;
}

async function assertOk(resp: Response, context: string): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text();
    throw new FlyApiError(`Fly API ${context} failed (${resp.status}): ${body}`, resp.status, body);
  }
}

// -- Machines --

export async function createMachine(
  config: FlyClientConfig,
  machineConfig: FlyMachineConfig,
  options?: { name?: string; region?: string; skipLaunch?: boolean; minSecretsVersion?: number }
): Promise<FlyMachine> {
  const body: CreateMachineRequest & { min_secrets_version?: number } = {
    config: machineConfig,
    name: options?.name,
    region: options?.region,
    skip_launch: options?.skipLaunch,
    min_secrets_version: options?.minSecretsVersion,
  };
  const resp = await flyFetch(config, '/machines', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await assertOk(resp, 'createMachine');
  return resp.json();
}

export async function getMachine(config: FlyClientConfig, machineId: string): Promise<FlyMachine> {
  const resp = await flyFetch(config, `/machines/${machineId}`);
  await assertOk(resp, 'getMachine');
  return resp.json();
}

export async function startMachine(config: FlyClientConfig, machineId: string): Promise<void> {
  const resp = await flyFetch(config, `/machines/${machineId}/start`, {
    method: 'POST',
  });
  await assertOk(resp, 'startMachine');
}

export async function stopMachine(config: FlyClientConfig, machineId: string): Promise<void> {
  const resp = await flyFetch(config, `/machines/${machineId}/stop`, {
    method: 'POST',
  });
  await assertOk(resp, 'stopMachine');
}

/**
 * Stop a machine and wait for it to reach the 'stopped' state.
 * Fly requires instance_id when waiting for 'stopped', so this fetches
 * the current machine state after issuing the stop to get the instance_id.
 */
export async function stopMachineAndWait(
  config: FlyClientConfig,
  machineId: string,
  timeoutSeconds = 60
): Promise<void> {
  await stopMachine(config, machineId);
  const machine = await getMachine(config, machineId);
  await waitForState(config, machineId, 'stopped', timeoutSeconds, machine.instance_id);
}

export async function destroyMachine(
  config: FlyClientConfig,
  machineId: string,
  force = true
): Promise<void> {
  const resp = await flyFetch(config, `/machines/${machineId}?force=${force}`, {
    method: 'DELETE',
  });
  await assertOk(resp, 'destroyMachine');
}

/**
 * Wait for a machine to reach a specific state.
 * Uses the Fly /wait endpoint which blocks server-side (long-poll).
 *
 * Per the spec (spec.json:1549), only these states are accepted:
 * started, stopped, suspended, destroyed.
 *
 * @param state - One of the waitable states
 * @param timeoutSeconds - Max time to wait (default 60s, Fly max is 300s)
 * @param instanceId - Optional 26-char machine version ID (spec.json:1528).
 *   When set, the wait applies to a specific version of the machine.
 */
export async function waitForState(
  config: FlyClientConfig,
  machineId: string,
  state: FlyWaitableState,
  timeoutSeconds = 60,
  instanceId?: string
): Promise<void> {
  const params = new URLSearchParams({
    state,
    timeout: String(timeoutSeconds),
  });
  if (instanceId) {
    params.set('instance_id', instanceId);
  }
  const resp = await flyFetch(config, `/machines/${machineId}/wait?${params.toString()}`);
  await assertOk(resp, `waitForState(${state})`);
}

/**
 * Update a machine's configuration (e.g., env vars, image).
 * The machine must be stopped first, or this will restart it.
 */
export async function updateMachine(
  config: FlyClientConfig,
  machineId: string,
  machineConfig: FlyMachineConfig,
  options?: { minSecretsVersion?: number }
): Promise<FlyMachine> {
  const body: { config: FlyMachineConfig; min_secrets_version?: number } = {
    config: machineConfig,
    min_secrets_version: options?.minSecretsVersion,
  };
  const resp = await flyFetch(config, `/machines/${machineId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await assertOk(resp, 'updateMachine');
  return resp.json();
}

// -- Volumes --

export async function createVolume(
  config: FlyClientConfig,
  request: CreateVolumeRequest
): Promise<FlyVolume> {
  const resp = await flyFetch(config, '/volumes', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  await assertOk(resp, 'createVolume');
  return resp.json();
}

export async function deleteVolume(config: FlyClientConfig, volumeId: string): Promise<void> {
  const resp = await flyFetch(config, `/volumes/${volumeId}`, {
    method: 'DELETE',
  });
  await assertOk(resp, 'deleteVolume');
}

/**
 * Check if an error is a Fly API 404 (resource not found / already deleted).
 * Used by reconciliation to distinguish "gone" from transient failures.
 */
export function isFlyNotFound(err: unknown): boolean {
  return err instanceof FlyApiError && err.status === 404;
}

/**
 * List machines in the app, optionally filtered by metadata key-value pairs.
 *
 * Metadata filtering (?metadata.{key}=value) is documented in the Fly Machines
 * resource docs: https://fly.io/docs/machines/api/machines-resource/
 * It is absent from the OpenAPI spec file (spec.json:300-331), which only lists
 * include_deleted, region, state, summary. The OpenAPI spec is incomplete here.
 */
export async function listMachines(
  config: FlyClientConfig,
  metadata?: Record<string, string>
): Promise<FlyMachine[]> {
  let path = '/machines';
  if (metadata && Object.keys(metadata).length > 0) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(metadata)) {
      params.set(`metadata.${k}`, v);
    }
    path = `/machines?${params.toString()}`;
  }
  const resp = await flyFetch(config, path);
  await assertOk(resp, 'listMachines');
  return resp.json();
}

export async function getVolume(config: FlyClientConfig, volumeId: string): Promise<FlyVolume> {
  const resp = await flyFetch(config, `/volumes/${volumeId}`);
  await assertOk(resp, 'getVolume');
  return resp.json();
}

// -- Exec --

/**
 * Execute a command on a running machine and return the output.
 * Uses the Fly Machines exec endpoint: POST /apps/{app}/machines/{id}/exec
 */
export async function execCommand(
  config: FlyClientConfig,
  machineId: string,
  command: string[],
  timeout = 10
): Promise<MachineExecResponse> {
  const body: MachineExecRequest = { command, timeout };
  const resp = await flyFetch(config, `/machines/${machineId}/exec`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await assertOk(resp, 'execCommand');
  return resp.json();
}
