import { beforeEach, describe, expect, test } from '@jest/globals';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import { addAutoRoutingModels } from './auto-routing-models';

jest.mock('@/lib/ai-gateway/auto-routing-table-cache', () => ({
  getCachedRoutingTable: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/auto-model/resolution', () => ({
  getAutoFreeCandidates: jest.fn(),
}));

const { getCachedRoutingTable } = jest.requireMock('@/lib/ai-gateway/auto-routing-table-cache');
const { getAutoFreeCandidates } = jest.requireMock('@/lib/ai-gateway/auto-model/resolution');
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
    expect(result.slice(1)).toEqual([balancedModel, geminiModel, gptModel]);
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
