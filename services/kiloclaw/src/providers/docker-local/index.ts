import type { DockerLocalProviderState } from '../../schemas/instance-config';
import type { InstanceProviderAdapter, ProviderResult } from '../types';
import { getDockerLocalProviderState } from '../../durable-objects/kiloclaw-instance/state';
import type { KiloClawEnv } from '../../types';
import type { RuntimeSpec } from '../types';
import type { InstanceMutableState } from '../../durable-objects/kiloclaw-instance/types';

const DEFAULT_PORT_RANGE = '45000-45999';

type DockerApiError = Error & { status: number };

type DockerContainerSummary = {
  Id?: string;
  Names?: string[];
  Ports?: Array<{ PublicPort?: number }>;
};

type DockerContainerInspect = {
  Id: string;
  Name: string;
  State?: {
    Running?: boolean;
    Status?: string;
  };
};

type DockerHostConfig = {
  Binds: string[];
  PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  RestartPolicy: {
    Name: 'no';
  };
  Memory?: number;
  NanoCpus?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDockerContainerInspect(value: unknown): value is DockerContainerInspect {
  if (!isRecord(value)) return false;

  const state = value.State;
  if (state !== undefined && !isRecord(state)) return false;

  return typeof value.Id === 'string' && typeof value.Name === 'string';
}

function isDockerContainerSummaryArray(value: unknown): value is DockerContainerSummary[] {
  if (!Array.isArray(value)) return false;

  return value.every(item => {
    if (!isRecord(item)) return false;
    if ('Id' in item && item.Id !== undefined && typeof item.Id !== 'string') return false;

    const names = item.Names;
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some(name => typeof name !== 'string'))
    ) {
      return false;
    }

    const ports = item.Ports;
    if (
      ports !== undefined &&
      (!Array.isArray(ports) ||
        ports.some(
          port =>
            !isRecord(port) ||
            ('PublicPort' in port &&
              port.PublicPort !== undefined &&
              typeof port.PublicPort !== 'number')
        ))
    ) {
      return false;
    }

    return true;
  });
}

function dockerConfigError(message: string, status = 503): DockerApiError {
  return Object.assign(new Error(message), { status });
}

function ensureDockerLocalConfigured(env: KiloClawEnv): string {
  if (env.WORKER_ENV !== 'development') {
    throw dockerConfigError('Provider docker-local is only available in development', 400);
  }
  if (!env.DOCKER_LOCAL_API_BASE) {
    throw dockerConfigError('Provider docker-local is not configured for local Docker API');
  }
  return env.DOCKER_LOCAL_API_BASE;
}

