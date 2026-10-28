import { beforeEach, describe, expect, test } from '@jest/globals';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getProviderSlugsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  resolveOrganizationMemberModelPolicy,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { handleModelsByProviderRequest } from './models-by-provider';

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
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({ getProviderSlugsForModel: jest.fn() })
);
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  ...(jest.requireActual(
    '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server'
  ) as Record<string, unknown>),
  resolveOrganizationMemberModelPolicy: jest.fn(),
}));

const mockedSelect = jest.mocked(readDb.select);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedProviderLookup = jest.mocked(getProviderSlugsForModel);
const mockedResolvePolicy = jest.mocked(resolveOrganizationMemberModelPolicy);

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

function mockSnapshot() {
  const query = {
    from: () => query,
    orderBy: () => query,
    limit: async () => [{ id: 1, data: snapshot }],
  };
  mockedSelect.mockReturnValue(query as never);
}

describe('handleModelsByProviderRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSnapshot();
    mockedProviderLookup.mockImplementation(
      async modelId => new Set(providersByModel[modelId] ?? [])
    );
    mockedResolvePolicy.mockImplementation(async () => policy);
  });

  test('returns the shared catalog for callers without an organization', async () => {
    mockedGetUserFromAuth.mockRejectedValue(new Error('unauthenticated'));

    const response = await handleModelsByProviderRequest();

    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(mockedResolvePolicy).not.toHaveBeenCalled();
  });

  test('filters organization callers to allowed provider routes', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: 'user-1' },
      organizationId: 'org-1',
    } as never);

    const response = await handleModelsByProviderRequest();

    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockedResolvePolicy).toHaveBeenCalledTimes(1);
    const [policyArgs] = mockedResolvePolicy.mock.calls[0] ?? [];
    expect(policyArgs?.organizationId).toBe('org-1');
    expect(policyArgs?.kiloUserId).toBe('user-1');
    expect(policyArgs?.fromDb).toBe(readDb);
    await expect(response.json()).resolves.toEqual({
      providers: [
        { slug: 'alpha', models: [model('open/model'), model('routed/model')] },
        { slug: 'beta', models: [model('open/model')] },
        { slug: 'freeonly', models: [model('free/model', 'free')] },
      ],
      total_providers: 3,
      total_models: 4,
    });
    expect(mockedProviderLookup).toHaveBeenCalledWith('free/model:free');
    expect(mockedProviderLookup).not.toHaveBeenCalledWith('free/model');
  });
});
