import { beforeEach, describe, expect, test } from '@jest/globals';
import { getDefaultAllowedModel } from './model-allow-list';
import { getOrganizationById } from '@/lib/organizations/organizations';
import {
  getEffectiveModelDecision,
  resolveOrganizationDefaultModelPolicy,
} from '@/lib/organizations/effective-model-access.server';
import { getModelIdToProviderSlugsIndex } from '@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';

jest.mock('@/lib/organizations/organizations');
jest.mock('@/lib/organizations/effective-model-access.server');
jest.mock('@/lib/ai-gateway/providers/openrouter/models-by-provider-index.server');

const mockedGetOrganizationById = jest.mocked(getOrganizationById);
const mockedGetEffectiveModelDecision = jest.mocked(getEffectiveModelDecision);
const mockedResolveOrganizationDefaultModelPolicy = jest.mocked(
  resolveOrganizationDefaultModelPolicy
);
const mockedGetModelIdToProviderSlugsIndex = jest.mocked(getModelIdToProviderSlugsIndex);

describe('getDefaultAllowedModel', () => {
  beforeEach(() => {
    mockedGetOrganizationById.mockReset();
    mockedGetEffectiveModelDecision.mockReset();
    mockedResolveOrganizationDefaultModelPolicy.mockReset();
    mockedGetModelIdToProviderSlugsIndex.mockReset();
  });

  test('falls back to an allowed snapshot model for Enterprise', async () => {
    mockedGetOrganizationById.mockResolvedValue({ settings: {} } as never);
    mockedResolveOrganizationDefaultModelPolicy.mockResolvedValue({
      requireModelInCurrentSnapshot: true,
      organizationModelDenyList: [],
      memberGrant: { mode: 'unrestricted' },
      policyRevision: 0,
    });
    mockedGetEffectiveModelDecision.mockImplementation(async (_policy, modelId) => ({
      allowed: modelId === 'snapshot/fallback',
    }));
    mockedGetModelIdToProviderSlugsIndex.mockResolvedValue(
      new Map([['snapshot/fallback', new Set(['provider'])]])
    );

    await expect(getDefaultAllowedModel('organization-id')).resolves.toBe('snapshot/fallback');
  });

  test('returns null when Enterprise has no allowed snapshot model', async () => {
    mockedGetOrganizationById.mockResolvedValue({ settings: {} } as never);
    mockedResolveOrganizationDefaultModelPolicy.mockResolvedValue({
      requireModelInCurrentSnapshot: true,
      organizationModelDenyList: [],
      memberGrant: { mode: 'unrestricted' },
      policyRevision: 0,
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({ allowed: false });
    mockedGetModelIdToProviderSlugsIndex.mockResolvedValue(new Map());

    await expect(getDefaultAllowedModel('organization-id')).resolves.toBeNull();
  });
});
