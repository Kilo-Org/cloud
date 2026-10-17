import { beforeEach, describe, expect, test } from '@jest/globals';
import { CUSTOM_LLM_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { buildEligibleCatalog } from './auto-routing-pool-validation';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
  getDirectByokModelsForOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models', () => ({
  kiloExclusiveModels: [
    { public_id: 'kilo/hidden-model', status: 'hidden' },
    { public_id: 'kilo/public-model', status: 'public' },
  ],
}));

const { getEnhancedOpenRouterModels } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter'
);
const { getDirectByokModelsForUser, getDirectByokModelsForOrganization } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
);
const { getAvailableModelsForOrganization } = jest.requireMock(
  '@kilocode/web-shared/lib/organizations/organization-models'
);

const mockedGetEnhanced = jest.mocked(getEnhancedOpenRouterModels);
const mockedGetByokUser = jest.mocked(getDirectByokModelsForUser);
const mockedGetByokOrg = jest.mocked(getDirectByokModelsForOrganization);
const mockedGetOrgModels = jest.mocked(getAvailableModelsForOrganization);

function model(id: string) {
  return { id, name: id };
}

describe('buildEligibleCatalog', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetByokUser.mockResolvedValue([]);
    mockedGetByokOrg.mockResolvedValue([]);
  });

  test('excludes virtual, direct BYOK-only, custom LLM, and hidden exclusive models', async () => {
    mockedGetEnhanced.mockResolvedValue({
      data: [
        model('anthropic/claude-sonnet-4'),
        model('kilo-auto/efficient'),
        model('openai-codex/gpt-5'),
        model(`${CUSTOM_LLM_PREFIX}custom`),
        model('kilo/hidden-model'),
        model('kilo/public-model'),
      ],
    });
    mockedGetByokUser.mockResolvedValue([model('openai-codex/gpt-5')]);

    const catalog = await buildEligibleCatalog({ userId: 'user-1', organizationId: null });

    expect(mockedGetByokUser).toHaveBeenCalledWith('user-1');
    expect([...catalog.byId.keys()]).toEqual(['anthropic/claude-sonnet-4', 'kilo/public-model']);
    expect([...catalog.byokOnlyIds]).toEqual(['openai-codex/gpt-5']);
    expect(catalog.organizationId).toBeNull();
  });

  test('resolves an organization against its own catalog while keeping managed ids', async () => {
    mockedGetEnhanced.mockResolvedValue({
      data: [model('openai/gpt-4o'), model('anthropic/claude-sonnet-4')],
    });
    mockedGetOrgModels.mockResolvedValue({ data: [model('anthropic/claude-sonnet-4')] });

    const catalog = await buildEligibleCatalog({ userId: 'user-1', organizationId: 'org-1' });

    expect(mockedGetByokOrg).toHaveBeenCalledWith('org-1');
    expect(mockedGetByokUser).not.toHaveBeenCalled();
    expect(mockedGetOrgModels).toHaveBeenCalledWith('org-1', { type: 'defaultAccess' });
    expect([...catalog.byId.keys()]).toEqual(['anthropic/claude-sonnet-4']);
    expect([...catalog.managedIds]).toEqual(['openai/gpt-4o', 'anthropic/claude-sonnet-4']);
    expect([...catalog.ownerCatalogIds]).toEqual(['anthropic/claude-sonnet-4']);
    expect(catalog.organizationId).toBe('org-1');
  });
});