async function dockerFetch(env: KiloClawEnv, path: string, init?: RequestInit): Promise<Response> {
  const base = ensureDockerLocalConfigured(env);
  const url = `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  try {
    return await fetch(url, {
      ...init,
      headers,
    });
  } catch (error) {
    throw dockerConfigError(
      `Provider docker-local cannot reach Docker API at ${base}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function dockerRequest(
  env: KiloClawEnv,
  path: string,
  init?: RequestInit,
  expectedStatus: number[] = [200]
): Promise<Response> {
  const response = await dockerFetch(env, path, init);
  if (!expectedStatus.includes(response.status)) {
    const body = await response.text().catch(() => '');
    throw dockerConfigError(
      `Provider docker-local Docker API request failed: ${response.status}${body ? ` ${body}` : ''}`,
      response.status
    );
  }
  return response;
}

async function pingDocker(env: KiloClawEnv): Promise<void> {
  await dockerRequest(env, '/_ping', undefined, [200]);
}

function buildContainerName(state: Pick<InstanceMutableState, 'sandboxId'>): string {
  if (!state.sandboxId) {
    throw dockerConfigError('Provider docker-local requires a sandboxId');
  }
  return `kiloclaw-${state.sandboxId}`;
}

function buildVolumeName(state: Pick<InstanceMutableState, 'sandboxId'>): string {
  if (!state.sandboxId) {
    throw dockerConfigError('Provider docker-local requires a sandboxId');
  }
  return `kiloclaw-root-${state.sandboxId}`;
}

function parsePortRange(env: KiloClawEnv): { start: number; end: number } {
  const raw = env.DOCKER_LOCAL_PORT_RANGE ?? DEFAULT_PORT_RANGE;
  const match = /^(\d+)-(\d+)$/.exec(raw);
  if (!match) {
    throw dockerConfigError('Provider docker-local has invalid DOCKER_LOCAL_PORT_RANGE');
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    throw dockerConfigError('Provider docker-local has invalid DOCKER_LOCAL_PORT_RANGE');
  }
  return { start, end };
}

async function inspectVolume(env: KiloClawEnv, name: string): Promise<boolean> {
  const response = await dockerFetch(env, `/volumes/${encodeURIComponent(name)}`, {
    method: 'GET',
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw dockerConfigError(
      `Provider docker-local Docker API request failed: ${response.status}${body ? ` ${body}` : ''}`,
      response.status
    );
  }
  return true;
}

async function ensureVolume(env: KiloClawEnv, name: string): Promise<void> {
  if (await inspectVolume(env, name)) return;
  await dockerRequest(
    env,
    '/volumes/create',
    {
      method: 'POST',
      body: JSON.stringify({
        Name: name,
        Labels: {
          provider: 'docker-local',
        },
      }),
    },
    [201]
  );
}

async function deleteVolume(env: KiloClawEnv, name: string): Promise<void> {
  const response = await dockerFetch(env, `/volumes/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (response.status === 404 || response.status === 204) return;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw dockerConfigError(
      `Provider docker-local Docker API request failed: ${response.status}${body ? ` ${body}` : ''}`,
      response.status
    );
  }
}

async function inspectContainer(
  env: KiloClawEnv,
  containerName: string
): Promise<DockerContainerInspect | null> {
  const response = await dockerFetch(env, `/containers/${encodeURIComponent(containerName)}/json`, {
    method: 'GET',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw dockerConfigError(
      `Provider docker-local Docker API request failed: ${response.status}${body ? ` ${body}` : ''}`,
      response.status
    );
  }
  const body: unknown = await response.json();
  if (!isDockerContainerInspect(body)) {
    throw dockerConfigError('Provider docker-local received an invalid container inspect payload');
  }
  return body;
}

async function listContainers(env: KiloClawEnv): Promise<DockerContainerSummary[]> {
  const response = await dockerRequest(env, '/containers/json?all=1');
  const body: unknown = await response.json();
  if (!isDockerContainerSummaryArray(body)) {
    throw dockerConfigError('Provider docker-local received an invalid container list payload');
  }
  return body;
}

async function allocateHostPort(
  env: KiloClawEnv,
  persistedHostPort: number | null
): Promise<number> {
  if (persistedHostPort) {
    return persistedHostPort;
  }
  const { start, end } = parsePortRange(env);
  const containers = await listContainers(env);
  const used = new Set<number>();
  for (const container of containers) {
    for (const port of container.Ports ?? []) {
      if (typeof port.PublicPort === 'number') {
        used.add(port.PublicPort);
      }
    }
  }
  for (let port = start; port <= end; port++) {
    if (!used.has(port)) return port;
  }
  throw dockerConfigError('Provider docker-local has no free ports in the configured range');
}

function buildContainerEnv(runtimeSpec: RuntimeSpec): string[] {
  return Object.entries({
    ...runtimeSpec.env,
    ...runtimeSpec.bootstrapEnv,
  }).map(([key, value]) => `${key}=${value}`);
}

function buildHostConfig(config: {
  volumeName: string;
  hostPort: number;
  runtimeSpec: RuntimeSpec;
}): DockerHostConfig {
  const { volumeName, hostPort, runtimeSpec } = config;
  return {
    Binds: [`${volumeName}:${runtimeSpec.rootMountPath}`],
    PortBindings: {
      [`${runtimeSpec.controllerPort}/tcp`]: [
        {
          HostIp: '127.0.0.1',
          HostPort: String(hostPort),
        },
      ],
    },
    RestartPolicy: {
      Name: 'no',
    },
    ...(runtimeSpec.machineSize
      ? {
          Memory: runtimeSpec.machineSize.memory_mb * 1024 * 1024,
          NanoCpus: runtimeSpec.machineSize.cpus * 1_000_000_000,
        }
      : {}),
  };
}

function requireContainerConfig(providerState: DockerLocalProviderState): {
  containerName: string;
  volumeName: string;
  hostPort: number;
} {
  if (!providerState.containerName || !providerState.volumeName || !providerState.hostPort) {
    throw dockerConfigError('Provider docker-local is missing container configuration');
  }

  return {
    containerName: providerState.containerName,
    volumeName: providerState.volumeName,
    hostPort: providerState.hostPort,
  };
}

async function createContainer(
  env: KiloClawEnv,
  state: Pick<InstanceMutableState, 'sandboxId' | 'userId'>,
  providerState: DockerLocalProviderState,
  runtimeSpec: RuntimeSpec
): Promise<void> {
  const config = requireContainerConfig(providerState);
  await dockerRequest(
    env,
    `/containers/create?name=${encodeURIComponent(config.containerName)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        Image: runtimeSpec.imageRef,
        Env: buildContainerEnv(runtimeSpec),
        ExposedPorts: {
          [`${runtimeSpec.controllerPort}/tcp`]: {},
        },
        Labels: {
          provider: 'docker-local',
          sandboxId: state.sandboxId ?? '',
          userId: state.userId ?? '',
        },
        HostConfig: buildHostConfig({
          volumeName: config.volumeName,
          hostPort: config.hostPort,
          runtimeSpec,
        }),
      }),
    },
    [201]
  );
}

