import { describe, expect, it } from 'vitest';
import type {
  ApiCallResponse,
  ListProjectsRequest,
  ListProjectsResult,
  ListSecretsRequest,
  ListSecretsResult,
  ListServicesRequest,
  ListServicesResult,
  ListVolumesRequest,
  ListVolumesResult,
} from '@northflank/js-client';
import {
  NorthflankApiError,
  createNorthflankSdk,
  createVolume,
  deleteService,
  findProjectByName,
  getProjectSecretDetails,
  isNorthflankConflict,
  isNorthflankNotFound,
  listServices,
} from './client';
import { getNorthflankConfig } from './config';
import type { NorthflankClientConfig, NorthflankSdk } from './client';

const sdkCallResponseBase = {
  rawResponse: new Response('{}', {
    headers: {
      'x-request-id': 'req-1',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '99',
      'x-ratelimit-reset': '123',
    },
  }),
  request: {
    url: 'https://api.northflank.com/v1/test',
    method: 'GET',
    headers: {},
    body: undefined,
  },
};

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

function sdkResponse<T>(data: T): ApiCallResponse<T> {
  return {
    ...sdkCallResponseBase,
    data,
  };
}

async function unexpectedCall<T>(): Promise<ApiCallResponse<T>> {
  throw new Error('unexpected Northflank SDK call');
}

type NorthflankSdkOverrides = {
  create?: Partial<Omit<NorthflankSdk['create'], 'service'>> & {
    service?: Partial<NorthflankSdk['create']['service']>;
  };
  list?: Partial<NorthflankSdk['list']>;
  get?: Partial<NorthflankSdk['get']>;
  patch?: { service?: Partial<NorthflankSdk['patch']['service']> };
  put?: Partial<NorthflankSdk['put']>;
  delete?: Partial<NorthflankSdk['delete']>;
  scale?: Partial<NorthflankSdk['scale']>;
};

type ListCall<TRequest, TResult> = {
  (opts: TRequest): Promise<ApiCallResponse<TResult>>;
  all: (opts: TRequest) => Promise<ApiCallResponse<TResult>>;
};

function createListCall<TRequest, TResult>(
  implementation?: (opts: TRequest) => Promise<ApiCallResponse<TResult>>
): ListCall<TRequest, TResult> {
  const call =
    implementation ??
    (async () => {
      throw new Error('unexpected Northflank SDK list call');
    });
  return Object.assign(call, { all: call });
}

function createFakeSdk(overrides: NorthflankSdkOverrides): NorthflankSdk {
  return {
    create: {
      project: overrides.create?.project ?? unexpectedCall,
      volume: overrides.create?.volume ?? unexpectedCall,
      service: { deployment: overrides.create?.service?.deployment ?? unexpectedCall },
      secret: overrides.create?.secret ?? unexpectedCall,
    },
    list: {
      projects:
        overrides.list?.projects ?? createListCall<ListProjectsRequest, ListProjectsResult>(),
      volumes: overrides.list?.volumes ?? createListCall<ListVolumesRequest, ListVolumesResult>(),
      services:
        overrides.list?.services ?? createListCall<ListServicesRequest, ListServicesResult>(),
      secrets: overrides.list?.secrets ?? createListCall<ListSecretsRequest, ListSecretsResult>(),
    },
    get: {
      project: overrides.get?.project ?? unexpectedCall,
      volume: overrides.get?.volume ?? unexpectedCall,
      service: overrides.get?.service ?? unexpectedCall,
      secretDetails: overrides.get?.secretDetails ?? unexpectedCall,
    },
    patch: {
      service: { deployment: overrides.patch?.service?.deployment ?? unexpectedCall },
    },
    put: {
      secret: overrides.put?.secret ?? unexpectedCall,
    },
    delete: {
      project: overrides.delete?.project ?? unexpectedCall,
      volume: overrides.delete?.volume ?? unexpectedCall,
      service: overrides.delete?.service ?? unexpectedCall,
      secret: overrides.delete?.secret ?? unexpectedCall,
    },
    scale: {
      service: overrides.scale?.service ?? unexpectedCall,
    },
  };
}

describe('createNorthflankSdk', () => {
  it('creates the official Northflank SDK and strips /v1 from the configured host', () => {
    const sdk = createNorthflankSdk(config);

    expect(sdk).toHaveProperty('create.project');
    expect(sdk).toHaveProperty('list.projects');
  });
});

