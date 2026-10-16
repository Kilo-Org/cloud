import { beforeEach, describe, expect, test } from '@jest/globals';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  CLAUDE_OPUS_CURRENT_MODEL_ID,
  CLAUDE_SONNET_CURRENT_MODEL_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { addAutoRoutingModels, addCustomRouterModels } from './auto-routing-models';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/resolution', () => ({
  getAutoFreeCandidates: jest.fn(),
}));

const { getCachedRoutingTable } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/auto-routing-table-cache'
);
const { getAutoFreeCandidates } = jest.requireMock(
  '@kilocode/web-shared/lib/ai-gateway/auto-model/resolution'
);
const mockedGetCachedRoutingTable = jest.mocked(getCachedRoutingTable);
const mockedGetAutoFreeCandidates = jest.mocked(getAutoFreeCandidates);

function makeModel(id: string): OpenRouterModel {
  return {
    id,
    name: id,
    created: 0,
    description: '',
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'test',
    },
    top_provider: { is_moderated: false },
    pricing: { prompt: '0', completion: '0' },
    context_length: 0,
  };
}

function routingTable(candidateIds: string[]) {
  return {
    routes: {
      'implementation/code_generation': candidateIds.map(model => ({ model })),
    },
  } as never;
}

describe('addAutoRoutingModels', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedGetCachedRoutingTable.mockResolvedValue(null);
    mockedGetAutoFreeCandidates.mockResolvedValue([]);
  });

  test('only lists candidates present in the provided catalog', async () => {
    // The catalog passed in is the caller's already-filtered view (org deny
    // lists, feature filtering). A routing-table candidate missing from it —
    // e.g. deny-listed for an enterprise org — must not surface as a choice,
    // even though inference-time routing knows about it.
    const efficientModel = makeModel('kilo-auto/efficient');
    const visibleModel = makeModel('google/gemini-2.5-flash');
    mockedGetCachedRoutingTable.mockResolvedValue(
      routingTable(['google/gemini-2.5-flash', 'anthropic/claude-opus-4.8'])
    );

    const result = await addAutoRoutingModels([efficientModel, visibleModel]);

    expect(result).toEqual([
      { ...efficientModel, autoRouting: { models: ['google/gemini-2.5-flash'] } },
      visibleModel,
    ]);
  });

  test('annotates the frontier auto model with its visible targets', async () => {
    const frontierModel = makeModel('kilo-auto/frontier');
    const opusModel = makeModel(CLAUDE_OPUS_CURRENT_MODEL_ID);
    const sonnetModel = makeModel(CLAUDE_SONNET_CURRENT_MODEL_ID);

    const result = await addAutoRoutingModels([frontierModel, sonnetModel, opusModel]);

    expect(result).toEqual([
      {
        ...frontierModel,
        autoRouting: { models: [CLAUDE_OPUS_CURRENT_MODEL_ID, CLAUDE_SONNET_CURRENT_MODEL_ID] },
      },
      sonnetModel,
      opusModel,
    ]);
  });

  test('annotates the small auto model with its visible targets', async () => {
    const smallModel = makeModel('kilo-auto/small');
    const paidModel = makeModel('google/gemma-4-26b-a4b-it');
    const freeModel = makeModel('google/gemma-4-26b-a4b-it:free');

    const result = await addAutoRoutingModels([smallModel, paidModel, freeModel]);

    expect(result).toEqual([
      {
        ...smallModel,
        autoRouting: {
          models: ['google/gemma-4-26b-a4b-it', 'google/gemma-4-26b-a4b-it:free'],
        },
      },
      paidModel,
      freeModel,
    ]);
  });

  test('excludes virtual auto ids and dedupes and sorts candidates', async () => {
    const efficientModel = makeModel('kilo-auto/efficient');
    const balancedModel = makeModel('kilo-auto/balanced');
    const geminiModel = makeModel('google/gemini-2.5-flash');
    const gptModel = makeModel('openai/gpt-5.4-mini');
    mockedGetCachedRoutingTable.mockResolvedValue(
      routingTable([
        'openai/gpt-5.4-mini',
        'kilo-auto/balanced',
        'google/gemini-2.5-flash',
        'openai/gpt-5.4-mini',
      ])
    );

    const result = await addAutoRoutingModels([
      efficientModel,
      balancedModel,
      geminiModel,
      gptModel,
    ]);

    expect(result[0]).toEqual({
      ...efficientModel,
      autoRouting: { models: ['google/gemini-2.5-flash', 'openai/gpt-5.4-mini'] },
    });
    expect(result.slice(1)).toEqual([
      {
        ...balancedModel,
        autoRouting: { models: ['google/gemini-2.5-flash', 'openai/gpt-5.4-mini'] },
      },
      geminiModel,
      gptModel,
    ]);
  });

  test('annotates balanced as an alias of efficient routing', async () => {
    const balancedModel = makeModel('kilo-auto/balanced');
    const efficientModel = makeModel('kilo-auto/efficient');
    const visibleModel = makeModel('google/gemini-2.5-flash');
    mockedGetCachedRoutingTable.mockResolvedValue(routingTable([visibleModel.id]));

    const result = await addAutoRoutingModels([balancedModel, efficientModel, visibleModel]);

    expect(result).toEqual([
      { ...balancedModel, autoRouting: { models: [visibleModel.id] } },
      { ...efficientModel, autoRouting: { models: [visibleModel.id] } },
      visibleModel,
    ]);
  });

  test('annotates the free auto model from its candidate source', async () => {
    const freeModel = makeModel('kilo-auto/free');
    const visibleFreeModel = makeModel('poolside/laguna-m.1:free');
    mockedGetAutoFreeCandidates.mockResolvedValue(['poolside/laguna-m.1:free', 'missing/model']);

    const result = await addAutoRoutingModels([freeModel, visibleFreeModel]);

    expect(result).toEqual([
      { ...freeModel, autoRouting: { models: ['poolside/laguna-m.1:free'] } },
      visibleFreeModel,
    ]);
  });

  test('hides the free auto model when no candidates are visible', async () => {
    const freeModel = makeModel('kilo-auto/free');
    const paidModel = makeModel('openai/gpt-5.4-mini');
    mockedGetAutoFreeCandidates.mockResolvedValue(['denied/free-model']);

    const result = await addAutoRoutingModels([freeModel, paidModel]);

    expect(result).toEqual([paidModel]);
  });

  test('keeps the free auto model visible when candidate lookup fails', async () => {
    const freeModel = makeModel('kilo-auto/free');
    mockedGetAutoFreeCandidates.mockRejectedValue(new Error('Redis unavailable'));

    const result = await addAutoRoutingModels([freeModel]);

    expect(result).toEqual([freeModel]);
  });

  test('leaves the auto model unannotated when no candidates are visible', async () => {
    const efficientModel = makeModel('kilo-auto/efficient');
    mockedGetCachedRoutingTable.mockResolvedValue(routingTable(['denied/model']));

    const result = await addAutoRoutingModels([efficientModel]);

    expect(result).toEqual([efficientModel]);
  });

  test('skips routing lookups when no auto models are in the catalog', async () => {
    const model = makeModel('openai/gpt-5.4-mini');

    const result = await addAutoRoutingModels([model]);

    expect(result).toEqual([model]);
    expect(mockedGetCachedRoutingTable).not.toHaveBeenCalled();
    expect(mockedGetAutoFreeCandidates).not.toHaveBeenCalled();
  });
});

