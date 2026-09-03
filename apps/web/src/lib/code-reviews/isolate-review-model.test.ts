import type { User } from '@kilocode/db';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { appendLocalFakeDeterministicCatalogModels } from '@/lib/ai-gateway/local-fake-llm';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import {
  resolveIsolateReviewInference,
  resolveIsolateReviewInferenceFromCatalog,
  validateIsolateReviewInference,
} from './isolate-review-model';

jest.mock('@/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/local-fake-llm', () => ({
  appendLocalFakeDeterministicCatalogModels: jest.fn(),
}));
jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));

const user = { id: 'oauth/reviewer' } as User;
const variants = {
  none: { reasoning: { enabled: false, effort: 'none' } },
  low: { reasoning: { enabled: true, effort: 'low' }, verbosity: 'low' },
  medium: { reasoning: { enabled: true, effort: 'medium' }, verbosity: 'medium' },
  high: { reasoning: { enabled: true, effort: 'high' }, verbosity: 'high' },
  xhigh: { reasoning: { enabled: true, effort: 'xhigh' }, verbosity: 'xhigh' },
  max: { reasoning: { enabled: true, effort: 'max' }, verbosity: 'max' },
} as const;

function catalogModel(id = 'anthropic/claude-sonnet-5'): OpenRouterModel {
  return {
    id,
    name: id,
    created: 1,
    description: '',
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    pricing: { prompt: '0', completion: '0' },
    top_provider: { is_moderated: false, max_completion_tokens: 128_000 },
    context_length: 1_000_000,
    supported_parameters: ['tools', 'reasoning'],
    opencode: { ai_sdk_provider: 'anthropic', variants },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [catalogModel()] });
  jest.mocked(getDirectByokModelsForUser).mockResolvedValue([]);
  jest.mocked(listAvailableExperimentModels).mockResolvedValue([]);
  jest.mocked(appendLocalFakeDeterministicCatalogModels).mockImplementation(models => models);
  jest.mocked(getAvailableModelsForOrganization).mockResolvedValue({ data: [] });
});

