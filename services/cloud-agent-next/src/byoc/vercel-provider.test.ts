import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type * as CredentialResolverModule from './vercel-credential-resolver.js';
import {
  VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG,
  VERCEL_CLOUD_AGENT_RESOURCE_TAG,
  VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
  VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG,
} from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import {
  createByocVercelProviderAdapter,
  unavailableVercelProviderAdapter,
} from './vercel-provider.js';
import {
  resolveByocVercelRuntimeConfig,
  resolveByocVercelAccessConfig,
  projectByocVercelSnapshotMissing,
} from './vercel-credential-resolver.js';

vi.mock('./vercel-credential-resolver.js', async importOriginal => {
  const actual = await importOriginal<typeof CredentialResolverModule>();
  return {
    ...actual,
    resolveByocVercelRuntimeConfig: vi.fn(),
    resolveByocVercelAccessConfig: vi.fn(),
    projectByocVercelSnapshotMissing: vi.fn(),
  };
});

const source = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
};
const snapshot = {
  ...source,
  buildGeneration: '33333333-3333-4333-8333-333333333333',
  runtimeSnapshotId: 'snap_customer',
};
const config = {
  accessToken: 'customer-test-token',
  teamId: 'team_customer',
  projectId: 'prj_customer',
  snapshotId: 'snap_customer',
  runtimeBuildId: 'build_customer',
  runtime: 'node24' as const,
  initialTimeoutMs: 300_000,
  extendDurationMs: 600_000,
};
const intent = { intentId: 'create_customer', createdAt: 1 };
const sandboxName = 'ses-customer';

function adapter() {
  return createByocVercelProviderAdapter({
    env: Object.assign({} as Env, {
      WORKER_URL: 'http://worker.test',
      VERCEL_TOKEN: 'platform-test-token',
    }),
    source,
    sandboxName,
    readContainedGrants: async () => [],
  });
}

function createdSandbox() {
  return {
    sandbox: {
      name: sandboxName,
      currentSessionId: 'sbox_customer',
      status: 'running',
      persistent: false,
      createdAt: 1,
      updatedAt: 1,
      tags: {
        [VERCEL_CLOUD_AGENT_RESOURCE_TAG]: VERCEL_CLOUD_AGENT_RESOURCE_TAG_VALUE,
        [VERCEL_CLOUD_AGENT_CREATE_OPERATION_TAG]: intent.intentId,
        [VERCEL_CLOUD_AGENT_RUNTIME_BUILD_TAG]: config.runtimeBuildId,
      },
    },
    session: {
      id: 'sbox_customer',
      sourceSandboxName: sandboxName,
      projectId: config.projectId,
      sourceSnapshotId: config.snapshotId,
      runtime: config.runtime,
      status: 'running',
      memory: 4096,
      vcpus: 2,
      region: 'iad1',
      timeout: 300_000,
      requestedAt: 1,
      cwd: '/',
      createdAt: 1,
      updatedAt: 1,
    },
    routes: [],
  };
}

beforeEach(() => {
  vi.mocked(resolveByocVercelRuntimeConfig)
    .mockReset()
    .mockImplementation(async (_env, input, resolved) => {
      expect(input).toEqual(source);
      resolved?.(snapshot);
      return config;
    });
  vi.mocked(resolveByocVercelAccessConfig).mockReset().mockResolvedValue(config);
  vi.mocked(projectByocVercelSnapshotMissing).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BYOC Vercel provider on the current control plane', () => {
  it('creates with the customer token, project, and snapshot instead of platform credentials', async () => {
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
      requests.push({
        url,
        authorization: new Headers(init.headers).get('authorization'),
        body: JSON.parse(init.body),
      });
      return Response.json(createdSandbox());
    });
    expect(await adapter().create(intent)).toEqual({
      providerRef: JSON.stringify({
        sandboxName,
        sessionId: 'sbox_customer',
        metadata: { region: 'iad1', sourceSnapshotId: config.snapshotId, instanceType: 'small' },
      }),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: 'https://api.vercel.com/v2/sandboxes?teamId=team_customer',
      authorization: 'Bearer customer-test-token',
      body: {
        projectId: 'prj_customer',
        source: { type: 'snapshot', snapshotId: 'snap_customer' },
      },
    });
  });

  it('marks only the resolved customer snapshot missing after a provider 404', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(adapter().create(intent)).rejects.toMatchObject({
      reason: 'byoc_vercel_snapshot_missing',
    });
    expect(projectByocVercelSnapshotMissing).toHaveBeenCalledWith(expect.anything(), snapshot);
  });

  it.each([
    [403, 'byoc_vercel_forbidden'],
    [429, 'byoc_vercel_capacity'],
  ])('projects provider status %s without invalidating the snapshot', async (status, reason) => {
    vi.stubGlobal('fetch', async () => new Response('', { status: Number(status) }));
    await expect(adapter().create(intent)).rejects.toMatchObject({ reason });
    expect(projectByocVercelSnapshotMissing).not.toHaveBeenCalled();
  });
});

describe('retired Kilo-paid Vercel adapter', () => {
  it('fails every compute operation without using customer or platform credentials', async () => {
    const retired = unavailableVercelProviderAdapter();
    for (const operation of [
      () => retired.ensureBillingAdmission('retired'),
      () => retired.create({ intentId: 'retired', createdAt: 1, allocationName: 'retired' }),
      () => retired.launch('retired', {}),
      () => retired.observe('retired'),
      () => retired.stop('retired'),
      () => retired.ensureLeaseAtLeast('retired', 1),
      () => retired.logs('retired'),
    ]) {
      await expect(operation()).rejects.toMatchObject({ reason: 'byoc_credential_missing' });
    }
  });
});
