import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type * as UtilsServer from '@kilocode/web-shared/lib/utils.server';

const mockWarnExceptInTest = jest.fn();

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual<typeof UtilsServer>('@kilocode/web-shared/lib/utils.server'),
  warnExceptInTest: (...args: unknown[]) => mockWarnExceptInTest(...args),
}));

import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import * as drizzle from '@kilocode/web-shared/lib/drizzle';
import { db, readDb, sql } from '@kilocode/web-shared/lib/drizzle';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  gatewayModelEndpointsUrl,
  openRouterGatewayModelsSource,
  vercelGatewayModelsSource,
  type GatewayModelMap,
  type GatewayModelWithEndpoints,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import type * as GatewayModelsCache from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  extractVercelInferenceProviderIdsFromModel,
  getCachedVercelInferenceProviderIdsForModel,
  getLanguageModelIds,
  getOpenRouterModelsMetadataFromDatabase,
  getSystemOneModelIds,
  getVercelModelsMetadataFromDatabase,
  isValidOpenRouterModelId,
  resolveOpenRouterModelAlias,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';

const CACHE_TTL_MS = 300_000;
const NO_METADATA_WARNING =
  '[isValidOpenRouterModelId] no model metadata available, assuming id is valid';

function gatewayModel(
  partial: Partial<GatewayModelWithEndpoints> & Pick<GatewayModelWithEndpoints, 'id'>
): GatewayModelWithEndpoints {
  return {
    name: partial.id,
    endpoints: [{ provider_name: 'test' }],
    ...partial,
  };
}

function textModel(id: string): GatewayModelWithEndpoints {
  return gatewayModel({ id, architecture: { output_modalities: ['text'] } });
}

async function storeRows(rows: ReadonlyArray<[url: string, data: unknown]>) {
  await db
    .insert(ai_gateway_metadata_cache)
    .values(rows.map(([url, data]) => ({ url, data })))
    .onConflictDoUpdate({
      target: ai_gateway_metadata_cache.url,
      set: { data: sql`excluded.data` },
    });
}

const fillerModels = Array.from({ length: 100 }, (_, index) => textModel(`filler/model-${index}`));

function withFillerModels(models: GatewayModelMap): GatewayModelMap {
  return { ...models, ...Object.fromEntries(fillerModels.map(model => [model.id, model])) };
}

function listRow(listUrl: string, models: readonly GatewayModelWithEndpoints[]): [string, unknown] {
  return [listUrl, { data: models.map(model => ({ ...model, endpoints: undefined })) }];
}

function endpointsRows(
  gateway: Provider,
  models: readonly GatewayModelWithEndpoints[]
): Array<[string, unknown]> {
  return models.map(model => [
    gatewayModelEndpointsUrl(gateway, model.id),
    { data: { endpoints: model.endpoints } },
  ]);
}

function storeGatewayModels(
  gateway: Provider,
  listUrl: string,
  models: readonly GatewayModelWithEndpoints[]
) {
  const listed = [...models, ...fillerModels];
  return storeRows([listRow(listUrl, listed), ...endpointsRows(gateway, listed)]);
}

function storeOpenRouterModels(models: readonly GatewayModelWithEndpoints[]) {
  return storeGatewayModels(OPENROUTER, openRouterGatewayModelsSource.url, models);
}

function storeVercelModels(models: readonly GatewayModelWithEndpoints[]) {
  return storeGatewayModels(VERCEL_AI_GATEWAY, vercelGatewayModelsSource.url, models);
}

/** A fresh copy of the module, whose caches have never held a value, sharing the database pools. */
async function loadColdGatewayModelsCache() {
  let coldCache: typeof GatewayModelsCache | undefined;
  await jest.isolateModulesAsync(async () => {
    jest.doMock('@kilocode/web-shared/lib/drizzle', () => drizzle);
    coldCache = await import('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache');
  });
  if (!coldCache) throw new Error('gateway-models-cache did not load');
  return coldCache;
}

function clearStoredMetadata() {
  return db.delete(ai_gateway_metadata_cache).where(sql`true`);
}

