import { beforeEach, describe, expect, test } from '@jest/globals';
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationDefaultModelPolicy: jest.fn(),
  getEffectiveModelDecision: jest.fn(),
}));

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
    {
      public_id: 'kilo/hidden-model',
      status: 'hidden',
    },
    {
      public_id: 'kilo/public-model',
      status: 'public',
    },
  ],
}));
import {
  annotatePoolAvailability,
  poolValidationMessage,
  toApiSettingsResponse,
  toLegacyModeApiSettingsResponse,
  validatePoolEntries,
  validateFrontierFallback,
  type EligibleCatalog,
} from './auto-routing-pool-validation';

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

function model(
  id: string,
  variants?: Record<string, { reasoning?: { enabled: boolean; effort?: string } }>
) {
  return {
    id,
    name: id,
    created: 0,
    description: id,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
    },
    top_provider: { is_moderated: false, context_length: 100_000 },
    pricing: {
      prompt: '0',
      completion: '0',
    },
    context_length: 100_000,
    ...(variants ? { opencode: { variants } } : {}),
  };
}

describe('auto-routing-pool-validation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetByokUser.mockResolvedValue([]);
    mockedGetByokOrg.mockResolvedValue([]);
  });

  describe('validateFrontierFallback', () => {
    test('preserves the exact concrete catalog reasoning variant', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [
          model('anthropic/claude-sonnet-4', {
            medium: { reasoning: { enabled: true, effort: 'medium' } },
            high: { reasoning: { enabled: true, effort: 'high' } },
          }),
        ],
      });
      expect(
        await validateFrontierFallback({
          user: { id: 'user-1' },
          organizationId: null,
          entry: { model: 'anthropic/claude-sonnet-4', variant: 'medium' },
        })
      ).toEqual({
        ok: true,
        entry: { model: 'anthropic/claude-sonnet-4', variant: 'medium' },
      });
    });

    test('requires an exact effort when the model has reasoning variants', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [
          model('anthropic/claude-sonnet-4', {
            medium: { reasoning: { enabled: true, effort: 'medium' } },
          }),
        ],
      });
      expect(
        await validateFrontierFallback({
          user: { id: 'user-1' },
          organizationId: null,
          entry: { model: 'anthropic/claude-sonnet-4', variant: null },
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ reason: 'invalid_variant' }),
      });
    });

    test('rejects a model disallowed by the organization policy', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [
          model('anthropic/claude-sonnet-4', {
            medium: { reasoning: { enabled: true, effort: 'medium' } },
          }),
        ],
      });
      const baselineAccess = jest.requireMock(
        '@kilocode/web-shared/lib/organizations/effective-model-access.server'
      );
      baselineAccess.resolveOrganizationDefaultModelPolicy.mockResolvedValue({
        requireModelInCurrentSnapshot: true,
      });
      baselineAccess.getEffectiveModelDecision.mockResolvedValue({ allowed: false });
      expect(
        await validateFrontierFallback({
          user: { id: 'user-1' },
          organizationId: 'org-1',
          entry: { model: 'anthropic/claude-sonnet-4', variant: 'medium' },
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ reason: 'organization_denied_model' }),
      });
      expect(baselineAccess.getEffectiveModelDecision).toHaveBeenCalledWith(
        expect.objectContaining({ memberGrant: { mode: 'organization_baseline' } }),
        'anthropic/claude-sonnet-4'
      );
    });

    test('allows organization baseline models without inheriting default-member grants', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [
          model('anthropic/claude-sonnet-4', {
            medium: { reasoning: { enabled: true, effort: 'medium' } },
          }),
        ],
      });
      const baselineAccess = jest.requireMock(
        '@kilocode/web-shared/lib/organizations/effective-model-access.server'
      );
      baselineAccess.resolveOrganizationDefaultModelPolicy.mockResolvedValue({
        requireModelInCurrentSnapshot: true,
        memberGrant: { mode: 'restricted', modelIds: [] },
      });
      baselineAccess.getEffectiveModelDecision.mockResolvedValue({ allowed: true });
      expect(
        await validateFrontierFallback({
          user: { id: 'user-1' },
          organizationId: 'org-1',
          entry: { model: 'anthropic/claude-sonnet-4', variant: 'medium' },
        })
      ).toEqual({
        ok: true,
        entry: { model: 'anthropic/claude-sonnet-4', variant: 'medium' },
      });
      expect(mockedGetOrgModels).not.toHaveBeenCalled();
    });

    test('rejects unsupported reasoning variants for non-reasoning models', async () => {
      mockedGetEnhanced.mockResolvedValue({ data: [model('google/gemini-2.5-flash')] });
      expect(
        await validateFrontierFallback({
          user: { id: 'user-1' },
          organizationId: null,
          entry: { model: 'google/gemini-2.5-flash', variant: 'medium' },
        })
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ reason: 'invalid_variant' }),
      });
    });
  });

  describe('validatePoolEntries', () => {
    test('accepts eligible managed model whose efforts come from the catalog', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [
          model('anthropic/claude-sonnet-4', {
            low: { reasoning: { enabled: true } },
            high: { reasoning: { enabled: true } },
          }),
        ],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'anthropic/claude-sonnet-4' }],
      });

      expect(result).toEqual({
        ok: true,
        entries: [{ model: 'anthropic/claude-sonnet-4' }],
      });
    });

    test('accepts a model with no reasoning variants', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('google/gemini-2.5-flash')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'google/gemini-2.5-flash' }],
      });

      expect(result).toEqual({
        ok: true,
        entries: [{ model: 'google/gemini-2.5-flash' }],
      });
    });

    test('rejects duplicate models even when they support multiple efforts', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [
          model('anthropic/claude-sonnet-4', {
            low: {},
            high: {},
          }),
        ],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'anthropic/claude-sonnet-4' }, { model: 'anthropic/claude-sonnet-4' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({ reason: 'duplicate_model' }),
      });
    });

    test('rejects virtual auto model ids', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('kilo-auto/efficient')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'kilo-auto/efficient' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'virtual_model',
          message: poolValidationMessage('virtual_model'),
        }),
      });
    });

    test('rejects hidden exclusive models', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('kilo/hidden-model')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'kilo/hidden-model' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'hidden_model',
          message: poolValidationMessage('hidden_model'),
        }),
      });
    });

    test('rejects direct BYOK-only model ids', async () => {
      mockedGetEnhanced.mockResolvedValue({ data: [model('openrouter/base')] });
      mockedGetByokUser.mockResolvedValue([model('openai-codex/gpt-5')]);

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'openai-codex/gpt-5' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'byok_only_model',
          message: poolValidationMessage('byok_only_model'),
        }),
      });
    });

    test('rejects organization-denied models with a specific reason', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('openai/gpt-4o'), model('anthropic/claude-sonnet-4')],
      });
      mockedGetOrgModels.mockResolvedValue({
        data: [model('anthropic/claude-sonnet-4')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: 'org-1',
        entries: [{ model: 'openai/gpt-4o' }],
      });

      expect(mockedGetByokOrg).toHaveBeenCalledWith('org-1');
      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'organization_denied_model',
          message: poolValidationMessage('organization_denied_model'),
        }),
      });
    });

    test('rejects unknown models', async () => {
      mockedGetEnhanced.mockResolvedValue({ data: [model('openrouter/base')] });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'totally/unknown' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'unknown_model',
          message: poolValidationMessage('unknown_model'),
        }),
      });
    });

    test('rejects duplicate models', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('anthropic/claude-sonnet-4', { high: {} })],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'anthropic/claude-sonnet-4' }, { model: 'anthropic/claude-sonnet-4' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'duplicate_model',
          message: poolValidationMessage('duplicate_model'),
        }),
      });
    });

    test('rejects more than 10 entries', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('google/gemini-2.5-flash')],
      });

      // Length is checked before catalog/duplicate logic.
      const entries = Array.from({ length: 11 }, () => ({ model: 'google/gemini-2.5-flash' }));

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries,
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'too_many_entries',
          message: poolValidationMessage('too_many_entries'),
        }),
      });
    });

    test('rejects empty pool arrays', async () => {
      mockedGetEnhanced.mockResolvedValue({ data: [] });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'empty_pool',
          message: poolValidationMessage('empty_pool'),
        }),
      });
    });
  });

  describe('annotatePoolAvailability', () => {
    const catalog: EligibleCatalog = {
      byId: new Map([
        [
          'anthropic/claude-sonnet-4',
          {
            id: 'anthropic/claude-sonnet-4',
          },
        ],
        [
          'google/gemini-2.5-flash',
          {
            id: 'google/gemini-2.5-flash',
          },
        ],
      ]),
      byokOnlyIds: new Set(),
      managedIds: new Set(['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash']),
      ownerCatalogIds: new Set(['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash']),
      organizationId: null,
    };

    test('marks null configured pool as null', () => {
      expect(annotatePoolAvailability({ entries: null, catalog })).toBeNull();
    });

    test('marks still-eligible entries available and departed ones unavailable', () => {
      const annotated = annotatePoolAvailability({
        catalog,
        entries: [
          { model: 'anthropic/claude-sonnet-4' },
          { model: 'removed/model' },
          { model: 'google/gemini-2.5-flash' },
        ],
      });

      expect(annotated).toEqual([
        { model: 'anthropic/claude-sonnet-4', unavailable: false },
        { model: 'removed/model', unavailable: true },
        { model: 'google/gemini-2.5-flash', unavailable: false },
      ]);
    });
  });

  describe('toApiSettingsResponse / toLegacyModeApiSettingsResponse', () => {
    test('toApiSettingsResponse includes poolSupported: true', () => {
      const response = toApiSettingsResponse(
        {
          ownerType: 'user',
          ownerId: 'user-1',
          mode: 'cost_per_accuracy',
          configuredMode: null,
          defaultMode: 'cost_per_accuracy',
          configuredPool: null,
          poolStatuses: [],
        },
        null
      );
      expect(response.poolSupported).toBe(true);
      expect(response).toEqual(
        expect.objectContaining({
          ownerType: 'user',
          ownerId: 'user-1',
          configuredPool: null,
          poolSupported: true,
        })
      );
    });

    test('toLegacyModeApiSettingsResponse synthesizes poolSupported: false', () => {
      expect(
        toLegacyModeApiSettingsResponse({
          ownerType: 'user',
          ownerId: 'user-1',
          mode: 'best_accuracy',
          configuredMode: 'best_accuracy',
          defaultMode: 'cost_per_accuracy',
        })
      ).toEqual({
        ownerType: 'user',
        ownerId: 'user-1',
        mode: 'best_accuracy',
        configuredMode: 'best_accuracy',
        defaultMode: 'cost_per_accuracy',
        configuredPool: null,
        poolStatuses: [],
        poolSupported: false,
      });
    });
  });
});
