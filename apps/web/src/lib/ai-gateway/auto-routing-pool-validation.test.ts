import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  annotatePoolAvailability,
  poolValidationMessage,
  validatePoolEntries,
  type EligibleCatalog,
} from './auto-routing-pool-validation';

jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
  getDirectByokModelsForOrganization: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/models', () => ({
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

const { getEnhancedOpenRouterModels } = jest.requireMock('@/lib/ai-gateway/providers/openrouter');
const { listAvailableExperimentModels } = jest.requireMock(
  '@/lib/ai-gateway/experiments/list-available-experiment-models'
);
const { getDirectByokModelsForUser, getDirectByokModelsForOrganization } = jest.requireMock(
  '@/lib/ai-gateway/providers/direct-byok'
);
const { getAvailableModelsForOrganization } = jest.requireMock(
  '@/lib/organizations/organization-models'
);

const mockedGetEnhanced = jest.mocked(getEnhancedOpenRouterModels);
const mockedListExperiments = jest.mocked(listAvailableExperimentModels);
const mockedGetByokUser = jest.mocked(getDirectByokModelsForUser);
const mockedGetByokOrg = jest.mocked(getDirectByokModelsForOrganization);
const mockedGetOrgModels = jest.mocked(getAvailableModelsForOrganization);

function model(id: string, variants?: Record<string, { reasoning?: { enabled: boolean } }>) {
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
    mockedListExperiments.mockResolvedValue([]);
    mockedGetByokUser.mockResolvedValue([]);
    mockedGetByokOrg.mockResolvedValue([]);
  });

  describe('validatePoolEntries', () => {
    test('accepts eligible managed model with required catalog variant', async () => {
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
        entries: [{ model: 'anthropic/claude-sonnet-4', variant: ' high ' }],
      });

      expect(result).toEqual({
        ok: true,
        entries: [{ model: 'anthropic/claude-sonnet-4', variant: 'high' }],
      });
    });

    test('accepts model with no variants when variant is null', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('google/gemini-2.5-flash')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'google/gemini-2.5-flash', variant: null }],
      });

      expect(result).toEqual({
        ok: true,
        entries: [{ model: 'google/gemini-2.5-flash', variant: null }],
      });
    });

    test('allows same model with different variants', async () => {
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
        entries: [
          { model: 'anthropic/claude-sonnet-4', variant: 'low' },
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
        ],
      });

      expect(result.ok).toBe(true);
    });

    test('rejects virtual auto model ids', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('kilo-auto/efficient')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'kilo-auto/efficient', variant: null }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'virtual_model',
          message: poolValidationMessage('virtual_model'),
        }),
      });
    });

    test('rejects active experiment model ids', async () => {
      mockedGetEnhanced.mockResolvedValue({ data: [model('openrouter/base')] });
      mockedListExperiments.mockResolvedValue([model('experiment/active-model')]);

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'experiment/active-model', variant: null }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'experiment_model',
          message: poolValidationMessage('experiment_model'),
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
        entries: [{ model: 'kilo/hidden-model', variant: null }],
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
        entries: [{ model: 'openai-codex/gpt-5', variant: null }],
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
        entries: [{ model: 'openai/gpt-4o', variant: null }],
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
        entries: [{ model: 'totally/unknown', variant: null }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'unknown_model',
          message: poolValidationMessage('unknown_model'),
        }),
      });
    });

    test('rejects missing variant when model exposes variants', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('anthropic/claude-sonnet-4', { high: {} })],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'anthropic/claude-sonnet-4', variant: null }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'missing_variant',
          message: poolValidationMessage('missing_variant'),
        }),
      });
    });

    test('rejects unknown variant keys', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('anthropic/claude-sonnet-4', { high: {} })],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'anthropic/claude-sonnet-4', variant: 'max' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'unknown_variant',
          message: poolValidationMessage('unknown_variant'),
        }),
      });
    });

    test('rejects unexpected variant when model exposes none', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('google/gemini-2.5-flash')],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [{ model: 'google/gemini-2.5-flash', variant: 'high' }],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'unexpected_variant',
          message: poolValidationMessage('unexpected_variant'),
        }),
      });
    });

    test('rejects duplicate exact pairs', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('anthropic/claude-sonnet-4', { high: {} })],
      });

      const result = await validatePoolEntries({
        user: { id: 'user-1' },
        organizationId: null,
        entries: [
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
        ],
      });

      expect(result).toEqual({
        ok: false,
        error: expect.objectContaining({
          reason: 'duplicate_pair',
          message: poolValidationMessage('duplicate_pair'),
        }),
      });
    });

    test('rejects more than 10 entries', async () => {
      mockedGetEnhanced.mockResolvedValue({
        data: [model('google/gemini-2.5-flash')],
      });

      // Length is checked before catalog/duplicate logic.
      const entries = Array.from({ length: 11 }, () => ({
        model: 'google/gemini-2.5-flash',
        variant: null as null,
      }));

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
            variantKeys: new Set(['high', 'low']),
          },
        ],
        [
          'google/gemini-2.5-flash',
          {
            id: 'google/gemini-2.5-flash',
            variantKeys: null,
          },
        ],
      ]),
      experimentIds: new Set(),
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
          { model: 'anthropic/claude-sonnet-4', variant: 'high' },
          { model: 'anthropic/claude-sonnet-4', variant: 'max' },
          { model: 'removed/model', variant: null },
          { model: 'google/gemini-2.5-flash', variant: null },
        ],
      });

      expect(annotated).toEqual([
        { model: 'anthropic/claude-sonnet-4', variant: 'high', unavailable: false },
        { model: 'anthropic/claude-sonnet-4', variant: 'max', unavailable: true },
        { model: 'removed/model', variant: null, unavailable: true },
        { model: 'google/gemini-2.5-flash', variant: null, unavailable: false },
      ]);
    });
  });
});