async function persistProviderState(
  providerState: DockerLocalProviderState,
  onProviderResult: ((result: ProviderResult) => Promise<void>) | undefined
): Promise<void> {
  if (!onProviderResult) {
    throw dockerConfigError('Provider docker-local requires provider state persistence callback');
  }
  await onProviderResult({ providerState });
}

async function startContainer(env: KiloClawEnv, containerName: string): Promise<void> {
  await dockerRequest(
    env,
    `/containers/${encodeURIComponent(containerName)}/start`,
    {
      method: 'POST',
    },
    [204, 304]
  );
}

async function stopContainer(env: KiloClawEnv, containerName: string): Promise<void> {
  const response = await dockerFetch(env, `/containers/${encodeURIComponent(containerName)}/stop`, {
    method: 'POST',
  });
  if (response.status === 404 || response.status === 304 || response.status === 204) return;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw dockerConfigError(
      `Provider docker-local Docker API request failed: ${response.status}${body ? ` ${body}` : ''}`,
      response.status
    );
  }
}

async function removeContainer(env: KiloClawEnv, containerName: string): Promise<void> {
  const response = await dockerFetch(
    env,
    `/containers/${encodeURIComponent(containerName)}?force=true`,
    { method: 'DELETE' }
  );
  if (response.status === 404 || response.status === 204) return;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw dockerConfigError(
      `Provider docker-local Docker API request failed: ${response.status}${body ? ` ${body}` : ''}`,
      response.status
    );
  }
}

function ensureNames(
  state: Pick<InstanceMutableState, 'sandboxId'>,
  providerState: DockerLocalProviderState
): DockerLocalProviderState {
  return {
    provider: 'docker-local',
    containerName: providerState.containerName ?? buildContainerName(state),
    volumeName: providerState.volumeName ?? buildVolumeName(state),
    hostPort: providerState.hostPort,
  };
}

