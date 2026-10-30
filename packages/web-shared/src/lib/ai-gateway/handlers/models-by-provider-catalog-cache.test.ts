import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { isModelRouteAllowed } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { handleModelsByProviderRequest } from './models-by-provider';
import { handleProvidersRequest } from './providers';

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    connection: jest.fn(async () => undefined),
  };
});
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  readDb: { select: jest.fn() },
  db: {},
}));
jest.mock('@kilocode/web-shared/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/model-allow.server', () => ({
  isModelRestrictionExempt: jest.fn(async () => false),
  getModelInferenceProviders: jest.fn(async () => undefined),
}));
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelPolicy: jest.fn(async () => ({
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
  })),
  isModelRouteAllowed: jest.fn(),
}));

const mockedSelect = jest.mocked(readDb.select);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedIsModelRouteAllowed = jest.mocked(isModelRouteAllowed);

const SNAPSHOT_TTL_MS = 600_000;

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

function mockSnapshotRow(rows: Array<{ data: typeof snapshot }>) {
  const query = {
    from: () => query,
    orderBy: () => query,
    limit: async () => rows,
  };
  mockedSelect.mockReturnValue(query as never);
}

// The snapshot cache lives for the lifetime of the handler module, so each test
// starts past the previous test's TTL instead of clearing module state.
let clockMs = 0;

describe('catalog snapshot cache shared by both handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clockMs += 10 * SNAPSHOT_TTL_MS;
    jest.spyOn(Date, 'now').mockReturnValue(clockMs);
    mockSnapshotRow([{ data: snapshot }]);
    mockedGetUserFromAuth.mockRejectedValue(new Error('unauthenticated'));
    mockedIsModelRouteAllowed.mockImplementation(async (_policy, _modelId, providerSlug) =>
      Boolean(providerSlug === 'alpha')
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('serves repeated requests to both handlers from one snapshot read', async () => {
    const modelsBody = await handleModelsByProviderRequest().then(response => response.json());
    await handleModelsByProviderRequest();
    const providersBody = await handleProvidersRequest().then(response => response.json());

    expect(mockedSelect).toHaveBeenCalledTimes(1);
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
    await handleModelsByProviderRequest();
    jest.spyOn(Date, 'now').mockReturnValue(clockMs + SNAPSHOT_TTL_MS + 1);

    await handleProvidersRequest();

    expect(mockedSelect).toHaveBeenCalledTimes(2);
  });

  test('never stores an organization-filtered body in the shared cache', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: 'org-1',
    } as never);

    const orgResponse = await handleModelsByProviderRequest();
    const orgBody = await orgResponse.json();
    const providersBody = await handleProvidersRequest().then(response => response.json());

    expect(orgResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(orgBody.providers.map((entry: { slug: string }) => entry.slug)).toEqual(['alpha']);
    expect(providersBody.data.map((entry: { slug: string }) => entry.slug)).toEqual(
      expect.arrayContaining(['alpha', 'beta', 'gamma'])
    );
    expect(mockedSelect).toHaveBeenCalledTimes(1);
  });

  test('answers 503 from the providers endpoint when the snapshot row is missing', async () => {
    mockSnapshotRow([]);

    const response = await handleProvidersRequest();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Service Unavailable',
      message: 'Providers data not yet available',
    });
  });
});