function noMetadataWarningCount() {
  return mockWarnExceptInTest.mock.calls.filter(([message]) => message === NO_METADATA_WARNING)
    .length;
}

// The caches under test live at module scope, so each test starts a new cache window by moving
// the clock past the TTL instead of reloading the module.
const realDateNow = Date.now.bind(Date);
let clockOffsetMs = 0;

function startNextCacheWindow() {
  clockOffsetMs += CACHE_TTL_MS + 1;
}

beforeEach(async () => {
  await clearStoredMetadata();
  startNextCacheWindow();
  jest.spyOn(Date, 'now').mockImplementation(() => realDateNow() + clockOffsetMs);
  jest.spyOn(console, 'debug').mockImplementation(() => {});
  mockWarnExceptInTest.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getLanguageModelIds', () => {
  it('includes Vercel language models even when they have no endpoints', () => {
    expect(
      getLanguageModelIds({
        'vendor/with-endpoints': gatewayModel({ id: 'vendor/with-endpoints', type: 'language' }),
        'vendor/no-endpoints': gatewayModel({
          id: 'vendor/no-endpoints',
          type: 'language',
          endpoints: [],
        }),
        'vendor/untyped': gatewayModel({ id: 'vendor/untyped', endpoints: [] }),
        'vendor/embedding': gatewayModel({
          id: 'vendor/embedding',
          type: 'embedding',
          endpoints: [],
        }),
        'vendor/realtime': gatewayModel({ id: 'vendor/realtime', type: 'realtime' }),
        'vendor/evaluation': gatewayModel({ id: 'vendor/evaluation', type: 'evaluation' }),
      })
    ).toEqual(['vendor/with-endpoints', 'vendor/no-endpoints']);
  });

  it('includes only OpenRouter models that output text', () => {
    const outputs = (output_modalities: string[]) => ({ architecture: { output_modalities } });
    expect(
      getLanguageModelIds({
        'vendor/text': gatewayModel({ id: 'vendor/text', ...outputs(['text']) }),
        'vendor/image-text': gatewayModel({
          id: 'vendor/image-text',
          ...outputs(['image', 'text']),
        }),
        'vendor/decide': gatewayModel({ id: 'vendor/decide', ...outputs(['decisions']) }),
        'vendor/embed': gatewayModel({ id: 'vendor/embed', ...outputs(['embeddings']) }),
        'vendor/image': gatewayModel({ id: 'vendor/image', ...outputs(['image']) }),
      })
    ).toEqual(['vendor/text', 'vendor/image-text']);
  });
});

