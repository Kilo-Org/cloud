import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLimit = jest.fn<() => Promise<Array<{ models: unknown }>>>();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  readDb: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        orderBy: jest.fn(() => ({ limit: mockLimit })),
      })),
    })),
  },
}));

import {
  extractVercelInferenceProviderIdsFromModel,
  getLanguageModelIds,
  getSystemOneModelIds,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { StoredModel } from '@kilocode/db';

function storedModel(partial: Partial<StoredModel> & Pick<StoredModel, 'id'>): StoredModel {
  return {
    name: partial.id,
    endpoints: [{ provider_name: 'test' }],
    ...partial,
  };
}

function textModel(id: string): StoredModel {
  return storedModel({ id, architecture: { output_modalities: ['text'] } });
}

describe('getLanguageModelIds', () => {
  it('includes Vercel language models even when they have no endpoints', () => {
    expect(
      getLanguageModelIds({
        'vendor/with-endpoints': storedModel({ id: 'vendor/with-endpoints', type: 'language' }),
        'vendor/no-endpoints': storedModel({
          id: 'vendor/no-endpoints',
          type: 'language',
          endpoints: [],
        }),
        'vendor/untyped': storedModel({ id: 'vendor/untyped', endpoints: [] }),
        'vendor/embedding': storedModel({
          id: 'vendor/embedding',
          type: 'embedding',
          endpoints: [],
        }),
        'vendor/realtime': storedModel({ id: 'vendor/realtime', type: 'realtime' }),
        'vendor/evaluation': storedModel({ id: 'vendor/evaluation', type: 'evaluation' }),
      })
    ).toEqual(['vendor/with-endpoints', 'vendor/no-endpoints']);
  });

  it('includes only OpenRouter models that output text', () => {
    const outputs = (output_modalities: string[]) => ({ architecture: { output_modalities } });
    expect(
      getLanguageModelIds({
        'vendor/text': storedModel({ id: 'vendor/text', ...outputs(['text']) }),
        'vendor/image-text': storedModel({
          id: 'vendor/image-text',
          ...outputs(['image', 'text']),
        }),
        'vendor/decide': storedModel({ id: 'vendor/decide', ...outputs(['decisions']) }),
        'vendor/embed': storedModel({ id: 'vendor/embed', ...outputs(['embeddings']) }),
        'vendor/image': storedModel({ id: 'vendor/image', ...outputs(['image']) }),
      })
    ).toEqual(['vendor/text', 'vendor/image-text']);
  });
});

describe('getSystemOneModelIds', () => {
  it('includes free variants and aliases of models that output decisions', () => {
    const decisions = { output_modalities: ['decisions'] };
    expect(
      getSystemOneModelIds({
        'typesafe-ai/jev': storedModel({ id: 'typesafe-ai/jev', type: 'evaluation' }),
        'typesafe/jev-1.13': storedModel({ id: 'typesafe/jev-1.13', architecture: decisions }),
        '~typesafe/jev-latest': storedModel({
          id: '~typesafe/jev-latest',
          alias_target: { slug: 'typesafe/jev-1.13' },
          architecture: decisions,
          endpoints: [],
        }),
        'respan/span-01-lite:free': storedModel({
          id: 'respan/span-01-lite:free',
          architecture: decisions,
        }),
        'typesafe/jev-router': storedModel({
          id: 'typesafe/jev-router',
          architecture: { output_modalities: ['text'] },
        }),
        'vendor/untyped': storedModel({ id: 'vendor/untyped' }),
      })
    ).toEqual([
      'typesafe-ai/jev',
      'typesafe/jev-1.13',
      '~typesafe/jev-latest',
      'respan/span-01-lite:free',
    ]);
  });
});

describe('extractVercelInferenceProviderIdsFromModel', () => {
  it('builds a deduplicated plain provider list for a model', () => {
    const model: StoredModel = {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      endpoints: [
        { provider_name: 'anthropic' },
        { provider_name: 'bedrock' },
        { provider_name: 'anthropic' },
        { tag: 'fallback-without-provider-name' },
      ],
    };

    expect(extractVercelInferenceProviderIdsFromModel(model)).toEqual(['anthropic', 'bedrock']);
  });
});

describe('isValidOpenRouterModelId', () => {
  async function loadValidator() {
    jest.resetModules();
    const {
      isValidOpenRouterModelId,
      getCachedVercelInferenceProviderIdsForModel,
      resolveOpenRouterModelAlias,
    } = await import('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache');
    return {
      isValidOpenRouterModelId,
      getCachedVercelInferenceProviderIdsForModel,
      resolveOpenRouterModelAlias,
    };
  }

  beforeEach(() => {
    mockLimit.mockReset();
  });

  it('accepts retained legacy aliases without consulting the database', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();

    await expect(isValidOpenRouterModelId('gpt-4o')).resolves.toBe(true);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it.each(['openai/gpt-4o-mini-transcribe', 'openai/gpt-4o-transcribe'])(
    'rejects removed transcription alias %s',
    async modelId => {
      const { isValidOpenRouterModelId } = await loadValidator();
      mockLimit.mockResolvedValue([{ models: { 'openai/gpt-4o': textModel('openai/gpt-4o') } }]);

      await expect(isValidOpenRouterModelId(modelId)).resolves.toBe(false);
    }
  );

  it('rejects other legacy aliases that are not retained', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([{ models: { 'openai/gpt-4o': textModel('openai/gpt-4o') } }]);

    await expect(isValidOpenRouterModelId('gpt-4o-2024-08-06')).resolves.toBe(false);
  });

  it('accepts ids present in the database catalog', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([{ models: { 'openai/gpt-4o': textModel('openai/gpt-4o') } }]);

    await expect(isValidOpenRouterModelId('openai/gpt-4o')).resolves.toBe(true);
  });

  it('rejects ids missing from a non-empty database catalog', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([{ models: { 'openai/gpt-4o': textModel('openai/gpt-4o') } }]);

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(false);
  });

  it('rejects System One models stored alongside language models', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([
      {
        models: {
          'openai/gpt-4o': textModel('openai/gpt-4o'),
          'typesafe/jev-1.13': storedModel({
            id: 'typesafe/jev-1.13',
            architecture: { output_modalities: ['decisions'] },
          }),
        },
      },
    ]);

    await expect(isValidOpenRouterModelId('typesafe/jev-1.13')).resolves.toBe(false);
  });

  it('fails open when the database has no model ids', async () => {
    const { isValidOpenRouterModelId } = await loadValidator();
    mockLimit.mockResolvedValue([]);

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(true);
  });

  it('reads Vercel inference providers from the database catalog', async () => {
    const { getCachedVercelInferenceProviderIdsForModel } = await loadValidator();
    mockLimit.mockResolvedValue([
      {
        models: {
          'anthropic/claude-sonnet-4.5': storedModel({
            id: 'anthropic/claude-sonnet-4.5',
            endpoints: [
              { provider_name: 'anthropic' },
              { provider_name: 'bedrock' },
              { provider_name: 'anthropic' },
            ],
          }),
        },
      },
    ]);

    await expect(
      getCachedVercelInferenceProviderIdsForModel('anthropic/claude-sonnet-4.5')
    ).resolves.toEqual(['anthropic', 'bedrock']);
  });

  it('resolves an OpenRouter alias from the database catalog', async () => {
    const { resolveOpenRouterModelAlias } = await loadValidator();
    mockLimit.mockResolvedValue([
      {
        models: {
          '~deepseek/deepseek-pro-latest': storedModel({
            id: '~deepseek/deepseek-pro-latest',
            alias_target: { slug: 'deepseek/deepseek-v4-pro-0813' },
          }),
        },
      },
    ]);

    await expect(resolveOpenRouterModelAlias('~deepseek/deepseek-pro-latest')).resolves.toBe(
      'deepseek/deepseek-v4-pro-0813'
    );
  });

  it('returns an unresolved OpenRouter alias unchanged', async () => {
    const { resolveOpenRouterModelAlias } = await loadValidator();
    mockLimit.mockResolvedValue([]);

    await expect(resolveOpenRouterModelAlias('~vendor/model-latest')).resolves.toBe(
      '~vendor/model-latest'
    );
  });

  it('returns an ordinary model id without consulting the database', async () => {
    const { resolveOpenRouterModelAlias } = await loadValidator();

    await expect(resolveOpenRouterModelAlias('vendor/model')).resolves.toBe('vendor/model');
    expect(mockLimit).not.toHaveBeenCalled();
  });
});
