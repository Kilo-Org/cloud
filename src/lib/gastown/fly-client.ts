import 'server-only';

/**
 * Fly.io Machines API client for Gastown sandbox provisioning.
 * Modeled on kiloclaw/src/fly/client.ts but adapted for direct
 * use from the Next.js backend (server-only).
 */

const FLY_API_BASE = 'https://api.machines.dev';

export type GastownFlyConfig = {
  apiToken: string;
  appName: string;
};

class FlyApiError extends Error {
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
  config: GastownFlyConfig,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const url = `${FLY_API_BASE}/v1/apps/${config.appName}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

async function assertOk(resp: Response, context: string): Promise<void> {
  if (!resp.ok) {
    const body = await resp.text();
    throw new FlyApiError(`Fly API ${context} failed (${resp.status}): ${body}`, resp.status, body);
  }
}

// -- Types (subset of Fly API types needed for Gastown) --

type FlyMachineGuest = {
  cpus: number;
  memory_mb: number;
  cpu_kind?: 'shared' | 'performance';
};

type FlyMachineMount = {
  volume: string;
  path: string;
};

type FlyMachineService = {
  ports: { port: number; handlers?: string[] }[];
  internal_port: number;
  protocol: 'tcp' | 'udp';
};

type FlyMachineConfig = {
  image: string;
  env?: Record<string, string>;
  guest?: FlyMachineGuest;
  services?: FlyMachineService[];
  mounts?: FlyMachineMount[];
  metadata?: Record<string, string>;
  auto_destroy?: boolean;
};

type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region: string;
  config: FlyMachineConfig;
  created_at: string;
  updated_at: string;
};

type FlyVolume = {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
};

type CreateVolumeRequest = {
  name: string;
  region: string;
  size_gb: number;
};

// -- Volume operations --

export async function createVolume(
  config: GastownFlyConfig,
  request: CreateVolumeRequest
): Promise<FlyVolume> {
  const resp = await flyFetch(config, '/volumes', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  await assertOk(resp, 'createVolume');
  return resp.json();
}

export async function deleteVolume(config: GastownFlyConfig, volumeId: string): Promise<void> {
  const resp = await flyFetch(config, `/volumes/${volumeId}`, { method: 'DELETE' });
  await assertOk(resp, 'deleteVolume');
}

// -- Machine operations --

export async function createMachine(
  config: GastownFlyConfig,
  machineConfig: FlyMachineConfig,
  options?: { name?: string; region?: string }
): Promise<FlyMachine> {
  const body = {
    config: machineConfig,
    name: options?.name,
    region: options?.region,
  };
  const resp = await flyFetch(config, '/machines', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await assertOk(resp, 'createMachine');
  return resp.json();
}

export async function startMachine(config: GastownFlyConfig, machineId: string): Promise<void> {
  const resp = await flyFetch(config, `/machines/${machineId}/start`, { method: 'POST' });
  await assertOk(resp, 'startMachine');
}

export async function stopMachine(config: GastownFlyConfig, machineId: string): Promise<void> {
  const resp = await flyFetch(config, `/machines/${machineId}/stop`, { method: 'POST' });
  await assertOk(resp, 'stopMachine');
}

export async function destroyMachine(
  config: GastownFlyConfig,
  machineId: string,
  force = true
): Promise<void> {
  const resp = await flyFetch(config, `/machines/${machineId}?force=${force}`, {
    method: 'DELETE',
  });
  await assertOk(resp, 'destroyMachine');
}

export function isFlyNotFound(err: unknown): boolean {
  return err instanceof FlyApiError && err.status === 404;
}
