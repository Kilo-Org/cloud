import { beforeEach, describe, expect, test } from '@jest/globals';
import type { Organization } from '@kilocode/db/schema';
import type { EnabledByokProvider } from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  getByokCredentials,
  getEnabledByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import {
  getDirectByokCatalogModelId,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import {
  getAllowedDirectByokCatalogModelIds,
  modelsServedByOrganizationInferenceProviderUserByok,
} from '@kilocode/web-shared/lib/ai-gateway/byok/organization-inference-provider-user-byok';
import { isModelAllowedForProviderKey } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import type { ModelStatsLoadClient } from '@kilocode/web-shared/lib/model-stats/model-stats-cache';
import type { readDb } from '@kilocode/web-shared/lib/drizzle';
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
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  getByokCredentials: jest.fn(),
  getEnabledByokProviders: jest.fn(async () => []),
}));
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/byok/organization-inference-provider-user-byok',
  () => ({
    getAllowedDirectByokCatalogModelIds: jest.fn(async () => new Set()),
    modelsServedByOrganizationInferenceProviderUserByok: jest.fn(async () => []),
  })
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  formatDirectByokModelId: (provider: { id: string }, model: { id: string }) =>
    `${provider.id}/${model.id}`.toLowerCase(),
  getDirectByokModel: jest.fn(async () => null),
  getDirectByokCatalogModelId: jest.fn(),
  getDirectByokModelChatApis: () => ['chat_completions'],
  supportsCatalogMode: (providerId: string) => providerId === 'synthetic',
}));

const mockedPolicyContext = jest.fn();
jest.mock(
  '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server',
  () => ({
    getOrganizationGroupPolicyContext: (...args: unknown[]) => mockedPolicyContext(...args),
  })
);

function policyContext(defaultPolicies: unknown[] = []) {
  return {
    organization: { id: 'org-1', plan: 'enterprise', settings: {} },
    defaultPolicies,
    groups: [],
    policyRevision: 1,
  };
}

const mockedGetDirectByokModel = jest.mocked(getDirectByokModel);
const mockedGetCatalogModelId = jest.mocked(getDirectByokCatalogModelId);
const mockedGetEnabledByokProviders = jest.mocked(getEnabledByokProviders);

function organization(settings: Organization['settings'] = {}) {
  return { id: 'org-1', plan: 'enterprise' as const, settings };
}

function key(serveCatalogModels: boolean): EnabledByokProvider {
  return { providerId: 'synthetic', serveCatalogModels };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedPolicyContext.mockResolvedValue(policyContext());
  mockedGetDirectByokModel.mockImplementation(async modelId =>
    modelId.startsWith('synthetic/')
      ? {
          provider: { id: 'synthetic' } as never,
          model: { id: modelId.slice('synthetic/'.length) } as never,
        }
      : null
  );
  jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({
    data: [{ id: 'moonshotai/kimi-k2.6' }],
  } as never);
});

