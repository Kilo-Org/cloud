import { afterEach, describe, expect, test } from '@jest/globals';
import {
  formatManualByokModelId,
  formatManualByokProviderId,
  isManualByokEnabled,
  resolveManualByokModel,
  ValidatedManualByokProviderDefinitionSchema,
} from './manual-byok';

const originalVercel = process.env.VERCEL;
const originalVercelEnv = process.env.VERCEL_ENV;

const definition = {
  name: 'Local models',
  base_url: 'http://inference.internal/v1',
  use_x_api_key: false,
  supported_apis: ['chat_completions'] as const,
  preferred_ai_sdk_provider: 'openai-compatible' as const,
  model_defaults: {
    supports_image_input: true,
    supports_reasoning: true,
    add_cache_breakpoints: false,
  },
  models: [{ id: 'Org/Model' }],
};

afterEach(() => {
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
});

describe('manual BYOK provider definitions', () => {
  test('adds the reserved prefix and normalizes public model IDs', () => {
    const providerId = formatManualByokProviderId('local-models');
    expect(providerId).toBe('manual:local-models');
    expect(formatManualByokModelId(providerId, 'Org/Model')).toBe('manual:local-models/org/model');
    expect(() => formatManualByokProviderId('Local_models')).toThrow();
  });

  test('requires unique model IDs', () => {
    expect(ValidatedManualByokProviderDefinitionSchema.safeParse(definition).success).toBe(true);
    const invalid = {
      ...definition,
      supported_apis: ['chat_completions', 'messages'],
      models: [{ id: 'Org/Model' }, { id: 'org/model' }],
    };
    const result = ValidatedManualByokProviderDefinitionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path.join('.'))).toContain('models.1.id');
    }
  });

  test('allows arbitrary advanced headers', () => {
    expect(
      ValidatedManualByokProviderDefinitionSchema.safeParse({
        ...definition,
        extra_headers: { Authorization: 'plaintext-secret' },
      }).success
    ).toBe(true);
    expect(
      ValidatedManualByokProviderDefinitionSchema.safeParse({
        ...definition,
        extra_headers: { 'api-key': 'plaintext-secret', Cookie: 'session=secret' },
      }).success
    ).toBe(true);
  });

  test('rejects preferred adapters without their API', () => {
    expect(
      ValidatedManualByokProviderDefinitionSchema.safeParse({
        ...definition,
        models: [{ id: 'model', preferred_ai_sdk_provider: 'openai' }],
      }).success
    ).toBe(false);
  });

  test('rejects base URLs whose suffix cannot safely be appended', () => {
    expect(
      ValidatedManualByokProviderDefinitionSchema.safeParse({
        ...definition,
        base_url: 'https://example.com/v1?api-version=1',
      }).success
    ).toBe(false);
    expect(
      ValidatedManualByokProviderDefinitionSchema.safeParse({
        ...definition,
        base_url: 'https://secret@example.com/v1',
      }).success
    ).toBe(false);
  });

  test('applies provider defaults and shared hardcoded model limits', () => {
    const parsed = ValidatedManualByokProviderDefinitionSchema.parse(definition);
    expect(resolveManualByokModel(parsed, parsed.models[0])).toMatchObject({
      name: 'Org/Model',
      supportsImageInput: true,
      supportsReasoning: true,
      addCacheBreakpoints: false,
      contextLength: 200_000,
      maxCompletionTokens: 32_000,
      preferredAiSdkProvider: 'openai-compatible',
    });
  });

  test('is disabled in every Vercel environment', () => {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    expect(isManualByokEnabled()).toBe(true);
    process.env.VERCEL = '1';
    expect(isManualByokEnabled()).toBe(false);
    delete process.env.VERCEL;
    process.env.VERCEL_ENV = 'preview';
    expect(isManualByokEnabled()).toBe(false);
  });
});