describe('getSystemOneModelIds', () => {
  it('includes free variants and aliases of models that output decisions', () => {
    const decisions = { output_modalities: ['decisions'] };
    expect(
      getSystemOneModelIds({
        'typesafe-ai/jev': gatewayModel({ id: 'typesafe-ai/jev', type: 'evaluation' }),
        'typesafe/jev-1.13': gatewayModel({ id: 'typesafe/jev-1.13', architecture: decisions }),
        '~typesafe/jev-latest': gatewayModel({
          id: '~typesafe/jev-latest',
          alias_target: { slug: 'typesafe/jev-1.13' },
          architecture: decisions,
          endpoints: [],
        }),
        'respan/span-01-lite:free': gatewayModel({
          id: 'respan/span-01-lite:free',
          architecture: decisions,
        }),
        'typesafe/jev-router': gatewayModel({
          id: 'typesafe/jev-router',
          architecture: { output_modalities: ['text'] },
        }),
        'vendor/untyped': gatewayModel({ id: 'vendor/untyped' }),
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
    const model: GatewayModelWithEndpoints = {
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

describe('gateway model metadata readers', () => {
  it('returns the stored models with their stored endpoints', async () => {
    await storeOpenRouterModels([
      textModel('openai/gpt-4o'),
      gatewayModel({
        id: '~openai/gpt-latest',
        alias_target: { slug: 'openai/gpt-4o' },
        endpoints: [],
      }),
    ]);
    await storeVercelModels([
      gatewayModel({
        id: 'anthropic/claude-sonnet-4.5',
        type: 'language',
        endpoints: [{ provider_name: 'anthropic', has_zdr: true }, { provider_name: 'bedrock' }],
      }),
    ]);

    await expect(getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual(
      withFillerModels({
        'openai/gpt-4o': textModel('openai/gpt-4o'),
        '~openai/gpt-latest': gatewayModel({
          id: '~openai/gpt-latest',
          alias_target: { slug: 'openai/gpt-4o' },
          endpoints: [],
        }),
      })
    );
    await expect(getVercelModelsMetadataFromDatabase()).resolves.toEqual(
      withFillerModels({
        'anthropic/claude-sonnet-4.5': gatewayModel({
          id: 'anthropic/claude-sonnet-4.5',
          type: 'language',
          endpoints: [{ provider_name: 'anthropic', has_zdr: true }, { provider_name: 'bedrock' }],
        }),
      })
    );
  });

  it('leaves out models without stored endpoints or without an endpoints resource', async () => {
    await storeRows([
      [
        vercelGatewayModelsSource.url,
        {
          data: [
            { id: 'vendor/listed', name: 'Listed' },
            { id: 'vendor/not-stored', name: 'Not stored' },
            { id: 'vendor/listed-batch', name: 'Batch' },
            { id: 'vendor/unparseable', name: 'Unparseable' },
            ...fillerModels.map(model => ({ ...model, endpoints: undefined })),
          ],
        },
      ],
      [
        gatewayModelEndpointsUrl(VERCEL_AI_GATEWAY, 'vendor/listed'),
        { data: { endpoints: [{ provider_name: 'test' }] } },
      ],
      [gatewayModelEndpointsUrl(VERCEL_AI_GATEWAY, 'vendor/listed-batch'), { status: 404 }],
      [
        gatewayModelEndpointsUrl(VERCEL_AI_GATEWAY, 'vendor/unparseable'),
        { data: { endpoints: 'not-a-list' } },
      ],
      ...endpointsRows(VERCEL_AI_GATEWAY, fillerModels),
    ]);

    await expect(getVercelModelsMetadataFromDatabase()).resolves.toEqual(
      withFillerModels({
        'vendor/listed': {
          id: 'vendor/listed',
          name: 'Listed',
          endpoints: [{ provider_name: 'test' }],
        },
      })
    );
    expect(mockWarnExceptInTest).toHaveBeenCalledWith(
      '[getGatewayModels] 2 Vercel models have no usable stored endpoints: vendor/not-stored, vendor/unparseable'
    );
  });

  it('keeps an alias on its previous target until the new target has stored endpoints', async () => {
    const alias = '~vendor/model-latest';
    const previousTarget = textModel('vendor/model-a');
    const newTarget = textModel('vendor/model-b');
    await storeOpenRouterModels([
      { ...textModel(alias), alias_target: { slug: previousTarget.id } },
      previousTarget,
    ]);
    await expect(resolveOpenRouterModelAlias(alias)).resolves.toBe(previousTarget.id);

    await storeRows([
      listRow(openRouterGatewayModelsSource.url, [
        { ...textModel(alias), alias_target: { slug: newTarget.id } },
        previousTarget,
        newTarget,
        ...fillerModels,
      ]),
    ]);
    startNextCacheWindow();

    await expect(resolveOpenRouterModelAlias(alias)).resolves.toBe(previousTarget.id);
    await expect(isValidOpenRouterModelId(previousTarget.id)).resolves.toBe(true);
    await expect(isValidOpenRouterModelId(newTarget.id)).resolves.toBe(false);

    await storeRows(endpointsRows(OPENROUTER, [newTarget]));
    startNextCacheWindow();

    await expect(resolveOpenRouterModelAlias(alias)).resolves.toBe(newTarget.id);
    await expect(isValidOpenRouterModelId(newTarget.id)).resolves.toBe(true);
  });

  it('keeps the previous entry of a listed model whose endpoints row becomes unusable', async () => {
    const model = gatewayModel({ id: 'vendor/flaky', endpoints: [{ provider_name: 'before' }] });
    await storeVercelModels([model]);
    await expect(getVercelModelsMetadataFromDatabase()).resolves.toHaveProperty(
      'vendor/flaky',
      model
    );

    await storeRows([
      [gatewayModelEndpointsUrl(VERCEL_AI_GATEWAY, model.id), { data: { endpoints: 'nope' } }],
    ]);
    startNextCacheWindow();

    await expect(getVercelModelsMetadataFromDatabase()).resolves.toHaveProperty(
      'vendor/flaky',
      model
    );
  });

  it('leaves out an alias whose target has no stored endpoints on a cold start', async () => {
    const coldCache = await loadColdGatewayModelsCache();
    await storeRows([
      listRow(openRouterGatewayModelsSource.url, [
        { ...textModel('~vendor/cold-latest'), alias_target: { slug: 'vendor/cold-new' } },
        textModel('vendor/cold-new'),
        ...fillerModels,
      ]),
      ...endpointsRows(OPENROUTER, [textModel('~vendor/cold-latest'), ...fillerModels]),
    ]);

    const models = await coldCache.getOpenRouterModelsMetadataFromDatabase();

    expect(models).not.toHaveProperty('~vendor/cold-latest');
    expect(models).not.toHaveProperty('vendor/cold-new');
    expect(Object.keys(models)).toHaveLength(fillerModels.length);
  });

  it('returns an empty map when the list is not stored', async () => {
    await storeRows([
      [gatewayModelEndpointsUrl(OPENROUTER, 'openai/gpt-4o'), { data: { endpoints: [] } }],
    ]);

    await expect(getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual({});
  });

  it('never fetches upstream when the list or endpoints rows are missing', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('unexpected upstream fetch'));
    await storeRows([
      listRow(vercelGatewayModelsSource.url, [
        textModel('vendor/no-endpoints-row'),
        ...fillerModels,
      ]),
      ...endpointsRows(VERCEL_AI_GATEWAY, fillerModels),
    ]);

    await expect(getVercelModelsMetadataFromDatabase()).resolves.toEqual(withFillerModels({}));
    await expect(getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads the database once per cache window', async () => {
    const execute = jest.spyOn(readDb, 'execute');
    await storeOpenRouterModels([textModel('openai/gpt-4o')]);

    await getOpenRouterModelsMetadataFromDatabase();
    await storeOpenRouterModels([textModel('openai/gpt-4o'), textModel('openai/gpt-5')]);

    await expect(getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual(
      withFillerModels({ 'openai/gpt-4o': textModel('openai/gpt-4o') })
    );
    expect(execute).toHaveBeenCalledTimes(1);

    startNextCacheWindow();

    await expect(getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual(
      withFillerModels({
        'openai/gpt-4o': textModel('openai/gpt-4o'),
        'openai/gpt-5': textModel('openai/gpt-5'),
      })
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  const unusableCatalogs: Array<[label: string, store: () => Promise<void>]> = [
    [
      'a list that does not parse',
      () => storeRows([[openRouterGatewayModelsSource.url, { data: 'not-a-list' }]]),
    ],
    [
      'a truncated list',
      () =>
        storeRows([
          listRow(openRouterGatewayModelsSource.url, fillerModels.slice(1)),
          ...endpointsRows(OPENROUTER, fillerModels.slice(1)),
        ]),
    ],
    [
      'too few models with stored endpoints',
      () =>
        storeRows([
          listRow(openRouterGatewayModelsSource.url, fillerModels),
          ...endpointsRows(OPENROUTER, fillerModels.slice(1)),
        ]),
    ],
  ];

  it.each(unusableCatalogs)(
    'keeps serving the last good models when a refresh finds %s',
    async (_label, storeUnusableCatalog) => {
      await storeOpenRouterModels([textModel('openai/gpt-4o')]);
      await getOpenRouterModelsMetadataFromDatabase();
      await clearStoredMetadata();
      await storeUnusableCatalog();

      startNextCacheWindow();

      await expect(getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual(
        withFillerModels({ 'openai/gpt-4o': textModel('openai/gpt-4o') })
      );
      expect(mockWarnExceptInTest).toHaveBeenCalledWith(
        expect.stringContaining('[cached-fetch] gatewayModels[openrouter] refresh failed:')
      );
    }
  );

  it.each(unusableCatalogs)(
    'returns an empty map on a cold start that finds %s',
    async (_label, storeUnusableCatalog) => {
      await storeUnusableCatalog();
      const coldCache = await loadColdGatewayModelsCache();

      await expect(coldCache.getOpenRouterModelsMetadataFromDatabase()).resolves.toEqual({});
      expect(mockWarnExceptInTest).toHaveBeenCalledWith(
        expect.stringContaining('[cached-fetch] gatewayModels[openrouter] refresh failed:')
      );
    }
  );
});

describe('isValidOpenRouterModelId', () => {
  it.each([
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-sonnet-4-6',
    'arcee-ai/trinity-large-thinking',
    'claude-sonnet-4.5',
    'claude-sonnet-5',
    'deepseek-v4-flash',
    'deepseek-v4-flash-0731',
    'deepseek-v4-pro',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'inclusionai/ling-3.0-flash-fin',
    'minimax-m3',
    'minimax/minimax-m2.5-20260211',
    'minimax/minimax-m2.7-highspeed',
    'openai/o1',
    'openai/o3-mini',
    'openai/o4-mini',
    'poolside/laguna-s-2.1',
    'qwen/qwen3-next-80b-a3b-thinking',
    'qwen/qwen3.8-max',
    'zai/glm-5.3',
    'zai/glm-5.3-flash',
  ])('accepts retained legacy alias %s without consulting the database', async modelId => {
    const execute = jest.spyOn(readDb, 'execute');

    await expect(isValidOpenRouterModelId(modelId)).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    'anthropic/claude-sonnet-5-20260630',
    'claude-sonnet-4',
    'gemini-2.5-flash-lite',
    'glm-5.1',
    'glm-5.2',
    'gpt-4.1-mini',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.4-mini',
    'kimi-k3',
    'mimo-v2.5',
    'minimax-m2.5',
    'step-3.5-flash',
  ])('rejects removed legacy alias %s when absent from the catalog', async modelId => {
    await storeOpenRouterModels([textModel('openai/gpt-4o')]);

    await expect(isValidOpenRouterModelId(modelId)).resolves.toBe(false);
  });

  it.each(['openai/gpt-4o-mini-transcribe', 'openai/gpt-4o-transcribe'])(
    'rejects removed transcription alias %s',
    async modelId => {
      await storeOpenRouterModels([textModel('openai/gpt-4o')]);

      await expect(isValidOpenRouterModelId(modelId)).resolves.toBe(false);
    }
  );

  it('rejects other legacy aliases that are not retained', async () => {
    await storeOpenRouterModels([textModel('openai/gpt-4o')]);

    await expect(isValidOpenRouterModelId('gpt-4o-2024-08-06')).resolves.toBe(false);
  });

  it('accepts ids present in the database catalog', async () => {
    await storeOpenRouterModels([textModel('openai/gpt-4o')]);

    await expect(isValidOpenRouterModelId('openai/gpt-4o')).resolves.toBe(true);
  });

  it('rejects ids missing from a non-empty database catalog', async () => {
    await storeOpenRouterModels([textModel('openai/gpt-4o')]);

    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(false);
  });

  it('rejects System One models stored alongside language models', async () => {
    await storeOpenRouterModels([
      textModel('openai/gpt-4o'),
      gatewayModel({
        id: 'typesafe/jev-1.13',
        architecture: { output_modalities: ['decisions'] },
      }),
    ]);

    await expect(isValidOpenRouterModelId('typesafe/jev-1.13')).resolves.toBe(false);
  });

  it('fails open when the database has no model ids', async () => {
    await expect(isValidOpenRouterModelId('not-a-real-model')).resolves.toBe(true);
  });

  it('warns once per empty-metadata window', async () => {
    await expect(isValidOpenRouterModelId('vendor/one')).resolves.toBe(true);
    await expect(isValidOpenRouterModelId('vendor/two')).resolves.toBe(true);
    expect(noMetadataWarningCount()).toBe(1);

    startNextCacheWindow();

    await expect(isValidOpenRouterModelId('vendor/three')).resolves.toBe(true);
    expect(noMetadataWarningCount()).toBe(2);
  });

  it('warns again only after metadata recovers and empties again', async () => {
    await isValidOpenRouterModelId('vendor/missing');
    expect(noMetadataWarningCount()).toBe(1);

    await storeOpenRouterModels([textModel('openai/gpt-4o')]);
    startNextCacheWindow();

    await expect(isValidOpenRouterModelId('openai/gpt-4o')).resolves.toBe(true);
    expect(noMetadataWarningCount()).toBe(1);

    await clearStoredMetadata();
    startNextCacheWindow();

    await expect(isValidOpenRouterModelId('vendor/missing')).resolves.toBe(true);
    expect(noMetadataWarningCount()).toBe(2);
  });

  it('reads Vercel inference providers from the database catalog', async () => {
    await storeVercelModels([
      gatewayModel({
        id: 'anthropic/claude-sonnet-4.5',
        endpoints: [
          { provider_name: 'anthropic' },
          { provider_name: 'bedrock' },
          { provider_name: 'anthropic' },
        ],
      }),
    ]);

    await expect(
      getCachedVercelInferenceProviderIdsForModel('anthropic/claude-sonnet-4.5')
    ).resolves.toEqual(['anthropic', 'bedrock']);
  });

  it('answers every queried id from one catalog snapshot per window', async () => {
    const execute = jest.spyOn(readDb, 'execute');
    await storeVercelModels([
      gatewayModel({
        id: 'anthropic/claude-sonnet-4.5',
        endpoints: [{ provider_name: 'anthropic' }, { provider_name: 'bedrock' }],
      }),
    ]);

    for (let index = 0; index < 200; index += 1) {
      await expect(
        getCachedVercelInferenceProviderIdsForModel(`vendor/unlisted-${index}`)
      ).resolves.toBeNull();
    }
    await expect(
      getCachedVercelInferenceProviderIdsForModel('anthropic/claude-sonnet-4.5')
    ).resolves.toEqual(['anthropic', 'bedrock']);
    expect(execute).toHaveBeenCalledTimes(1);

    await storeVercelModels([
      gatewayModel({
        id: 'anthropic/claude-sonnet-4.5',
        endpoints: [{ provider_name: 'anthropic' }, { provider_name: 'bedrock' }],
      }),
      gatewayModel({
        id: 'anthropic/claude-sonnet-4.6',
        endpoints: [{ provider_name: 'google-vertex' }],
      }),
    ]);
    startNextCacheWindow();

    await expect(
      getCachedVercelInferenceProviderIdsForModel('anthropic/claude-sonnet-4.6')
    ).resolves.toEqual(['google-vertex']);
    await expect(
      getCachedVercelInferenceProviderIdsForModel('vendor/unlisted-0')
    ).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('resolves an OpenRouter alias from the database catalog', async () => {
    await storeOpenRouterModels([
      gatewayModel({
        id: '~deepseek/deepseek-pro-latest',
        alias_target: { slug: 'deepseek/deepseek-v4-pro-0813' },
      }),
    ]);

    await expect(resolveOpenRouterModelAlias('~deepseek/deepseek-pro-latest')).resolves.toBe(
      'deepseek/deepseek-v4-pro-0813'
    );
  });

  it('returns an unresolved OpenRouter alias unchanged', async () => {
    await expect(resolveOpenRouterModelAlias('~vendor/model-latest')).resolves.toBe(
      '~vendor/model-latest'
    );
  });

  it('returns an ordinary model id without consulting the database', async () => {
    const execute = jest.spyOn(readDb, 'execute');

    await expect(resolveOpenRouterModelAlias('vendor/model')).resolves.toBe('vendor/model');
    expect(execute).not.toHaveBeenCalled();
  });
});
