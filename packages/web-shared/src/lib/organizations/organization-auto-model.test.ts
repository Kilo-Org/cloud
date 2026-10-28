import { beforeEach, describe, expect, test } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import type { ByokCredential } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { getByokCredentials } from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  getDirectByokCatalogModelId,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { validateOrganizationAutoTarget } from './organization-auto-model';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: {} }));
jest.mock('@kilocode/web-shared/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-routers', () => ({
  findCustomRouter: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog', () => ({
  isCustomLlm: jest.fn(async () => false),
  findCustomLlm: jest.fn(async () => null),
  getPublicCustomLlmInferenceProviders: jest.fn(async () => undefined),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    getProviderSlugsForModel: jest.fn(async () => new Set(['moonshotai'])),
  })
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({ getByokCredentials: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  formatDirectByokModelId: (provider: { id: string }, model: { id: string }) =>
    `${provider.id}/${model.id}`.toLowerCase(),
  getDirectByokModel: jest.fn(async () => ({ provider: null, model: null })),
  getDirectByokCatalogModelId: jest.fn(),
  supportsCatalogMode: (providerId: string) => providerId === 'synthetic',
}));

const mockedGetDirectByokModel = jest.mocked(getDirectByokModel);
const mockedGetCatalogModelId = jest.mocked(getDirectByokCatalogModelId);
const mockedGetByokCredentials = jest.mocked(getByokCredentials);

function organization(settings: Organization['settings'] = {}) {
  return { id: 'org-1', plan: 'enterprise' as const, settings };
}

function credential(serveCatalogModels: boolean): ByokCredential {
  return { decryptedAPIKey: 'synthetic-key', providerId: 'synthetic', serveCatalogModels };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetDirectByokModel.mockImplementation(async modelId =>
    modelId.startsWith('synthetic/')
      ? {
          provider: {
            id: 'synthetic',
            resolveUpstream: async () => ({ supportedChatApis: ['chat_completions'] }),
          } as never,
          model: { id: modelId.slice('synthetic/'.length) } as never,
        }
      : { provider: null, model: null }
  );
  jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
    data: [{ id: 'moonshotai/kimi-k2.6' }],
  } as never);
});

describe('validateOrganizationAutoTarget with direct BYOK targets', () => {
  test('keeps a bespoke target of a key outside catalog mode', async () => {
    mockedGetByokCredentials.mockResolvedValue([credential(false)]);

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6')
    ).resolves.toEqual({ kind: 'ok', modelId: 'synthetic/hf:moonshotai/kimi-k2.6' });
    expect(mockedGetByokCredentials).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'organization', id: 'org-1' },
      ['synthetic']
    );
  });

  test('resolves a bespoke target of a catalog-mode key to its catalog id', async () => {
    mockedGetByokCredentials.mockResolvedValue([credential(true)]);
    mockedGetCatalogModelId.mockResolvedValue('moonshotai/kimi-k2.6');

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6')
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
  });

  test('checks API support of the key before resolving the catalog id', async () => {
    mockedGetByokCredentials.mockResolvedValue([credential(true)]);
    mockedGetCatalogModelId.mockResolvedValue('moonshotai/kimi-k2.6');

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6', {
        apiKind: 'messages',
      })
    ).resolves.toEqual({
      kind: 'error',
      message:
        "Organization Auto route target 'synthetic/hf:moonshotai/kimi-k2.6' does not support the messages API.",
    });
  });

  test('applies the model policy to the catalog id', async () => {
    mockedGetByokCredentials.mockResolvedValue([credential(true)]);
    mockedGetCatalogModelId.mockResolvedValue('moonshotai/kimi-k2.6');

    await expect(
      validateOrganizationAutoTarget(
        organization({ model_deny_list: ['moonshotai/kimi-k2.6'] }),
        'synthetic/hf:moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual({
      kind: 'error',
      message:
        "Organization Auto route target 'moonshotai/kimi-k2.6' is not allowed by the organization's model policy.",
    });
  });

  test('rejects a bespoke target without a catalog id when the key serves catalog ids', async () => {
    mockedGetByokCredentials.mockResolvedValue([credential(true)]);
    mockedGetCatalogModelId.mockResolvedValue(null);

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:example/finetune')
    ).resolves.toEqual({
      kind: 'error',
      message:
        "Organization Auto route target 'synthetic/hf:example/finetune' is unavailable because this organization's synthetic key uses Kilo catalog model IDs and this model has no catalog ID.",
    });
  });
});
