import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import {
  openRouterModelsMetadataSource,
  openRouterTranscriptionModelsMetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { openAiServedModelsMetadataSource } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/served-models';
import { mockOpenRouterModels } from '@kilocode/web-shared/tests/helpers/openrouter-models.helper';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type * as StaleAlert from '@/lib/providers/metadata-cache/metadata-cache-stale-alert';

jest.mock('@/lib/providers/metadata-cache/metadata-cache-stale-alert', () => ({
  ...jest.requireActual<typeof StaleAlert>(
    '@/lib/providers/metadata-cache/metadata-cache-stale-alert'
  ),
  alertIfMetadataCacheStale: jest.fn(),
}));

import { alertIfMetadataCacheStale } from '@/lib/providers/metadata-cache/metadata-cache-stale-alert';
import {
  gatewayModelEndpointsSource,
  openRouterGatewayModelsSource,
  openRouterProvidersSource,
  vercelGatewayModelsSource,
} from '@/lib/providers/openrouter/sync-providers';
import { openRouterProviderModelsSource } from '@/lib/providers/openrouter/fetch-provider-models';
import { modelsDevCatalogSource } from '@/lib/providers/direct-byok/models-dev';
import { refreshMetadataCache } from './refresh-metadata-cache';

const PROVIDER_MODELS_URL_PREFIX = 'https://openrouter.ai/api/frontend/v1/models/find?';
const MODEL_ENDPOINTS_URL_PATTERN = /\/models\/.+\/endpoints$/;
const REFRESH_BUDGET_MS = 180_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let responses: Map<string, () => Response>;
let fetchSpy: jest.SpiedFunction<typeof fetch>;

function respond(url: string, response: () => Response) {
  responses.set(url, response);
}

function provider(name: string) {
  return {
    name,
    displayName: name,
    slug: name.toLowerCase(),
    dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
  };
}

function providers(count: number, prefix = 'Provider') {
  return Array.from({ length: count }, (_, index) => provider(`${prefix} ${index}`));
}

function catalogModels() {
  return {
    data: Array.from({ length: 100 }, (_, index) => ({
      ...mockOpenRouterModels.data[0],
      id: `vendor/model-${index}`,
    })),
  };
}

function gatewayModelIds(prefix = 'vendor') {
  return Array.from({ length: 100 }, (_, index) => `${prefix}/model-${index}`);
}

function gatewayModels(prefix = 'vendor') {
  return {
    data: gatewayModelIds(prefix).map((id, index) => ({ id, name: `Model ${index}` })),
  };
}

function openRouterEndpointsUrl(modelId: string) {
  return gatewayModelEndpointsSource(OPENROUTER, modelId).url;
}

function vercelEndpointsUrl(modelId: string) {
  return gatewayModelEndpointsSource(VERCEL_AI_GATEWAY, modelId).url;
}

function modelsDevCatalog() {
  return Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`provider-${index}`, { models: {} }])
  );
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

async function storeRow(url: string, data: unknown, updatedAt: string) {
  await db.insert(ai_gateway_metadata_cache).values({ url, data, updated_at: updatedAt });
}

async function readRow(url: string) {
  const [row] = await db
    .select()
    .from(ai_gateway_metadata_cache)
    .where(eq(ai_gateway_metadata_cache.url, url));
  return row;
}

function fetchedUrls() {
  return fetchSpy.mock.calls.map(([input]) => String(input));
}

function fetchedEndpointsUrls(gatewayApiUrl: string) {
  return fetchedUrls().filter(
    url => url.startsWith(`${gatewayApiUrl}/models/`) && MODEL_ENDPOINTS_URL_PATTERN.test(url)
  );
}