describe('owner-scoped isolate model preparation', () => {
  it('resolves personal catalog settings using the execution owner, including non-UUID IDs', async () => {
    const inference = await resolveIsolateReviewInference({
      user,
      model: catalogModel().id,
      thinkingEffort: 'max',
    });
    expect(inference).toEqual({
      modelId: catalogModel().id,
      provider: 'anthropic',
      thinkingEffort: 'max',
      variant: variants.max,
      reasoningSupported: true,
      maxOutputTokens: 32_000,
    });
    expect(getDirectByokModelsForUser).toHaveBeenCalledWith(user.id);
    expect(getAvailableModelsForOrganization).not.toHaveBeenCalled();
  });

  it('delegates organization authorization and catalog policy to the canonical resolver', async () => {
    jest.mocked(getAvailableModelsForOrganization).mockResolvedValue({ data: [catalogModel()] });
    await resolveIsolateReviewInference({
      user,
      organizationId: 'org-123',
      model: catalogModel().id,
    });
    expect(getAvailableModelsForOrganization).toHaveBeenCalledWith('org-123', {
      type: 'member',
      kiloUserId: user.id,
    });
    expect(getEnhancedOpenRouterModels).not.toHaveBeenCalled();
    expect(getDirectByokModelsForUser).not.toHaveBeenCalled();
    expect(listAvailableExperimentModels).not.toHaveBeenCalled();
  });

  it.each(['custom-llm/admin-enabled', 'morph-byok/authorized-model'])(
    'does not reapply model restrictions to an authorized organization catalog entry: %s',
    async model => {
      jest
        .mocked(getAvailableModelsForOrganization)
        .mockResolvedValue({ data: [catalogModel(model)] });
      expect(
        await resolveIsolateReviewInference({ user, organizationId: 'org-123', model })
      ).toMatchObject({ modelId: model, provider: 'anthropic' });
    }
  );

  it('allows personal direct BYOK entries only from the current owner catalog', async () => {
    const model = 'morph-byok/personal-model';
    jest.mocked(getDirectByokModelsForUser).mockResolvedValue([
      {
        ...catalogModel(model),
        opencode: { ai_sdk_provider: 'openai-compatible', variants: undefined },
      },
    ] as Awaited<ReturnType<typeof getDirectByokModelsForUser>>);
    expect(await resolveIsolateReviewInference({ user, model })).toMatchObject({
      modelId: model,
      provider: 'openai-compatible',
      thinkingEffort: null,
      variant: null,
    });
    expect(getDirectByokModelsForUser).toHaveBeenCalledWith(user.id);
    await expect(
      resolveIsolateReviewInference({ user, model: 'morph-byok/other-owner' })
    ).rejects.toThrow('not available');
  });

  it('never substitutes a public catalog after an organization authorization failure', async () => {
    jest
      .mocked(getAvailableModelsForOrganization)
      .mockRejectedValue(new Error('membership required'));
    await expect(
      resolveIsolateReviewInference({ user, organizationId: 'org-123', model: catalogModel().id })
    ).rejects.toThrow('membership required');
    expect(getEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  it('rejects a model absent from the authorized organization catalog even when public', async () => {
    await expect(
      resolveIsolateReviewInference({ user, organizationId: 'org-123', model: catalogModel().id })
    ).rejects.toThrow('not available');
    expect(getEnhancedOpenRouterModels).not.toHaveBeenCalled();
  });

  it.each(['kilo-auto/efficient', 'kilo-auto/frontier', 'kilo-auto/org'])(
    'rejects explicit auto effort before catalog IO: %s',
    async model => {
      await expect(
        resolveIsolateReviewInference({
          user,
          organizationId: 'org-123',
          model,
          thinkingEffort: 'none',
        })
      ).rejects.toThrow('Auto models');
      expect(getAvailableModelsForOrganization).not.toHaveBeenCalled();
      expect(getEnhancedOpenRouterModels).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, null])(
    'does not select a variant for default effort %s',
    async thinkingEffort => {
      expect(
        await resolveIsolateReviewInference({ user, model: catalogModel().id, thinkingEffort })
      ).toMatchObject({ thinkingEffort: null, variant: null });
    }
  );

  it('keeps router defaults and binary variants distinct', () => {
    const model = {
      ...catalogModel('qwen/qwen3.7-plus'),
      opencode: {
        variants: {
          instant: { reasoning: { enabled: false, effort: 'none' } },
          thinking: { reasoning: { enabled: true, effort: 'high' } },
        },
      },
    };
    expect(resolveIsolateReviewInferenceFromCatalog(model)).toMatchObject({
      provider: 'openrouter',
      thinkingEffort: null,
      variant: null,
    });
    expect(resolveIsolateReviewInferenceFromCatalog(model, 'instant').variant).toEqual({
      reasoning: { enabled: false, effort: 'none' },
    });
    expect(resolveIsolateReviewInferenceFromCatalog(model, 'thinking').variant).toEqual({
      reasoning: { enabled: true, effort: 'high' },
    });
  });

  it('freezes Qwen sampling from the owner-scoped catalog', async () => {
    const model = {
      ...catalogModel('qwen/qwen3.7-plus'),
      supported_parameters: ['tools', 'reasoning', 'temperature', 'top_p'],
      opencode: undefined,
    };
    jest.mocked(getEnhancedOpenRouterModels).mockResolvedValue({ data: [model] });
    const inference = await resolveIsolateReviewInference({ user, model: model.id });
    expect(inference).toMatchObject({ temperature: 0.55, topP: 1, variant: null });
    expect(JSON.parse(JSON.stringify(inference))).toMatchObject({ temperature: 0.55, topP: 1 });
  });

  it.each([
    ['qwen/qwen3.7-plus', ['tools', 'temperature', 'top_p'], 0.55, 1],
    ['qwen/qwen3.7-plus', ['tools', 'temperature'], 0.55, undefined],
    ['qwen/qwen3.7-plus', ['tools', 'top_p'], undefined, 1],
    ['qwen/qwen3.7-plus', undefined, undefined, undefined],
    ['qwen/north-mini-code', ['tools', 'temperature', 'top_p'], undefined, 1],
    ['anthropic/claude-sonnet-5', ['tools', 'temperature', 'top_p'], undefined, undefined],
    ['kilo-auto/org', ['tools', 'temperature', 'top_p'], undefined, undefined],
    ['kilo-auto/qwen', ['tools', 'temperature', 'top_p'], undefined, undefined],
  ] as const)(
    'only adopts capability-backed Qwen sampling for %s with %j',
    (id, supportedParameters, temperature, topP) => {
      const inference = resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel(id),
        supported_parameters: supportedParameters,
        opencode: undefined,
      });
      expect(inference.temperature).toBe(temperature);
      expect(inference.topP).toBe(topP);
    }
  );

  it('keeps the stricter topP capability guard explicit versus CLI 7.4.20', () => {
    const inference = resolveIsolateReviewInferenceFromCatalog({
      ...catalogModel('qwen/qwen3.7-plus'),
      supported_parameters: ['tools', 'temperature'],
      opencode: undefined,
    });
    expect(inference.temperature).toBe(0.55);
    expect(inference).not.toHaveProperty('topP');
  });

  it.each(['kilo-auto/efficient', 'kilo-auto/org'])(
    'rejects prepared sampling overrides for %s',
    modelId => {
      const inference = resolveIsolateReviewInferenceFromCatalog({
        ...catalogModel(modelId),
        opencode: undefined,
      });
      expect(() => validateIsolateReviewInference({ ...inference, temperature: 0.55 })).toThrow(
        'sampling settings'
      );
      expect(() => validateIsolateReviewInference({ ...inference, topP: 1 })).toThrow(
        'sampling settings'
      );
    }
  );

  it('validates bounded sampling without opening arbitrary provider options', () => {
    const inference = resolveIsolateReviewInferenceFromCatalog(catalogModel());
    expect(validateIsolateReviewInference({ ...inference, temperature: 0, topP: 0 })).toMatchObject(
      { temperature: 0, topP: 0 }
    );
    expect(() => validateIsolateReviewInference({ ...inference, temperature: -0.01 })).toThrow();
    expect(() => validateIsolateReviewInference({ ...inference, temperature: 2.01 })).toThrow();
    expect(() => validateIsolateReviewInference({ ...inference, topP: 1.01 })).toThrow();
    expect(() =>
      validateIsolateReviewInference({ ...inference, topP: 1, extraBody: {} })
    ).toThrow();
  });

  it.each(Object.keys(variants))('preserves the complete advertised Sonnet 5 variant: %s', key => {
    const inference = resolveIsolateReviewInferenceFromCatalog(catalogModel(), key);
    expect(inference.variant).toEqual(variants[key as keyof typeof variants]);
  });

  it('rejects Sonnet 4.6 xhigh when the catalog does not advertise it', () => {
    const sonnet46Variants = {
      none: variants.none,
      low: variants.low,
      medium: variants.medium,
      high: variants.high,
      max: variants.max,
    };
    const model = {
      ...catalogModel('anthropic/claude-sonnet-4.6'),
      opencode: { ai_sdk_provider: 'anthropic', variants: sonnet46Variants },
    };
    expect(() => resolveIsolateReviewInferenceFromCatalog(model, 'xhigh')).toThrow(
      'Unknown thinking variant'
    );
    expect(resolveIsolateReviewInferenceFromCatalog(model).variant).toBeNull();
  });

  it('caps catalog output limits and returns no catalog secrets or transport controls', () => {
    const model = {
      ...catalogModel(),
      apiKey: 'fixture-only',
      headers: { arbitrary: 'header' },
      baseURL: 'https://not-forwarded.invalid',
      top_provider: { max_completion_tokens: 8000 },
    };
    const inference = resolveIsolateReviewInferenceFromCatalog(model, 'high');
    expect(inference.maxOutputTokens).toBe(8000);
    expect(Object.keys(inference).sort()).toEqual([
      'maxOutputTokens',
      'modelId',
      'provider',
      'reasoningSupported',
      'thinkingEffort',
      'variant',
    ]);
    expect(JSON.stringify(inference)).not.toContain('fixture-only');
    expect(JSON.stringify(inference)).not.toContain('not-forwarded');
  });

  it('validates selected variant shape instead of forwarding arbitrary fields', () => {
    const model = {
      ...catalogModel(),
      opencode: {
        ai_sdk_provider: 'anthropic',
        variants: { high: { ...variants.high, headers: { arbitrary: 'header' } } },
      },
    };
    expect(() => resolveIsolateReviewInferenceFromCatalog(model, 'high')).toThrow();
    expect(() => resolveIsolateReviewInferenceFromCatalog(catalogModel(), 'toString')).toThrow(
      'Unknown thinking variant'
    );
  });

  it('rejects protocol combinations that would silently lose reasoning or verbosity', () => {
    const base = resolveIsolateReviewInferenceFromCatalog(catalogModel(), 'high');
    expect(() =>
      validateIsolateReviewInference({ ...base, provider: 'openai', variant: { verbosity: 'max' } })
    ).toThrow('Responses');
    expect(() =>
      validateIsolateReviewInference({
        ...base,
        provider: 'openai-compatible',
        variant: { reasoning: { enabled: true } },
      })
    ).toThrow('catalog reasoning effort');
    expect(() =>
      validateIsolateReviewInference({
        ...base,
        variant: { reasoning: { enabled: true, effort: 'high' } },
      })
    ).toThrow('catalog verbosity');
    expect(() =>
      validateIsolateReviewInference({
        ...base,
        variant: { reasoning: { enabled: false, effort: 'high' } },
      })
    ).toThrow('Contradictory');
    expect(() => validateIsolateReviewInference({ ...base, headers: {} })).toThrow();
  });
});
