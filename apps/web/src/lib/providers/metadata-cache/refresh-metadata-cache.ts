import 'server-only';

import pLimit from 'p-limit';
import { inArray, sql } from 'drizzle-orm';
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  fetchMetadata,
  readStoredMetadata,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import {
  openRouterModelsMetadataSource,
  openRouterTranscriptionModelsMetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { openAiServedModelsMetadataSource } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/served-models';
import { OPENAI_CHATGPT_API_KEY_ENV } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/upstream';
import {
  openRouterGatewayModelsSource,
  openRouterProvidersSource,
  vercelGatewayModelsSource,
} from '@/lib/providers/openrouter/sync-providers';
import { openRouterProviderModelsSource } from '@/lib/providers/openrouter/fetch-provider-models';
import { modelsDevCatalogSource } from '@/lib/providers/direct-byok/models-dev';
import { directByokMetadataSources } from '@/lib/providers/direct-byok/sync-direct-byok';
import { parseIsoTimestamp } from '@/lib/providers/openrouter/sync-providers-stale-alert';
import {
  METADATA_CACHE_STALE_AFTER_MS,
  alertIfMetadataCacheStale,
  type StaleMetadataEntry,
} from '@/lib/providers/metadata-cache/metadata-cache-stale-alert';

const SOURCE_CONCURRENCY = 4;
const PROVIDER_MODELS_CONCURRENCY = 3;
const REFRESH_BUDGET_MS = 180_000;

function catalogSources(): MetadataSource<unknown>[] {
  const sources: MetadataSource<unknown>[] = [
    openRouterModelsMetadataSource,
    openRouterTranscriptionModelsMetadataSource,
    openRouterGatewayModelsSource,
    vercelGatewayModelsSource,
    openRouterProvidersSource,
    modelsDevCatalogSource,
    ...directByokMetadataSources,
  ];
  if (getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV).trim()) {
    sources.push(openAiServedModelsMetadataSource);
  }
  return [...new Map(sources.map(source => [source.url, source])).values()];
}

async function readUpdatedAtByUrl(urls: string[]): Promise<Map<string, Date | null>> {
  if (urls.length === 0) return new Map();
  const rows = await db
    .select({
      url: ai_gateway_metadata_cache.url,
      updated_at: ai_gateway_metadata_cache.updated_at,
    })
    .from(ai_gateway_metadata_cache)
    .where(inArray(ai_gateway_metadata_cache.url, urls));
  return new Map(rows.map(row => [row.url, parseIsoTimestamp(row.updated_at)]));
}

async function orderOldestFirst<T extends MetadataSource<unknown>>(sources: T[]): Promise<T[]> {
  const updatedAtByUrl = await readUpdatedAtByUrl(sources.map(source => source.url));
  const updatedAtMs = (source: T) =>
    updatedAtByUrl.get(source.url)?.getTime() ?? Number.NEGATIVE_INFINITY;
  return sources.toSorted((a, b) => updatedAtMs(a) - updatedAtMs(b));
}

async function refreshSource(
  source: MetadataSource<unknown>,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  let raw: unknown;
  try {
    ({ raw } = await fetchMetadata(source, { signal }));
  } catch (error) {
    console.error(`[refresh-metadata-cache] refreshing ${source.url} failed`, error);
    return false;
  }
  await db
    .insert(ai_gateway_metadata_cache)
    .values({ url: source.url, data: raw })
    .onConflictDoUpdate({
      target: ai_gateway_metadata_cache.url,
      set: { data: raw, updated_at: sql`now()` },
    });
  return true;
}

async function refreshSources(
  sources: MetadataSource<unknown>[],
  concurrency: number,
  signal: AbortSignal
): Promise<string[]> {
  const limit = pLimit(concurrency);
  const results = await Promise.all(
    (await orderOldestFirst(sources)).map(source =>
      limit(async () => ({ url: source.url, ok: await refreshSource(source, signal) }))
    )
  );
  return results.filter(result => !result.ok).map(result => result.url);
}

async function findStaleEntries(failedUrls: string[], now: Date): Promise<StaleMetadataEntry[]> {
  const updatedAtByUrl = await readUpdatedAtByUrl(failedUrls);
  return failedUrls
    .map(url => ({ url, updatedAt: updatedAtByUrl.get(url) ?? null }))
    .filter(
      entry =>
        entry.updatedAt === null ||
        now.getTime() - entry.updatedAt.getTime() >= METADATA_CACHE_STALE_AFTER_MS
    );
}

export async function refreshMetadataCache() {
  const budget = AbortSignal.timeout(REFRESH_BUDGET_MS);
  const sources = catalogSources();
  const failedUrls = await refreshSources(sources, SOURCE_CONCURRENCY, budget);

  const providers = (await readStoredMetadata(openRouterProvidersSource, db)) ?? [];
  const providerModelsSources = providers.map(provider =>
    openRouterProviderModelsSource(provider.name)
  );
  failedUrls.push(
    ...(await refreshSources(providerModelsSources, PROVIDER_MODELS_CONCURRENCY, budget))
  );

  const staleEntries = await findStaleEntries(failedUrls, new Date());
  await alertIfMetadataCacheStale(staleEntries);

  return {
    source_count: sources.length + providerModelsSources.length,
    failed_count: failedUrls.length,
    stale_count: staleEntries.length,
  };
}
