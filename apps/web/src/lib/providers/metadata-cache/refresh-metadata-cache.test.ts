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
import type * as StaleAlert from '@/lib/providers/metadata-cache/metadata-cache-stale-alert';

jest.mock('@/lib/providers/metadata-cache/metadata-cache-stale-alert', () => ({
  ...jest.requireActual<typeof StaleAlert>(
    '@/lib/providers/metadata-cache/metadata-cache-stale-alert'
  ),
  alertIfMetadataCacheStale: jest.fn(),
}));

import { alertIfMetadataCacheStale } from '@/lib/providers/metadata-cache/metadata-cache-stale-alert';
import {
  openRouterGatewayModelsSource,
  openRouterProvidersSource,
  vercelGatewayModelsSource,
} from '@/lib/providers/openrouter/sync-providers';
import { openRouterProviderModelsSource } from '@/lib/providers/openrouter/fetch-provider-models';
import { modelsDevCatalogSource } from '@/lib/providers/direct-byok/models-dev';
import { refreshMetadataCache } from './refresh-metadata-cache';

const PROVIDER_MODELS_URL_PREFIX = 'https://openrouter.ai/api/frontend/v1/models/find?';
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

function gatewayModels() {
  return {
    data: Array.from({ length: 100 }, (_, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
    })),
  };
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
    return Response.json({ data: [] });
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
  ])('keeps the stored row untouched when the source returns %s', async (_label, response) => {
    await storeRow(openRouterModelsMetadataSource.url, { data: [] }, hoursAgo(1));
    const before = await readRow(openRouterModelsMetadataSource.url);
    respond(openRouterModelsMetadataSource.url, response);

    const summary = await refreshMetadataCache();

    expect(await readRow(openRouterModelsMetadataSource.url)).toEqual(before);
    expect(summary).toMatchObject({ failed_count: 1, stale_count: 0 });
    expect(alertIfMetadataCacheStale).toHaveBeenCalledWith([]);
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
});
