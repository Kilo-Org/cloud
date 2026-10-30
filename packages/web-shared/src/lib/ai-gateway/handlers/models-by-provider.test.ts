import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

// The snapshot cache belongs to the handler module, so every test loads its own
// instance through `loadHandler` and starts from a cold cache. The factories
// reference these module-scope mocks, which stay the same across reloads.
const mockReadDb = { select: jest.fn() };
const mockFetchSnapshot = jest.fn<() => Promise<unknown>>();
const mockGetUserFromAuth = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockProviderLookup = jest.fn<(modelId: string) => Promise<ReadonlySet<string>>>();
const mockResolvePolicy =
  jest.fn<
    (args: {
      organizationId: string;
      kiloUserId: string;
      fromDb: unknown;
    }) => Promise<EffectiveOrganizationModelPolicy>
  >();

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    connection: jest.fn(async () => undefined),
  };
});
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: mockReadDb, db: {} }));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: mockGetUserFromAuth }));
jest.mock('@kilocode/web-shared/lib/model-allow.server', () => ({
  isModelRestrictionExempt: jest.fn(async () => false),
  getModelInferenceProviders: jest.fn(async () => undefined),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    fetchLatestModelsByProviderSnapshotFromDb: mockFetchSnapshot,
    getProviderSlugsForModel: mockProviderLookup,
  })
);
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server'
  ) as Record<string, unknown>),
  resolveOrganizationMemberModelPolicy: mockResolvePolicy,
}));

async function loadHandler() {
  jest.resetModules();
  return import('./models-by-provider');
}

function model(slug: string, variant = 'standard') {
  return { slug, endpoint: { variant } };
}

const snapshot = {
  providers: [
    {
      slug: 'alpha',
      models: [model('open/model'), model('routed/model'), model('denied/model')],
    },
    { slug: 'beta', models: [model('open/model'), model('routed/model')] },
    { slug: 'gamma', models: [model('denied/model')] },
    { slug: 'delta', models: [model('unrouted/model')] },
    { slug: 'freeonly', models: [model('free/model', 'free')] },
  ],
  total_providers: 5,
  total_models: 8,
};

const providersByModel: Record<string, string[]> = {
  'open/model': ['alpha', 'beta'],
  'routed/model': ['alpha', 'beta'],
  'denied/model': ['gamma'],
  'unrouted/model': ['delta'],
  'free/model:free': ['freeonly'],
  'free/model': [],
};

const policy: EffectiveOrganizationModelPolicy = {
  requireModelInCurrentSnapshot: true,
  organizationModelDenyList: ['denied/model'],
  memberGrant: {
    mode: 'selected',
    includeOrganizationBaseline: false,
    modelAllowList: ['open/model'],
    providerAllowList: ['alpha', 'freeonly'],
  },
  policyRevision: 1,
  customLlmGrantee: { organizationId: 'org-1', groupIds: [] },
};

describe('handleModelsByProviderRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchSnapshot.mockResolvedValue(snapshot);
    mockProviderLookup.mockImplementation(
      async modelId => new Set(providersByModel[modelId] ?? [])
    );
    mockResolvePolicy.mockImplementation(async () => policy);
  });

  test('returns the shared catalog for callers without an organization', async () => {
    mockGetUserFromAuth.mockRejectedValue(new Error('unauthenticated'));
    const { handleModelsByProviderRequest } = await loadHandler();

    const response = await handleModelsByProviderRequest();

    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(mockResolvePolicy).not.toHaveBeenCalled();
  });

  test('filters organization callers to allowed provider routes', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: 'org-1',
    });
    const { handleModelsByProviderRequest } = await loadHandler();

    const response = await handleModelsByProviderRequest();

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1);
    const [policyArgs] = mockResolvePolicy.mock.calls[0] ?? [];
    expect(policyArgs?.organizationId).toBe('org-1');
    expect(policyArgs?.kiloUserId).toBe('user-1');
    expect(policyArgs?.fromDb).toBe(mockReadDb);
    await expect(response.json()).resolves.toEqual({
      providers: [
        { slug: 'alpha', models: [model('open/model'), model('routed/model')] },
        { slug: 'beta', models: [model('open/model')] },
        { slug: 'freeonly', models: [model('free/model', 'free')] },
      ],
      total_providers: 3,
      total_models: 4,
    });
    expect(mockProviderLookup).toHaveBeenCalledWith('free/model:free');
    expect(mockProviderLookup).not.toHaveBeenCalledWith('free/model');
  });

  test('reads the catalog snapshot once across repeated requests', async () => {
    mockGetUserFromAuth.mockRejectedValue(new Error('unauthenticated'));
    const { handleModelsByProviderRequest } = await loadHandler();

    await handleModelsByProviderRequest();
    await handleModelsByProviderRequest();

    expect(mockFetchSnapshot).toHaveBeenCalledTimes(1);
  });

  test('throws the admin-panel error when no snapshot row exists', async () => {
    mockFetchSnapshot.mockResolvedValue(undefined);
    mockGetUserFromAuth.mockRejectedValue(new Error('unauthenticated'));
    const { handleModelsByProviderRequest } = await loadHandler();

    await expect(handleModelsByProviderRequest()).rejects.toThrow(/No models data found/);
  });
});