describe('validateOrganizationAutoTarget catalog load client', () => {
  const mockedCatalog = getEnhancedOpenRouterModels as unknown as jest.Mock<
    (options: { countryCode: string | null; fromDb?: object }) => Promise<unknown>
  >;

  test('reads the catalog through the replica client the seam names', async () => {
    const replica = { select: jest.fn() } as unknown as ModelStatsLoadClient;

    await expect(
      validateOrganizationAutoTarget(organization(), 'moonshotai/kimi-k2.6', {
        read: { fromDb: replica as typeof readDb },
      })
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
    expect(mockedCatalog).toHaveBeenCalledWith({ countryCode: null, fromDb: replica });
  });

  test('keeps the primary default inside a transaction', async () => {
    const tx = { select: jest.fn() } as never;

    await expect(
      validateOrganizationAutoTarget(organization(), 'moonshotai/kimi-k2.6', {
        read: { tx },
      })
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
    expect(mockedCatalog).toHaveBeenCalledWith({ countryCode: null, fromDb: undefined });
  });

  test('keeps the catalog primary default when no options are passed', async () => {
    await expect(
      validateOrganizationAutoTarget(organization(), 'moonshotai/kimi-k2.6')
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
    expect(mockedCatalog).toHaveBeenCalledWith({ countryCode: null, fromDb: undefined });
  });

  test('propagates the client through a catalog-id recursion', async () => {
    mockedGetEnabledByokProviders.mockResolvedValue([key(true)]);
    mockedGetCatalogModelId.mockResolvedValue('moonshotai/kimi-k2.6');
    const replica = { select: jest.fn() } as unknown as ModelStatsLoadClient;

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6', {
        read: { fromDb: replica as typeof readDb },
      })
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
    expect(mockedCatalog).toHaveBeenCalledWith({ countryCode: null, fromDb: replica });
  });
});

describe('validateOrganizationAutoTarget with auto tier targets', () => {
  const autoTierRejection = {
    kind: 'error',
    message: expect.stringContaining('cannot use an auto tier'),
  };

  test('accepts an auto tier when the organization has no model policy', async () => {
    await expect(
      validateOrganizationAutoTarget(organization(), 'kilo-auto/balanced')
    ).resolves.toEqual({ kind: 'ok', modelId: 'kilo-auto/balanced' });
    await expect(
      validateOrganizationAutoTarget(
        organization({ disable_new_models: false }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'kilo-auto/balanced' });
  });

  test('accepts an auto tier for an enterprise organization that disables new models', async () => {
    await expect(
      validateOrganizationAutoTarget(
        organization({ disable_new_models: true }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'kilo-auto/balanced' });
  });

  test('accepts an auto tier under the policy once it filled the deny list', async () => {
    await expect(
      validateOrganizationAutoTarget(
        organization({ disable_new_models: true, model_deny_list: ['z-ai/glm-5.1'] }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'kilo-auto/balanced' });
  });

  test('rejects an auto tier under the policy when there is a provider allow list', async () => {
    await expect(
      validateOrganizationAutoTarget(
        organization({ disable_new_models: true, provider_allow_list: ['openai'] }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual(autoTierRejection);
    await expect(
      validateOrganizationAutoTarget(
        organization({
          disable_new_models: true,
          provider_allow_list: ['openai'],
          model_deny_list: ['z-ai/glm-5.1'],
        }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual(autoTierRejection);
  });

  test('still rejects an auto tier for a model deny list or provider allow list', async () => {
    await expect(
      validateOrganizationAutoTarget(
        organization({ model_deny_list: ['openai/gpt-4o'] }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual(autoTierRejection);
    await expect(
      validateOrganizationAutoTarget(
        organization({ provider_allow_list: ['openai'] }),
        'kilo-auto/balanced'
      )
    ).resolves.toEqual(autoTierRejection);
  });

  test('ignores the policy for an organization outside Enterprise', async () => {
    await expect(
      validateOrganizationAutoTarget(
        { id: 'org-1', plan: 'teams', settings: { disable_new_models: true } },
        'kilo-auto/balanced'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'kilo-auto/balanced' });
  });

  test('accepts a concrete model for an organization that disables new models', async () => {
    await expect(
      validateOrganizationAutoTarget(
        organization({ disable_new_models: true }),
        'moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
  });
});

describe('validateOrganizationAutoTarget with direct BYOK targets', () => {
  test('keeps a bespoke target of a key outside catalog mode', async () => {
    mockedGetEnabledByokProviders.mockResolvedValue([key(false)]);

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6')
    ).resolves.toEqual({ kind: 'ok', modelId: 'synthetic/hf:moonshotai/kimi-k2.6' });
    expect(mockedGetEnabledByokProviders).toHaveBeenCalledWith(expect.anything(), {
      type: 'organization',
      id: 'org-1',
    });
  });

  test('validates without decrypting any key', async () => {
    mockedGetEnabledByokProviders.mockResolvedValue([key(false)]);

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6', {
        apiKind: 'chat_completions',
      })
    ).resolves.toEqual({ kind: 'ok', modelId: 'synthetic/hf:moonshotai/kimi-k2.6' });
    expect(jest.mocked(getByokCredentials)).not.toHaveBeenCalled();
  });

  test('rejects a target when the organization has no enabled key for its provider', async () => {
    mockedGetEnabledByokProviders.mockResolvedValue([]);

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6')
    ).resolves.toEqual({
      kind: 'error',
      message:
        "Organization Auto route target 'synthetic/hf:moonshotai/kimi-k2.6' is unavailable because this organization does not have an enabled BYOK credential for synthetic.",
    });
  });

  test('resolves a bespoke target of a catalog-mode key to its catalog id', async () => {
    mockedGetEnabledByokProviders.mockResolvedValue([key(true)]);
    mockedGetCatalogModelId.mockResolvedValue('moonshotai/kimi-k2.6');

    await expect(
      validateOrganizationAutoTarget(organization(), 'synthetic/hf:moonshotai/kimi-k2.6')
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
  });

  test('checks API support of the key before resolving the catalog id', async () => {
    mockedGetEnabledByokProviders.mockResolvedValue([key(true)]);
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
    mockedGetEnabledByokProviders.mockResolvedValue([key(true)]);
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
    mockedGetEnabledByokProviders.mockResolvedValue([key(true)]);
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

describe('validateOrganizationAutoTarget with organization inference provider keys', () => {
  const mockedServedModels = jest.mocked(modelsServedByOrganizationInferenceProviderUserByok);
  const notAllowed = {
    kind: 'error',
    message:
      "Organization Auto route target 'moonshotai/kimi-k2.6' is not allowed by the organization's model policy.",
  };

  beforeEach(() => {
    mockedServedModels.mockReset().mockResolvedValue([]);
  });

  test('accepts a model outside the provider allow-list that an inference provider key serves', async () => {
    mockedServedModels.mockResolvedValue(['moonshotai/kimi-k2.6']);

    await expect(
      validateOrganizationAutoTarget(
        organization({ provider_allow_list: ['anthropic'] }),
        'moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
    expect(mockedServedModels).toHaveBeenCalledWith('org-1', ['moonshotai/kimi-k2.6']);
  });

  test('accepts a model outside the provider allow-list that the default policy explicitly grants', async () => {
    mockedPolicyContext.mockResolvedValue(
      policyContext([
        {
          type: 'model_access',
          data: {
            mode: 'selected',
            model_allow_list: ['moonshotai/kimi-k2.6'],
            provider_allow_list: [],
          },
        },
      ])
    );

    await expect(
      validateOrganizationAutoTarget(
        organization({ provider_allow_list: ['anthropic'] }),
        'moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
    expect(mockedPolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', subject: { type: 'defaultAccess' } })
    );
  });

  test('evaluates the default policy against the settings being validated', async () => {
    mockedPolicyContext.mockResolvedValue(
      policyContext([{ type: 'model_access', data: { mode: 'all' } }])
    );

    await expect(
      validateOrganizationAutoTarget(
        organization({ provider_allow_list: ['anthropic'] }),
        'moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual(notAllowed);
  });

  test('rejects a model outside the provider allow-list without such a key', async () => {
    await expect(
      validateOrganizationAutoTarget(
        organization({ provider_allow_list: ['anthropic'] }),
        'moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual(notAllowed);
  });

  test('keeps the model deny list for models such a key serves', async () => {
    mockedServedModels.mockResolvedValue(['moonshotai/kimi-k2.6']);

    await expect(
      validateOrganizationAutoTarget(
        organization({
          provider_allow_list: ['anthropic'],
          model_deny_list: ['moonshotai/kimi-k2.6'],
        }),
        'moonshotai/kimi-k2.6'
      )
    ).resolves.toEqual(notAllowed);
    expect(mockedServedModels).not.toHaveBeenCalled();
  });

  describe('with a catalog-mode direct BYOK key serving the model through Z.AI', () => {
    beforeEach(() => {
      jest
        .mocked(getAllowedDirectByokCatalogModelIds)
        .mockImplementation(
          async (_organizationId, policy) =>
            new Set(
              (await isModelAllowedForProviderKey(policy, 'moonshotai/kimi-k2.6', 'z-ai'))
                ? ['moonshotai/kimi-k2.6']
                : []
            )
        );
    });

    test('accepts the model when the provider allow-list names the key provider', async () => {
      await expect(
        validateOrganizationAutoTarget(
          organization({ provider_allow_list: ['anthropic', 'z-ai'] }),
          'moonshotai/kimi-k2.6'
        )
      ).resolves.toEqual({ kind: 'ok', modelId: 'moonshotai/kimi-k2.6' });
      expect(getAllowedDirectByokCatalogModelIds).toHaveBeenCalledWith('org-1', expect.anything());
    });

    test('rejects the model when the provider allow-list does not name the key provider', async () => {
      await expect(
        validateOrganizationAutoTarget(
          organization({ provider_allow_list: ['anthropic'] }),
          'moonshotai/kimi-k2.6'
        )
      ).resolves.toEqual(notAllowed);
    });
  });
});
