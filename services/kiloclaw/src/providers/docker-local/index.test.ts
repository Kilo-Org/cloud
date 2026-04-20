import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dockerLocalProviderAdapter } from './index';

function getContainerEnv(body: Record<string, unknown> | null): string[] {
  const env = body?.Env;
  if (!Array.isArray(env)) return [];
  return env.filter((entry): entry is string => typeof entry === 'string');
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected JSON string request body');
  }
  return JSON.parse(init.body) as Record<string, unknown>;
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

  function runtimeStateWithProviderState(
    providerState: Record<string, string | number | null>,
    stateOverrides: Record<string, unknown> = {}
  ) {
    return {
      ...(runtimeState() as unknown as Record<string, unknown>),
      providerState,
      ...stateOverrides,
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

  it('preserves a versioned Docker API base path', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('OK', { status: 200 }));

    await dockerLocalProviderAdapter.ensureProvisioningResources({
      env: {
        WORKER_ENV: 'development',
        DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750/v1.44',
        DOCKER_LOCAL_IMAGE: 'kiloclaw:local',
        DOCKER_LOCAL_PORT_RANGE: '45000-45010',
      } as never,
      state: runtimeState(),
      orgId: null,
      machineSize: null,
    });

    expect(fetchInputUrl(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:23750/v1.44/_ping');
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
    const events: string[] = [];
    const onProviderResult = vi.fn(async () => {
      events.push('persist');
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = fetchInputUrl(input);
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
        return new Response(
          JSON.stringify([
            { Ports: null },
            { Ports: [{ PublicPort: null }, { PublicPort: 45000 }] },
          ]),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/json')) {
        events.push('inspect-container');
        return new Response('', { status: 404 });
      }
      if (url.includes('/containers/create?name=kiloclaw-sandbox-1')) {
        events.push('create-container');
        createBody = requestJsonBody(init);
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
        machineSize: {
          cpu_kind: 'shared',
          cpus: 2,
          memory_mb: 4096,
        },
      },
      onProviderResult,
    });

    expect(onProviderResult).toHaveBeenCalledWith({
      providerState: {
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      },
    });
    expect(events).toEqual(['persist', 'inspect-container', 'create-container']);
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
    expect(createBody).toMatchObject({
      HostConfig: {
        Binds: ['kiloclaw-root-sandbox-1:/root'],
        Memory: 4096 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
      },
    });
  });

  it('recreates an existing stopped container so the current runtime spec is applied', async () => {
    const fetchMock = vi.mocked(fetch);
    const events: string[] = [];
    let createBody: Record<string, unknown> | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response(JSON.stringify({ Name: 'kiloclaw-root-sandbox-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/json')) {
        events.push('inspect-container');
        return new Response(
          JSON.stringify({
            Id: 'container-1',
            Name: '/kiloclaw-sandbox-1',
            State: { Running: false, Status: 'exited' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1?force=true')) {
        events.push('remove-container');
        return new Response(null, { status: 204 });
      }
      if (url.includes('/containers/create?name=kiloclaw-sandbox-1')) {
        events.push('create-container');
        createBody = requestJsonBody(init);
        return new Response(JSON.stringify({ Id: 'container-2' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/start')) {
        events.push('start-container');
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    const result = await dockerLocalProviderAdapter.startRuntime({
      env: devEnv(),
      state: runtimeStateWithProviderState({
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      }),
      runtimeSpec: {
        ...runtimeSpec(),
        imageRef: 'kiloclaw:new',
        env: { FOO: 'updated' },
      },
    });

    expect(events).toEqual([
      'inspect-container',
      'remove-container',
      'create-container',
      'start-container',
    ]);
    expect(result.observation?.runtimeState).toBe('running');
    expect(createBody).toMatchObject({ Image: 'kiloclaw:new' });
    expect(getContainerEnv(createBody)).toEqual(expect.arrayContaining(['FOO=updated']));
  });

  it('recreates an existing running container during start from stopped state', async () => {
    const fetchMock = vi.mocked(fetch);
    const events: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = fetchInputUrl(input);
      if (url.endsWith('/volumes/kiloclaw-root-sandbox-1')) {
        return new Response(JSON.stringify({ Name: 'kiloclaw-root-sandbox-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/json')) {
        events.push('inspect-container');
        return new Response(
          JSON.stringify({
            Id: 'container-1',
            Name: '/kiloclaw-sandbox-1',
            State: { Running: true, Status: 'running' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1?force=true')) {
        events.push('remove-container');
        return new Response(null, { status: 204 });
      }
      if (url.includes('/containers/create?name=kiloclaw-sandbox-1')) {
        events.push('create-container');
        expect(requestJsonBody(init)).toMatchObject({ Image: 'kiloclaw:new' });
        return new Response(JSON.stringify({ Id: 'container-2' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/containers/kiloclaw-sandbox-1/start')) {
        events.push('start-container');
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unhandled Docker API request: ${url}`);
    });

    await dockerLocalProviderAdapter.startRuntime({
      env: devEnv(),
      state: runtimeStateWithProviderState(
        {
          provider: 'docker-local',
          containerName: 'kiloclaw-sandbox-1',
          volumeName: 'kiloclaw-root-sandbox-1',
          hostPort: 45001,
        },
        { status: 'stopped' }
      ),
      runtimeSpec: {
        ...runtimeSpec(),
        imageRef: 'kiloclaw:new',
      },
    });

    expect(events).toEqual([
      'inspect-container',
      'remove-container',
      'create-container',
      'start-container',
    ]);
  });

  it('inspects Docker container state as provider runtime state', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          Id: 'container-1',
          Name: '/kiloclaw-sandbox-1',
          State: { Running: true, Status: 'running' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await dockerLocalProviderAdapter.inspectRuntime({
      env: devEnv(),
      state: runtimeStateWithProviderState({
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      }),
    });

    expect(result.observation?.runtimeState).toBe('running');
  });

  it('reports missing when the Docker container is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));

    const result = await dockerLocalProviderAdapter.inspectRuntime({
      env: devEnv(),
      state: runtimeStateWithProviderState({
        provider: 'docker-local',
        containerName: 'kiloclaw-sandbox-1',
        volumeName: 'kiloclaw-root-sandbox-1',
        hostPort: 45001,
      }),
    });

    expect(result.observation?.runtimeState).toBe('missing');
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