describe('addCustomRouterModels', () => {
  const router = {
    id: '00000000-0000-4000-8000-000000000001',
    ownerType: 'user' as const,
    ownerId: 'user-1',
    slug: 'coding',
    name: 'Coding',
    baseRouter: 'frontier' as const,
    mode: 'best_accuracy' as const,
    entries: [
      { kind: 'gateway' as const, model: 'google/gemini-2.5-flash' },
      { kind: 'gateway' as const, model: 'openai/denied-by-policy' },
      {
        kind: 'client' as const,
        provider: 'ollama',
        model: 'qwen3:8b',
        variants: [],
        capabilities: { contextLength: null, inputModalities: ['text'], toolCall: true, reasoning: false },
        pricing: null,
      },
    ],
    defaultEntryKey: 'gateway:google/gemini-2.5-flash',
  };

  test('lists personal and organization router IDs with their visible gateway models', () => {
    const visible = makeModel('google/gemini-2.5-flash');

    const result = addCustomRouterModels(
      [visible],
      [router, { ...router, ownerType: 'org', ownerId: 'org-1', slug: 'team', name: 'Team' }]
    );

    expect(result.map(model => [model.id, model.name, model.autoRouting])).toEqual([
      ['google/gemini-2.5-flash', 'google/gemini-2.5-flash', undefined],
      ['kilo-auto/custom/coding', 'Coding', { models: ['google/gemini-2.5-flash'] }],
      ['kilo-auto/custom/org/team', 'Team', { models: ['google/gemini-2.5-flash'] }],
    ]);
  });

  test('omits autoRouting when no gateway entry is visible', () => {
    const [, custom] = addCustomRouterModels([makeModel('other/model')], [router]);

    expect(custom?.id).toBe('kilo-auto/custom/coding');
    expect(custom?.autoRouting).toBeUndefined();
  });
});
