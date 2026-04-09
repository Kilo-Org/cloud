import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerLocalProviderAdapter } from './index';

function getContainerEnv(body: Record<string, unknown> | null): string[] {
  const env = body?.Env;
  if (!Array.isArray(env)) return [];
  return env.filter((entry): entry is string => typeof entry === 'string');
}

describe('dockerLocalProviderAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function devEnv() {
    return {
      WORKER_ENV: 'development',
      DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750',
      DOCKER_LOCAL_IMAGE: 'kiloclaw:local',
      DOCKER_LOCAL_PORT_RANGE: '45000-45010',
    } as never;
  }

  function runtimeState() {
    return {
      userId: 'user-1',
      sandboxId: 'sandbox-1',
      provider: 'docker-local',
      providerState: null,
      status: 'provisioned',
    } as never;
  }

  function runtimeSpec() {
    return {
      imageRef: 'kiloclaw:local',
      env: { FOO: 'bar' },
      bootstrapEnv: {},
      machineSize: null,
      rootMountPath: '/root',
      controllerPort: 18789,
      controllerHealthCheckPath: '/_kilo/health',
      metadata: { sandboxId: 'sandbox-1' },
    } as const;
  }

  it('seeds deterministic names during provisioning resource setup', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('OK', { status: 200 }));

    const result = await dockerLocalProviderAdapter.ensureProvisioningResources({
      env: devEnv(),
      state: runtimeState(),
      orgId: null,
      machineSize: null,
    });

    expect(result.providerState).toEqual({
      provider: 'docker-local',
      containerName: 'kiloclaw-sandbox-1',
      volumeName: 'kiloclaw-root-sandbox-1',
      hostPort: null,
    });
  });

  it('creates the Docker volume when storage is missing', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(
      new Response(JSON.stringify({ Name: 'kiloclaw-root-sandbox-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    );

    const result = await dockerLocalProviderAdapter.ensureStorage({
      env: devEnv(),
      state: runtimeState(),
      reason: 'test',
    });

    expect(result.providerState).toEqual({
      provider: 'docker-local',
      containerName: 'kiloclaw-sandbox-1',
      volumeName: 'kiloclaw-root-sandbox-1',
      hostPort: null,
    });
  });

  it('allocates a host port and creates/starts a container on first start', async () => {
    const fetchMock = vi.mocked(fetch);
    let createBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response('', { status: 404 });
      }
      if (url.endsWith('/volumes/create')) {
        return new Response(JSON.stringify({ Name: 'kiloclaw-root-sandbox-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/containers/json?all=1')) {
        return new Response(JSON.stringify([{ Ports: [{ PublicPort: 45000 }] }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/json')) {
        return new Response('', { status: 404 });
      }
      if (url.includes('/containers/create?name=kiloclaw-sandbox-1')) {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ Id: 'container-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/start')) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    const result = await dockerLocalProviderAdapter.startRuntime({
      env: devEnv(),
      state: runtimeState(),
      runtimeSpec: {
        ...runtimeSpec(),
        bootstrapEnv: {
          KILOCLAW_ENV_KEY: 'env-key-1',
        },
      },
    });

    expect(result.providerState).toEqual({
      provider: 'docker-local',
      containerName: 'kiloclaw-sandbox-1',
      volumeName: 'kiloclaw-root-sandbox-1',
      hostPort: 45001,
    });
    expect(result.observation?.runtimeState).toBe('running');
    expect(getContainerEnv(createBody)).toEqual(
      expect.arrayContaining(['FOO=bar', 'KILOCLAW_ENV_KEY=env-key-1'])
    );
  });

  it('returns a localhost routing target from the assigned host port', async () => {
    const target = await dockerLocalProviderAdapter.getRoutingTarget({
      env: devEnv(),
      state: {
        providerState: {
          provider: 'docker-local',
          containerName: 'kiloclaw-sandbox-1',
          volumeName: 'kiloclaw-root-sandbox-1',
          hostPort: 45001,
        },
      } as never,
    });

    expect(target).toEqual({
      origin: 'http://127.0.0.1:45001',
      headers: {},
    });
  });
});
