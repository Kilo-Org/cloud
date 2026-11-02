import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { EffectiveOrganizationModelPolicy } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

// The snapshot cache belongs to the handler module, so every test loads its own
// instance through `loadHandlers` and starts from a cold cache. The factories
// reference these module-scope mocks, which stay the same across reloads.
const mockReadDb = { select: jest.fn() };
const mockGetUserFromAuth = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockIsModelRouteAllowed =
  jest.fn<(policy: unknown, modelId: string, providerSlug: string) => Promise<boolean>>();
const mockCaptureException = jest.fn();

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    connection: jest.fn(async () => undefined),
  };
});
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: mockReadDb, db: {} }));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: mockGetUserFromAuth }));
jest.mock('@kilocode/web-shared/lib/model-allow.server', () => ({
  isModelRestrictionExempt: jest.fn(async () => false),
  getModelInferenceProviders: jest.fn(async () => undefined),
}));
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelPolicy: jest.fn(
    async (): Promise<EffectiveOrganizationModelPolicy> => ({
      requireModelInCurrentSnapshot: true,
      organizationModelDenyList: [],
      memberGrant: {
        mode: 'selected',
        includeOrganizationBaseline: false,
        modelAllowList: [],
        providerAllowList: ['alpha'],
      },
      policyRevision: 1,
      customLlmGrantee: { organizationId: 'org-1', groupIds: [] },
    })
  ),
  isModelRouteAllowed: mockIsModelRouteAllowed,
}));

async function loadHandlers() {
  jest.resetModules();
  const [models, providers] = await Promise.all([
    import('./models-by-provider'),
    import('./providers'),
  ]);
  return {
    handleModelsByProviderRequest: models.handleModelsByProviderRequest,
    handleProvidersRequest: providers.handleProvidersRequest,
  };
}

const SNAPSHOT_TTL_MS = 600_000;
const FAILURE_BACKOFF_MS = 30_000;

function provider(slug: string, models: Array<{ slug: string; variant?: string }> = []) {
  return {
    name: slug,
    displayName: slug,
    slug,
    models: models.map(({ slug: modelSlug, variant = 'standard' }) => ({
      slug: modelSlug,
      endpoint: { variant },
    })),
  };
}

const snapshot = {
  providers: [
    provider('alpha', [{ slug: 'open/model' }]),
    provider('beta', [{ slug: 'open/model' }]),
    provider('gamma', [{ slug: 'denied/model' }]),
  ],
  total_providers: 3,
  total_models: 3,
};

function mockSnapshotRow(rows: Array<{ data: unknown }>) {
  const query = {
    from: () => query,
    orderBy: () => query,
    limit: async () => rows,
  };
  mockReadDb.select.mockReturnValue(query as never);
}

describe('catalog snapshot cache shared by both handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshotRow([{ data: snapshot }]);
    mockGetUserFromAuth.mockRejectedValue(new Error('unauthenticated'));
    mockIsModelRouteAllowed.mockImplementation(async (_policy, _modelId, providerSlug) =>
      Boolean(providerSlug === 'alpha')
    );
  });

  test('serves repeated requests to both handlers from one snapshot read', async () => {
    const { handleModelsByProviderRequest, handleProvidersRequest } = await loadHandlers();

    const modelsBody = await handleModelsByProviderRequest().then(response => response.json());
    await handleModelsByProviderRequest();
    const providersBody = await handleProvidersRequest().then(response => response.json());

    expect(mockReadDb.select).toHaveBeenCalledTimes(1);
    expect(modelsBody).toEqual(snapshot);
    expect(providersBody.data.map((entry: { slug: string }) => entry.slug)).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'gamma'])
    );
    // Direct BYOK listings belong to the providers endpoint only.
    expect(modelsBody.providers.map((entry: { slug: string }) => entry.slug)).not.toContain(
      'synthetic'
    );
  });

  test('re-reads the snapshot once the TTL has passed', async () => {
    const { handleModelsByProviderRequest, handleProvidersRequest } = await loadHandlers();

    await handleModelsByProviderRequest();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + SNAPSHOT_TTL_MS + 1);

    await handleProvidersRequest();

    expect(mockReadDb.select).toHaveBeenCalledTimes(2);
  });

  test('never stores an organization-filtered body in the shared cache', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: 'org-1',
    });
    const { handleModelsByProviderRequest, handleProvidersRequest } = await loadHandlers();

    const orgResponse = await handleModelsByProviderRequest();
    const orgBody = await orgResponse.json();
    const providersBody = await handleProvidersRequest().then(response => response.json());

    expect(orgResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(orgBody.providers.map((entry: { slug: string }) => entry.slug)).toEqual(['alpha']);
    expect(providersBody.data.map((entry: { slug: string }) => entry.slug)).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'gamma'])
    );
    expect(mockReadDb.select).toHaveBeenCalledTimes(1);
  });

  test('answers 503 from the providers endpoint when the snapshot row is missing', async () => {
    mockSnapshotRow([]);
    const { handleProvidersRequest } = await loadHandlers();

    const response = await handleProvidersRequest();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Service Unavailable',
      message: 'Providers data not yet available',
    });
  });

  test('re-reads a missing catalog after the failure backoff instead of the TTL', async () => {
    mockSnapshotRow([]);
    const { handleModelsByProviderRequest, handleProvidersRequest } = await loadHandlers();

    await expect(handleModelsByProviderRequest()).rejects.toThrow(/No models data found/);

    mockSnapshotRow([{ data: snapshot }]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + FAILURE_BACKOFF_MS + 1);

    const response = await handleProvidersRequest();

    expect(response.status).toBe(200);
    expect(mockReadDb.select).toHaveBeenCalledTimes(2);
  });

  test('reports an invalid snapshot once and answers 500 for it', async () => {
    mockSnapshotRow([{ data: { providers: [{ slug: 42 }], total_providers: 1, total_models: 0 } }]);
    const { handleProvidersRequest } = await loadHandlers();

    const first = await handleProvidersRequest();
    const second = await handleProvidersRequest();

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    await expect(second.json()).resolves.toEqual({
      error: 'Internal Server Error',
      message: 'Failed to fetch providers',
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});
