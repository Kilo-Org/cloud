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
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  gatewayModelEndpointsSource,
  gatewayModelEndpointsUrl,
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
const MODEL_ENDPOINTS_CONCURRENCY_PER_GATEWAY = 8;
const REFRESH_BUDGET_MS = 180_000;
const ESCAPED_NUL_PATTERN = /(?:^|[^\\])(?:\\\\)*\\u0000/;

const GATEWAY_MODEL_LISTS = [
  { gateway: OPENROUTER, modelsSource: openRouterGatewayModelsSource },
  { gateway: VERCEL_AI_GATEWAY, modelsSource: vercelGatewayModelsSource },
];

type ModelEndpointsGroup = {
  urlPattern: string;
  sources: MetadataSource<unknown>[];
};

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
    // jsonb rejects NUL characters, so such a payload would fail the write on every run.
    if (ESCAPED_NUL_PATTERN.test(JSON.stringify(raw))) {
      throw new Error(`${source.url} returned a NUL character, which jsonb cannot store`);
    }
  } catch (error) {
    console.error(`[refresh-metadata-cache] refreshing ${source.url} failed`, error);
    return false;
  }
  await db
    .insert(ai_gateway_metadata_cache)
    .values({ url: source.url, data: raw })
    .onConflictDoUpdate({
      target: ai_gateway_metadata_cache.url,
      // Keeping the stored value when it is unchanged reuses its TOAST data instead of rewriting
      // the whole catalog, which cuts the write-ahead log of a typical run from ~19 MB to ~50 kB.
      set: {
        data: sql`case when ${ai_gateway_metadata_cache.data} = excluded.data then ${ai_gateway_metadata_cache.data} else excluded.data end`,
        updated_at: sql`now()`,
      },
    });
  return true;
}

// Settle every task before rethrowing a write failure, so no queued write outlives the run.
async function settleAll<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);
  const writeFailure = results.find(result => result.status === 'rejected');
  if (writeFailure) throw writeFailure.reason;
  return results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
}

async function refreshSources(
  sources: MetadataSource<unknown>[],
  concurrency: number,
  signal: AbortSignal
): Promise<string[]> {
  const limit = pLimit(concurrency);
  const ordered = await orderOldestFirst(sources);
  const refreshed = await settleAll(
    ordered.map(source => limit(() => refreshSource(source, signal)))
  );
  return ordered.filter((_source, index) => !refreshed[index]).map(source => source.url);
}

async function readModelEndpointsGroups(): Promise<ModelEndpointsGroup[]> {
  return Promise.all(
    GATEWAY_MODEL_LISTS.map(async ({ gateway, modelsSource }) => {
      const models = await readStoredMetadata(modelsSource, db);
      return {
        urlPattern: gatewayModelEndpointsUrl(gateway, '{id}'),
        sources: (models?.data ?? []).map(model => gatewayModelEndpointsSource(gateway, model.id)),
      };
    })
  );
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

// sync-providers fetches a model's endpoints live until they are first stored, and new models
// appear often, so a failed first fetch is not stale: it would otherwise alert on a single error.
async function findStaleModelEndpointsEntries(
  urlPattern: string,
  failedUrls: string[],
  now: Date
): Promise<StaleMetadataEntry[]> {
  const entries = await findStaleEntries(failedUrls, now);
  return entries
    .filter(entry => entry.updatedAt !== null)
    .map(entry => ({ ...entry, group: urlPattern }));
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

  const modelEndpointsResults = await settleAll(
    (await readModelEndpointsGroups()).map(async group => ({
      group,
      failedUrls: await refreshSources(
        group.sources,
        MODEL_ENDPOINTS_CONCURRENCY_PER_GATEWAY,
        budget
      ),
    }))
  );

  const now = new Date();
  const staleModelEndpointsEntries = await Promise.all(
    modelEndpointsResults.map(result =>
      findStaleModelEndpointsEntries(result.group.urlPattern, result.failedUrls, now)
    )
  );
  const staleEntries = [
    ...(await findStaleEntries(failedUrls, now)),
    ...staleModelEndpointsEntries.flat(),
  ];
  await alertIfMetadataCacheStale(staleEntries);

  const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);
  return {
    source_count:
      sources.length +
      providerModelsSources.length +
      sum(modelEndpointsResults.map(result => result.group.sources.length)),
    failed_count:
      failedUrls.length + sum(modelEndpointsResults.map(result => result.failedUrls.length)),
    stale_count: staleEntries.length,
  };
}