describe('Northflank SDK wrapper', () => {
  it('creates volumes with the official SDK payload shape', async () => {
    let capturedOpts: unknown;
    const sdk = createFakeSdk({
      create: {
        volume: async opts => {
          capturedOpts = opts;
          return sdkResponse({ id: 'volume-1', name: 'kc-ki-test' });
        },
      },
    });

    const volume = await createVolume({ ...config, teamId: 'team-1', sdk }, 'project-1', {
      name: 'kc-ki-test',
      mountPath: '/root',
      storageSizeMb: 10240,
      storageClassName: 'nf-multi-rw',
      accessMode: 'ReadWriteMany',
    });

    expect(volume).toEqual({ id: 'volume-1', name: 'kc-ki-test' });
    expect(capturedOpts).toEqual({
      parameters: { teamId: 'team-1', projectId: 'project-1' },
      data: {
        name: 'kc-ki-test',
        mounts: [{ containerMountPath: '/root' }],
        spec: {
          accessMode: 'ReadWriteMany',
          storageClassName: 'nf-multi-rw',
          storageSize: 10240,
        },
      },
    });
  });

  it('finds projects by deterministic name using SDK pagination helper', async () => {
    const projects = createListCall<ListProjectsRequest, ListProjectsResult>(async () =>
      sdkResponse({ projects: [{ id: 'project-1', name: 'kc-ki-test' }] })
    );
    const sdk = createFakeSdk({ list: { projects } });

    await expect(findProjectByName({ ...config, sdk }, 'kc-ki-test')).resolves.toEqual({
      id: 'project-1',
      name: 'kc-ki-test',
    });
  });

  it('lists services with deployment status and ingress DNS', async () => {
    const services = createListCall<ListServicesRequest, ListServicesResult>(async () =>
      sdkResponse({
        services: [
          {
            id: 'service-1',
            appId: '/team/project-1/service-1',
            projectId: 'project-1',
            name: 'kc-ki-test',
            tags: [],
            serviceType: 'deployment',
            disabledCI: true,
            disabledCD: false,
            servicePaused: false,
            deployment: { instances: 1 },
            status: { deployment: { status: 'COMPLETED', reason: 'DEPLOYING' } },
            ports: [{ name: 'p01', dns: 'kc-ki-test.code.run' }],
          },
        ],
      })
    );
    const sdk = createFakeSdk({ list: { services } });

    const result = await listServices({ ...config, sdk }, 'project-1');

    expect(result.hasNextPage).toBe(false);
    const firstService = result.services[0];
    expect(firstService?.id).toBe('service-1');
    expect(firstService?.name).toBe('kc-ki-test');
    expect(firstService?.servicePaused).toBe(false);
    expect(firstService?.deployment).toEqual({ instances: 1 });
    expect(firstService?.status?.deployment?.status).toBe('COMPLETED');
    expect(firstService?.ports).toEqual([{ name: 'p01', dns: 'kc-ki-test.code.run' }]);
  });

  it('passes delete_child_objects through SDK options', async () => {
    let capturedOpts: unknown;
    const sdk = createFakeSdk({
      delete: {
        service: async opts => {
          capturedOpts = opts;
          return sdkResponse({});
        },
      },
    });

    await deleteService({ ...config, sdk }, 'project-1', 'service-1', false);

    expect(capturedOpts).toEqual({
      parameters: { projectId: 'project-1', serviceId: 'service-1' },
      options: { delete_child_objects: false },
    });
  });

  it('redacts secret values from SDK response errors', async () => {
    const sdk = createFakeSdk({
      get: {
        secretDetails: async () => ({
          ...sdkCallResponseBase,
          data: {
            id: 'secret-1',
            name: 'secret',
            tags: [],
            type: 'secret',
            secretType: 'environment',
            projectId: 'project-1',
            priority: 10,
            restrictions: {},
            createdAt: '2026-04-17T00:00:00.000Z',
            updatedAt: '2026-04-17T00:00:00.000Z',
            secrets: {},
            addonSecrets: [],
          },
          error: {
            status: 500,
            message: 'failed with nf-token and edge-secret',
            details: {
              secrets: { variables: { KILOCLAW_ENV_KEY: 'env-key-secret' } },
              password: 'registry-password',
            },
          },
        }),
      },
    });

    let caught: unknown;
    try {
      await getProjectSecretDetails({ ...config, sdk }, 'project-1', 'secret-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NorthflankApiError);
    if (!(caught instanceof NorthflankApiError)) throw new Error('expected NorthflankApiError');
    expect(caught.status).toBe(500);
    expect(caught.requestId).toBe('req-1');
    expect(caught.rateLimit).toEqual({ limit: '100', remaining: '99', reset: '123' });
    expect(caught.body).not.toContain('nf-token');
    expect(caught.message).not.toContain('edge-secret');
    expect(caught.body).not.toContain('env-key-secret');
    expect(caught.body).not.toContain('registry-password');
  });

  it('redacts secret values from thrown SDK errors', async () => {
    const sdkError = Object.assign(new Error('failed with nf-token and edge-secret'), {
      status: 429,
    });
    const sdk = createFakeSdk({
      get: {
        secretDetails: async () => {
          throw sdkError;
        },
      },
    });

    let caught: unknown;
    try {
      await getProjectSecretDetails({ ...config, sdk }, 'project-1', 'secret-1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NorthflankApiError);
    if (!(caught instanceof NorthflankApiError)) throw new Error('expected NorthflankApiError');
    expect(caught.status).toBe(429);
    expect(caught.body).not.toContain('nf-token');
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
