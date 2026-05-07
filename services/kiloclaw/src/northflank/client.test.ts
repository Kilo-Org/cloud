import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NorthflankApiError,
  createProjectSecret,
  createVolume,
  deleteService,
  findProjectByName,
  findProjectSecretByName,
  findServiceByName,
  findVolumeByName,
  getProjectSecretDetails,
  isNorthflankConflict,
  isNorthflankNotFound,
  listServices,
  putProjectSecret,
} from './client';
import { getNorthflankConfig } from './config';
import type { NorthflankClientConfig } from './client';

const config: NorthflankClientConfig = {
  ...getNorthflankConfig({
    NF_API_TOKEN: 'nf-token',
    NF_API_BASE: 'https://api.northflank.com/v1',
    NF_REGION: 'us-central',
    NF_DEPLOYMENT_PLAN: 'nf-compute-200',
    NF_EDGE_HEADER_NAME: 'x-kiloclaw-edge',
    NF_EDGE_HEADER_VALUE: 'edge-secret',
  } as never),
  redactValues: ['edge-secret', 'env-key-secret'],
};

function mockFetchSequence(
  responses: Array<[number, unknown, HeadersInit?]>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const [status, body, headers] of responses) {
    const responseBody = typeof body === 'string' ? body : JSON.stringify(body);
    fetchMock.mockResolvedValueOnce(new Response(responseBody, { status, headers }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index: number): [unknown, unknown] {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`fetch call ${index} was not recorded`);
  return [call[0], call[1]];
}

function firstFetchCall(fetchMock: ReturnType<typeof vi.fn>): [unknown, unknown] {
  return fetchCall(fetchMock, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectRequestInit(value: unknown): RequestInit {
  if (!isRecord(value)) throw new Error('fetch init was not an object');
  return value;
}

function expectHeaderRecord(value: HeadersInit | undefined): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('headers were not a plain object');
  return value;
}

function expectStringBody(value: BodyInit | null | undefined): string {
  if (typeof value !== 'string') throw new Error('request body was not a string');
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Northflank Worker fetch client', () => {
  it('does not log successful Northflank requests', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    mockFetchSequence([[200, { data: { id: 'kc-ki-test', name: 'kc-ki-test' } }]]);

    await expect(findProjectByName({ ...config, teamId: 'team-1' }, 'kc-ki-test')).resolves.toEqual(
      {
        id: 'kc-ki-test',
        name: 'kc-ki-test',
      }
    );

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('sends auth headers and creates volumes mounted at /root', async () => {
    const fetchMock = mockFetchSequence([[201, { data: { id: 'volume-1', name: 'kc-ki-test' } }]]);

    const volume = await createVolume({ ...config, teamId: 'team-1' }, 'project-1', {
      name: 'kc-ki-test',
      mountPath: '/root',
      storageSizeMb: 10240,
      storageClassName: 'nf-multi-rw',
      accessMode: 'ReadWriteMany',
    });

    expect(volume).toEqual({ id: 'volume-1', name: 'kc-ki-test' });
    const [url, init] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/teams/team-1/projects/project-1/volumes');
    const requestInit = expectRequestInit(init);
    const headers = expectHeaderRecord(requestInit.headers);
    expect(requestInit.method).toBe('POST');
    expect(headers.Authorization).toBe('Bearer nf-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(expectStringBody(requestInit.body))).toEqual({
      name: 'kc-ki-test',
      mounts: [{ containerMountPath: '/root' }],
      spec: {
        accessMode: 'ReadWriteMany',
        storageClassName: 'nf-multi-rw',
        storageSize: 10240,
      },
    });
  });

  it('finds projects by deterministic name with a direct GET', async () => {
    const fetchMock = mockFetchSequence([
      [200, { data: { id: 'kc-ki-test', name: 'kc-ki-test' } }],
    ]);

    await expect(findProjectByName(config, 'kc-ki-test')).resolves.toEqual({
      id: 'kc-ki-test',
      name: 'kc-ki-test',
    });

    const [url] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/projects/kc-ki-test');
  });

  it('returns null when a direct project lookup returns 404', async () => {
    const fetchMock = mockFetchSequence([[404, { message: 'not found' }]]);

    await expect(findProjectByName(config, 'kc-ki-missing')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finds volumes by deterministic name with a direct GET', async () => {
    const fetchMock = mockFetchSequence([
      [200, { data: { id: 'kc-ki-test', name: 'kc-ki-test' } }],
    ]);

    await expect(findVolumeByName(config, 'project-1', 'kc-ki-test')).resolves.toEqual({
      id: 'kc-ki-test',
      name: 'kc-ki-test',
    });

    const [url] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/projects/project-1/volumes/kc-ki-test');
  });

  it('finds services by deterministic name with a direct GET', async () => {
    const fetchMock = mockFetchSequence([
      [200, { data: { id: 'kc-ki-test', name: 'kc-ki-test' } }],
    ]);

    await expect(findServiceByName(config, 'project-1', 'kc-ki-test')).resolves.toEqual({
      id: 'kc-ki-test',
      name: 'kc-ki-test',
    });

    const [url] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/projects/project-1/services/kc-ki-test');
  });

  it('finds project secrets by deterministic name with a direct GET', async () => {
    const fetchMock = mockFetchSequence([
      [200, { data: { id: 'kc-ki-test', name: 'kc-ki-test' } }],
    ]);

    await expect(findProjectSecretByName(config, 'project-1', 'kc-ki-test')).resolves.toEqual({
      id: 'kc-ki-test',
      name: 'kc-ki-test',
    });

    const [url] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/projects/project-1/secrets/kc-ki-test');
  });

  it('lists services with deployment status and ingress DNS', async () => {
    mockFetchSequence([
      [
        200,
        {
          data: {
            services: [
              {
                id: 'service-1',
                name: 'kc-ki-test',
                servicePaused: false,
                deployment: { instances: 1 },
                status: { deployment: { status: 'COMPLETED' } },
                ports: [{ name: 'p01', dns: 'kc-ki-test.code.run' }],
              },
            ],
          },
        },
      ],
    ]);

    const result = await listServices(config, 'project-1');

    expect(result.hasNextPage).toBe(false);
    const firstService = result.services[0];
    expect(firstService?.id).toBe('service-1');
    expect(firstService?.name).toBe('kc-ki-test');
    expect(firstService?.servicePaused).toBe(false);
    expect(firstService?.deployment).toEqual({ instances: 1 });
    expect(firstService?.status?.deployment?.status).toBe('COMPLETED');
    expect(firstService?.ports).toEqual([{ name: 'p01', dns: 'kc-ki-test.code.run' }]);
  });

  it('encodes delete_child_objects as a query parameter', async () => {
    const fetchMock = mockFetchSequence([[200, '']]);

    await deleteService(config, 'project-1', 'service-1', false);

    const [url, init] = firstFetchCall(fetchMock);
    expect(url).toBe(
      'https://api.northflank.com/v1/projects/project-1/services/service-1?delete_child_objects=false'
    );
    expect(expectRequestInit(init).method).toBe('DELETE');
  });

  it('creates project secrets through Northflank project-scoped routes', async () => {
    const fetchMock = mockFetchSequence([[201, { data: { id: 'secret-1', name: 'kc-ki-test' } }]]);

    await expect(
      createProjectSecret({ ...config, teamId: 'team-1' }, 'project-1', {
        name: 'kc-ki-test',
        type: 'secret',
        secretType: 'environment',
        priority: 100,
        restrictions: {
          restricted: true,
          nfObjects: [{ id: 'service-1', type: 'service' }],
        },
        secrets: { variables: { KILOCLAW_ENV_KEY: 'env-key-secret' } },
      })
    ).resolves.toEqual({ id: 'secret-1', name: 'kc-ki-test' });

    const [url] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/projects/project-1/secrets');
  });

  it('updates project secrets with PATCH on the secret-specific route', async () => {
    const fetchMock = mockFetchSequence([[200, { data: { id: 'secret-1', name: 'kc-ki-test' } }]]);

    await expect(
      putProjectSecret(config, 'project-1', 'secret-1', {
        name: 'kc-ki-test',
        type: 'secret',
        secretType: 'environment',
        priority: 100,
        restrictions: {
          restricted: true,
          nfObjects: [{ id: 'service-1', type: 'service' }],
        },
        secrets: { variables: { KILOCLAW_ENV_KEY: 'env-key-secret' } },
      })
    ).resolves.toEqual({ id: 'secret-1', name: 'kc-ki-test' });

    const [url, init] = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.northflank.com/v1/projects/project-1/secrets/secret-1');
    const requestInit = expectRequestInit(init);
    expect(requestInit.method).toBe('PATCH');
    expect(JSON.parse(expectStringBody(requestInit.body))).toEqual({
      type: 'secret',
      secretType: 'environment',
      priority: 100,
      restrictions: {
        restricted: true,
        nfObjects: [{ id: 'service-1', type: 'service' }],
      },
      secrets: { variables: { KILOCLAW_ENV_KEY: 'env-key-secret' } },
    });
  });

  it('redacts secret values from API errors and failure logs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetchSequence([
      [
        500,
        {
          error: 'failed with nf-token and edge-secret',
          secrets: { variables: { KILOCLAW_ENV_KEY: 'env-key-secret' } },
          password: 'registry-password',
        },
        {
          'x-request-id': 'req-1',
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '123',
        },
      ],
    ]);

    let caught: unknown;
    try {
      await getProjectSecretDetails(config, 'project-1', 'secret-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NorthflankApiError);
    if (!(caught instanceof NorthflankApiError)) throw new Error('expected NorthflankApiError');
    expect(caught.status).toBe(500);
    expect(caught.requestId).toBe('req-1');
    expect(caught.rateLimit).toEqual({ limit: '100', remaining: '0', reset: '123' });
    expect(caught.body).not.toContain('nf-token');
    expect(caught.message).not.toContain('edge-secret');
    expect(caught.body).not.toContain('env-key-secret');
    expect(caught.body).not.toContain('registry-password');
    expect(warnSpy).toHaveBeenCalledWith(
      '[northflank] api_request_failed',
      expect.objectContaining({
        context: 'getProjectSecretDetails',
        method: 'GET',
        path: '/v1/projects/project-1/secrets/secret-1/details',
        teamScoped: false,
        status: 500,
      })
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('nf-token');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('edge-secret');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('env-key-secret');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('registry-password');
  });

  it('includes thrown fetch error messages without leaking secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('failed with nf-token and edge-secret');
      })
    );

    let caught: unknown;
    try {
      await getProjectSecretDetails(config, 'project-1', 'secret-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NorthflankApiError);
    if (!(caught instanceof NorthflankApiError)) throw new Error('expected NorthflankApiError');
    expect(caught.status).toBe(503);
    expect(caught.body).toContain('failed with [REDACTED] and [REDACTED]');
  });
});

describe('Northflank error helpers', () => {
  it('matches not-found and conflict API errors', () => {
    const rateLimit = { limit: null, remaining: null, reset: null };

    expect(
      isNorthflankNotFound(new NorthflankApiError('not found', 404, '{}', null, rateLimit))
    ).toBe(true);
    expect(
      isNorthflankConflict(new NorthflankApiError('conflict', 409, '{}', null, rateLimit))
    ).toBe(true);
    expect(isNorthflankNotFound(new Error('not found'))).toBe(false);
    expect(isNorthflankConflict(new Error('conflict'))).toBe(false);
  });
});