beforeEach(async () => {
  await db.delete(ai_gateway_metadata_cache).where(sql`true`);
  responses = new Map([
    [openAiServedModelsMetadataSource.url, () => Response.json({ data: [{ id: 'gpt-test' }] })],
    [openRouterModelsMetadataSource.url, () => Response.json(catalogModels())],
    [
      openRouterTranscriptionModelsMetadataSource.url,
      () => Response.json({ data: mockOpenRouterModels.data.slice(0, 1) }),
    ],
    [openRouterGatewayModelsSource.url, () => Response.json(gatewayModels())],
    [vercelGatewayModelsSource.url, () => Response.json(gatewayModels())],
    [openRouterProvidersSource.url, () => Response.json({ data: providers(10) })],
    [modelsDevCatalogSource.url, () => Response.json(modelsDevCatalog())],
  ]);
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    const response = responses.get(url);
    if (response) return response();
    if (url.startsWith(PROVIDER_MODELS_URL_PREFIX)) {
      return Response.json({ data: { models: [] } });
    }
    if (MODEL_ENDPOINTS_URL_PATTERN.test(url)) {
      return Response.json({ data: { endpoints: [] } });
    }
    return Response.json({ data: [{ id: 'vendor/model' }] });
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(alertIfMetadataCacheStale).mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('refreshMetadataCache', () => {
  it('stores every fetched body once and bumps updated_at', async () => {
    const oldUpdatedAt = '2020-01-01T00:00:00.000Z';
    const catalog = { ...modelsDevCatalog(), openrouter: { models: {} } };
    await storeRow(modelsDevCatalogSource.url, { previous: true }, oldUpdatedAt);
    respond(modelsDevCatalogSource.url, () => Response.json(catalog));

    const summary = await refreshMetadataCache();

    const row = await readRow(modelsDevCatalogSource.url);
    expect(row.data).toEqual(catalog);
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(Date.parse(oldUpdatedAt));
    const rows = await db
      .select({ url: ai_gateway_metadata_cache.url })
      .from(ai_gateway_metadata_cache);
    expect(rows.map(stored => stored.url).sort()).toEqual([...new Set(fetchedUrls())].sort());
    expect(summary).toEqual({
      source_count: fetchedUrls().length,
      failed_count: 0,
      stale_count: 0,
    });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledWith([]);
  });

  it.each([
    ['an error status', () => new Response(null, { status: 503, statusText: 'Unavailable' })],
    ['a body that does not parse', () => Response.json({ data: 'not-a-list' })],
    ['a suspiciously short list', () => Response.json({ data: [] })],
    [
      'a NUL character, which jsonb cannot store',
      () =>
        Response.json({
          data: catalogModels().data.map(model => ({ ...model, name: 'bad\u0000name' })),
        }),
    ],
  ])('keeps the stored row untouched when the source returns %s', async (_label, response) => {
    await storeRow(openRouterModelsMetadataSource.url, { data: [] }, hoursAgo(1));
    const before = await readRow(openRouterModelsMetadataSource.url);
    respond(openRouterModelsMetadataSource.url, response);

    const summary = await refreshMetadataCache();

    expect(await readRow(openRouterModelsMetadataSource.url)).toEqual(before);
    expect(summary).toMatchObject({ failed_count: 1, stale_count: 0 });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledWith([]);
  });

  it('keeps an unchanged body and still bumps updated_at', async () => {
    const oldUpdatedAt = '2020-01-01T00:00:00.000Z';
    await storeRow(modelsDevCatalogSource.url, modelsDevCatalog(), oldUpdatedAt);

    await refreshMetadataCache();

    const row = await readRow(modelsDevCatalogSource.url);
    expect(row.data).toEqual(modelsDevCatalog());
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(Date.parse(oldUpdatedAt));
  });

  it('finishes every other write before failing the run on a database write error', async () => {
    const insert = db.insert.bind(db);
    let insertCalls = 0;
    jest.spyOn(db, 'insert').mockImplementation(table => {
      insertCalls += 1;
      if (insertCalls === 1) throw new Error('write failed');
      return insert(table);
    });

    await expect(refreshMetadataCache()).rejects.toThrow('write failed');

    const rows = await db
      .select({ url: ai_gateway_metadata_cache.url })
      .from(ai_gateway_metadata_cache);
    expect(rows).toHaveLength(new Set(fetchedUrls()).size - 1);
    expect(fetchedUrls().some(url => url.startsWith(PROVIDER_MODELS_URL_PREFIX))).toBe(false);
    expect(alertIfMetadataCacheStale).not.toHaveBeenCalled();
  });

  it('refreshes the model list of each fetched provider', async () => {
    respond(openRouterProvidersSource.url, () =>
      Response.json({ data: [provider('OpenAI'), provider('Amazon Bedrock'), ...providers(8)] })
    );

    await refreshMetadataCache();

    for (const name of ['OpenAI', 'Amazon Bedrock']) {
      const row = await readRow(openRouterProviderModelsSource(name).url);
      expect(row?.data).toEqual({ data: { models: [] } });
    }
  });

  it('refreshes provider model lists from the stored providers list when the live list fails', async () => {
    await storeRow(openRouterProvidersSource.url, providers(10, 'Stored'), hoursAgo(1));
    respond(openRouterProvidersSource.url, () => new Response(null, { status: 503 }));

    const summary = await refreshMetadataCache();

    expect(fetchedUrls()).toContain(openRouterProviderModelsSource('Stored 0').url);
    expect(fetchedUrls().filter(url => url.startsWith(PROVIDER_MODELS_URL_PREFIX))).toHaveLength(
      10
    );
    expect(summary).toMatchObject({ failed_count: 1, stale_count: 0 });
  });

  it('refreshes sources without a row first, then the oldest rows', async () => {
    await storeRow(modelsDevCatalogSource.url, modelsDevCatalog(), hoursAgo(1));
    await storeRow(openRouterModelsMetadataSource.url, catalogModels(), hoursAgo(48));

    await refreshMetadataCache();

    const urls = fetchedUrls().filter(
      url => !url.startsWith(PROVIDER_MODELS_URL_PREFIX) && !MODEL_ENDPOINTS_URL_PATTERN.test(url)
    );
    expect(urls.at(-1)).toBe(modelsDevCatalogSource.url);
    expect(urls.at(-2)).toBe(openRouterModelsMetadataSource.url);
  });

  it('alerts only for failed sources last stored over a day ago or never stored', async () => {
    const staleUpdatedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    await storeRow(openRouterModelsMetadataSource.url, { data: [] }, staleUpdatedAt);
    await storeRow(openRouterGatewayModelsSource.url, { data: [] }, hoursAgo(1));
    for (const url of [
      openRouterModelsMetadataSource.url,
      openRouterGatewayModelsSource.url,
      modelsDevCatalogSource.url,
    ]) {
      respond(url, () => new Response(null, { status: 503 }));
    }

    const summary = await refreshMetadataCache();

    expect(summary).toMatchObject({ failed_count: 3, stale_count: 2 });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledTimes(1);
    const [staleEntries] = jest.mocked(alertIfMetadataCacheStale).mock.calls[0] ?? [];
    expect(staleEntries).toHaveLength(2);
    expect(staleEntries).toEqual(
      expect.arrayContaining([
        { url: openRouterModelsMetadataSource.url, updatedAt: new Date(staleUpdatedAt) },
        { url: modelsDevCatalogSource.url, updatedAt: null },
      ])
    );
  });

  it('refreshes the endpoints of every model in both stored gateway lists, oldest first', async () => {
    await storeRow(
      openRouterEndpointsUrl('vendor/model-3'),
      { data: { endpoints: [] } },
      hoursAgo(1)
    );
    await storeRow(
      openRouterEndpointsUrl('vendor/model-5'),
      { data: { endpoints: [] } },
      hoursAgo(48)
    );
    respond(vercelEndpointsUrl('vendor/model-0'), () =>
      Response.json({ data: { endpoints: [{ provider_name: 'test' }] } })
    );

    const summary = await refreshMetadataCache();

    const openRouterUrls = fetchedEndpointsUrls(OPENROUTER.apiUrl);
    expect(openRouterUrls.toSorted()).toEqual(gatewayModelIds().map(openRouterEndpointsUrl).sort());
    expect(openRouterUrls.at(-1)).toBe(openRouterEndpointsUrl('vendor/model-3'));
    expect(openRouterUrls.at(-2)).toBe(openRouterEndpointsUrl('vendor/model-5'));
    expect(fetchedEndpointsUrls(VERCEL_AI_GATEWAY.apiUrl).toSorted()).toEqual(
      gatewayModelIds().map(vercelEndpointsUrl).sort()
    );
    expect((await readRow(vercelEndpointsUrl('vendor/model-0'))).data).toEqual({
      data: { endpoints: [{ provider_name: 'test' }] },
    });
    expect(summary).toEqual({
      source_count: fetchedUrls().length,
      failed_count: 0,
      stale_count: 0,
    });
  });

  it('stores a missing endpoints resource without counting it as failed', async () => {
    respond(openRouterEndpointsUrl('vendor/model-4'), () => new Response(null, { status: 404 }));

    const summary = await refreshMetadataCache();

    expect((await readRow(openRouterEndpointsUrl('vendor/model-4'))).data).toEqual({
      status: 404,
    });
    expect(summary).toMatchObject({ failed_count: 0, stale_count: 0 });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledWith([]);
  });

  it('alerts only for failed endpoints sources stored over a day ago, grouped per gateway', async () => {
    const staleUrl = openRouterEndpointsUrl('vendor/model-1');
    const neverStoredUrl = openRouterEndpointsUrl('vendor/model-2');
    const staleUpdatedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    await storeRow(
      staleUrl,
      { data: { endpoints: [{ provider_name: 'stored' }] } },
      staleUpdatedAt
    );
    const before = await readRow(staleUrl);
    for (const url of [staleUrl, neverStoredUrl]) {
      respond(url, () => new Response(null, { status: 503 }));
    }

    const summary = await refreshMetadataCache();

    expect(await readRow(staleUrl)).toEqual(before);
    expect(await readRow(neverStoredUrl)).toBeUndefined();
    expect(summary).toMatchObject({ failed_count: 2, stale_count: 1 });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledWith([
      {
        url: staleUrl,
        updatedAt: new Date(staleUpdatedAt),
        group: 'https://openrouter.ai/api/v1/models/{id}/endpoints',
      },
    ]);
  });

  it('refreshes model endpoints from the stored gateway list when the live list fails', async () => {
    await storeRow(vercelGatewayModelsSource.url, gatewayModels('stored'), hoursAgo(1));
    respond(vercelGatewayModelsSource.url, () => new Response(null, { status: 503 }));

    const summary = await refreshMetadataCache();

    expect(fetchedEndpointsUrls(VERCEL_AI_GATEWAY.apiUrl).toSorted()).toEqual(
      gatewayModelIds('stored').map(vercelEndpointsUrl).sort()
    );
    expect(summary).toMatchObject({ failed_count: 1, stale_count: 0 });
  });

  it('stops refreshing model endpoints once the run budget is spent', async () => {
    const budget = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(ms => (ms === REFRESH_BUDGET_MS ? budget.signal : timeout(ms)));
    const fetchResponse = fetchSpy.getMockImplementation();
    fetchSpy.mockImplementation(async (input, init) => {
      if (MODEL_ENDPOINTS_URL_PATTERN.test(String(input))) budget.abort();
      if (!fetchResponse) throw new Error('fetch mock is missing');
      return fetchResponse(input, init);
    });

    const summary = await refreshMetadataCache();

    const endpointsUrls = fetchedUrls().filter(url => MODEL_ENDPOINTS_URL_PATTERN.test(url));
    expect(endpointsUrls).toHaveLength(1);
    expect(summary).toMatchObject({ failed_count: 199, stale_count: 0 });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledWith([]);
  });
});