export const dockerLocalProviderAdapter: InstanceProviderAdapter = {
  id: 'docker-local',
  capabilities: {
    volumeSnapshots: false,
    candidateVolumes: false,
    volumeReassociation: false,
    snapshotRestore: false,
    directMachineDestroy: false,
  },

  async getRoutingTarget({ state }) {
    const providerState = getDockerLocalProviderState(state);
    if (!providerState.hostPort) {
      throw dockerConfigError('Provider docker-local has no assigned host port');
    }
    return {
      origin: `http://127.0.0.1:${providerState.hostPort}`,
      headers: {},
    };
  },

  async ensureProvisioningResources({ env, state }) {
    await pingDocker(env);
    return {
      providerState: ensureNames(state, getDockerLocalProviderState(state)),
    };
  },

  async ensureStorage({ env, state }) {
    const providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (!providerState.volumeName) {
      throw dockerConfigError('Provider docker-local is missing a volume name');
    }
    await ensureVolume(env, providerState.volumeName);
    return { providerState };
  },

  async startRuntime({ env, state, runtimeSpec, onProviderResult }) {
    let providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (!providerState.volumeName || !providerState.containerName) {
      throw dockerConfigError('Provider docker-local is missing deterministic resource names');
    }
    const volumeName = providerState.volumeName;
    const containerName = providerState.containerName;
    await ensureVolume(env, volumeName);
    const previousHostPort = providerState.hostPort;
    providerState = {
      ...providerState,
      hostPort: await allocateHostPort(env, providerState.hostPort),
    };
    if (providerState.hostPort !== previousHostPort) {
      await persistProviderState(providerState, onProviderResult);
    }

    const existing = await inspectContainer(env, containerName);
    if (!existing) {
      await createContainer(env, state, providerState, runtimeSpec);
      await startContainer(env, containerName);
    } else if (!existing.State?.Running || state.status !== 'running') {
      await removeContainer(env, containerName);
      await createContainer(env, state, providerState, runtimeSpec);
      await startContainer(env, containerName);
    }
    // If Docker and the DO both report running, leave the dev container intact.
    // Restart/redeploy is the explicit path that reapplies image/env/config changes.

    return {
      providerState,
      observation: {
        runtimeState: 'running',
      },
    };
  },

  async stopRuntime({ env, state }) {
    const providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (providerState.containerName) {
      await stopContainer(env, providerState.containerName);
    }
    return {
      providerState,
      observation: {
        runtimeState: 'stopped',
      },
    };
  },

  async restartRuntime({ env, state, runtimeSpec, onProviderResult }) {
    let providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (!providerState.volumeName || !providerState.containerName) {
      throw dockerConfigError('Provider docker-local is missing deterministic resource names');
    }
    const volumeName = providerState.volumeName;
    const containerName = providerState.containerName;
    await ensureVolume(env, volumeName);
    const previousHostPort = providerState.hostPort;
    providerState = {
      ...providerState,
      hostPort: await allocateHostPort(env, providerState.hostPort),
    };
    if (providerState.hostPort !== previousHostPort) {
      await persistProviderState(providerState, onProviderResult);
    }

    await removeContainer(env, containerName);
    await createContainer(env, state, providerState, runtimeSpec);
    await startContainer(env, containerName);

    return {
      providerState,
      observation: {
        runtimeState: 'running',
      },
    };
  },

  async inspectRuntime({ env, state }) {
    const providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (!providerState.containerName) {
      return {
        providerState,
        observation: {
          runtimeState: 'missing',
        },
      };
    }

    const container = await inspectContainer(env, providerState.containerName);
    return {
      providerState,
      observation: {
        runtimeState: !container ? 'missing' : container.State?.Running ? 'running' : 'stopped',
      },
    };
  },

  async destroyRuntime({ env, state }) {
    const providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (!providerState.containerName) {
      return { providerState };
    }

    await removeContainer(env, providerState.containerName);
    return {
      providerState: {
        ...providerState,
        containerName: null,
        hostPort: null,
      },
    };
  },

  async destroyStorage({ env, state }) {
    const providerState = ensureNames(state, getDockerLocalProviderState(state));
    if (!providerState.volumeName) {
      return { providerState };
    }

    await deleteVolume(env, providerState.volumeName);
    return {
      providerState: {
        ...providerState,
        volumeName: null,
      },
    };
  },
};
