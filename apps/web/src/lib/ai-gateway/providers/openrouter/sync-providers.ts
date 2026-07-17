import pLimit from 'p-limit';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { normalizeModelId } from '@/lib/ai-gateway/providers/openrouter';
import {
  convertFromKiloExclusiveModel,
  getInferenceProvider,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  OpenRouterProvidersResponse,
  OpenRouterSearchResponse,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { modelsByProvider } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { desc, lt, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { logAutoModelChangesForAllOrgs } from '@/lib/organizations/auto-model-change-log';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import type { StoredModel } from '@kilocode/db/schema-types';
import { EndpointsSchema, ModelsSchema } from '@kilocode/db/schema-types';
import { redisClient } from '@/lib/redis';
import {
  GATEWAY_METADATA_REDIS_KEYS,
  type RedisKey,
  vercelInferenceProvidersRedisKey,
} from '@/lib/redis-keys';
import {
  extractVercelInferenceProviderIdsFromModel,
  getLanguageModelIds,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { syncDirectByokModels } from '@/lib/ai-gateway/providers/direct-byok/sync-direct-byok';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  openRouterToVercelInferenceProviderId,
  VercelUserByokInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

/**
 * Advisory lock key hashed from a stable identifier. Serializes concurrent
 * calls to `applySnapshotChangesAndAudit` so two overlapping syncs cannot
 * both read the same "previous" snapshot and emit duplicate system audit
 * logs for the same diff. Auto-releases on transaction commit/rollback.
 */
const SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY = 'sync-providers:snapshot';
const VERCEL_INFERENCE_PROVIDERS_TTL_SECONDS = 7 * 24 * 60 * 60;

async function mirrorVercelInferenceProvidersToRedis(vercelModels: Record<string, StoredModel>) {
  const pipeline = redisClient.pipeline();
  for (const model of Object.values(vercelModels)) {
    pipeline.set(
      vercelInferenceProvidersRedisKey(model.id),
      JSON.stringify(extractVercelInferenceProviderIdsFromModel(model)),
      { ex: VERCEL_INFERENCE_PROVIDERS_TTL_SECONDS }
    );
  }
  await pipeline.exec();
}

async function fetchGatewayModels(gateway: Provider) {
  const headers = {
    ...ATTRIBUTION_HEADERS,
    authorization: `Bearer ${gateway.apiKey}`,
  };

  const modelsResponse = await fetch(`${gateway.apiUrl}/models`, {
    method: 'GET',
    headers,
  });
  if (!modelsResponse.ok) {
    throw new Error(`Fetching models from ${gateway.id} failed: ${modelsResponse.status}`);
  }
  const models = ModelsSchema.parse(await modelsResponse.json());

  const limit = pLimit(8);
  const result: Record<string, StoredModel> = {};
  await Promise.all(
    models.data.map(model =>
      limit(async () => {
        const endpointsResponse = await fetch(`${gateway.apiUrl}/models/${model.id}/endpoints`, {
          method: 'GET',
          headers,
        });
        if (!endpointsResponse.ok) {
          throw new Error(
            `Fetching model endpoints for ${gateway.id}/${model.id} failed: ${endpointsResponse.status}`
          );
        }
        const endpoints = EndpointsSchema.parse(await endpointsResponse.json());
        result[model.id] = {
          ...model,
          endpoints: endpoints.data.endpoints,
        };
      })
    )
  );

  const count = Object.keys(result).length;
  if (count < 100) {
    throw new Error(`Suspicious: total number of ${gateway.id} models is ${count} < 100`);
  }
  console.debug(`[fetchGatewayModels] fetched ${count} models from ${gateway.id}`);

  return result;
}

async function fetchProviders(): Promise<OpenRouterProvider[]> {
  console.log('Fetching OpenRouter providers from frontend endpoint...');

  const response = await fetch(`https://openrouter.ai/api/frontend/v1/all-providers`, {
    method: 'GET',
    headers: ATTRIBUTION_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter providers: ${response.status} ${response.statusText}`
    );
  }

  const rawData = await response.json();
  console.log(
    'Raw response structure:',
    JSON.stringify(rawData, null, 2).substring(0, 500) + '...'
  );

  const parsedData = OpenRouterProvidersResponse.parse(rawData);

  // Handle both response formats
  const providers = Array.isArray(parsedData) ? parsedData : parsedData.data;
  console.log(`Found ${providers.length} providers from endpoint`);

  return providers;
}

async function fetchModelsForProvider(provider: OpenRouterProvider): Promise<OpenRouterModel[]> {
  console.log(`Fetching models for provider: ${provider.name} (${provider.slug})`);

  // Use the frontend API endpoint with provider filter
  const searchParams = new URLSearchParams({
    providers: provider.name,
    fmt: 'cards',
  });

  console.log(
    'GET',
    `https://openrouter.ai/api/frontend/v1/models/find?${searchParams.toString()}`
  );

  const response = await fetch(
    `https://openrouter.ai/api/frontend/v1/models/find?${searchParams}`,
    {
      method: 'GET',
      headers: ATTRIBUTION_HEADERS,
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch models for provider ${provider.name}: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json().then(d => OpenRouterSearchResponse.parse(d));

  console.log(`  Found ${data.data.models.length} models for provider ${provider.name}`);

  // Note: Models still contain redundant provider info in endpoint.provider_info, etc.
  // This is now available in the comprehensive providers array, but we keep it for compatibility
  return data.data.models;
}

function injectExtraUserByokModels(
  vercelModels: Record<string, StoredModel>,
  providerModelData: Array<{ provider: OpenRouterProvider; models: OpenRouterModel[] }>
) {
  const openRouterModels = new Map<string, OpenRouterModel>();
  for (const { models } of providerModelData) {
    for (const model of models) {
      openRouterModels.set(model.slug, model);
    }
  }
  for (const model of openRouterModels.values()) {
    const vercelModel = vercelModels[mapModelIdToVercel(model.slug)];
    if (!vercelModel) continue;

    const vercelInferenceProviders = new Set(
      vercelModel.endpoints
        .map(
          endpoint =>
            VercelUserByokInferenceProviderIdSchema.safeParse(
              endpoint.provider_name ?? endpoint.tag
            ).data
        )
        .filter(p => p !== undefined)
    );

    for (const providerData of providerModelData) {
      const vercelProviderId = VercelUserByokInferenceProviderIdSchema.safeParse(
        openRouterToVercelInferenceProviderId(providerData.provider.slug)
      ).data;
      const endpoint = vercelModel.endpoints.find(e => e.provider_name === vercelProviderId);
      if (
        vercelProviderId &&
        endpoint &&
        vercelInferenceProviders.has(vercelProviderId) &&
        !providerData.models.some(m => m.slug === model.slug)
      ) {
        const freeSuffixIndex = model.name.indexOf(' (free)');
        const m = {
          ...model,
          name: freeSuffixIndex >= 0 ? model.name.substring(0, freeSuffixIndex) : model.name,
          context_length: endpoint.context_length ?? model.context_length,
          endpoint: {
            ...model.endpoint,
            provider_display_name: providerData.provider.displayName,
            is_free: !endpoint.pricing?.prompt,
            pricing: endpoint.pricing ?? { prompt: '0', completion: '0' },
          },
        };
        console.warn(
          '[injectExtraUserByokModels] Adding missing model to user byok provider %s: %s',
          providerData.provider.name,
          m.name
        );
        providerData.models.push(m);
      }
    }
  }
}

async function syncProviders(
  providers: OpenRouterProvider[],
  vercelModels: Record<string, StoredModel>
) {
  if (providers.length === 0) {
    throw new Error('No providers found in OpenRouter response');
  }

  // Limit concurrent requests to 3
  const limit = pLimit(3);
  let processedCount = 0;

  console.log('Fetching models for all providers...');

  // Fetch models for each provider and collect relationships
  const providerModelData = await Promise.all(
    providers.map(provider =>
      limit(async () => {
        const models = await fetchModelsForProvider(provider);

        processedCount++;
        if (processedCount % 10 === 0) {
          console.log(`Processed ${processedCount}/${providers.length} providers...`);
        }

        return {
          provider,
          models,
        };
      })
    )
  );

  injectExtraUserByokModels(vercelModels, providerModelData);

  const mappedExtraModels = kiloExclusiveModels
    .flatMap(kfm => {
      if (kfm.status !== 'public') return [];
      const inferenceProvider = getInferenceProvider(kfm);
      if (!inferenceProvider) return [];
      return [{ kfm, inferenceProvider }];
    })
    .map(({ kfm, inferenceProvider }) => {
      const model = convertFromKiloExclusiveModel(kfm);
      return {
        model: {
          slug: normalizeModelId(model.id),
          name: model.name,
          author: 'Other',
          description: model.description,
          context_length: model.context_length,
          input_modalities: model.architecture.input_modalities,
          output_modalities: model.architecture.output_modalities,
          group: 'other',
          updated_at: new Date().toISOString(),
          endpoint: {
            provider_display_name: 'Other',
            is_free: !kfm.pricing,
            pricing: {
              prompt: model.pricing.prompt,
              completion: model.pricing.completion,
            },
          },
        },
        provider: inferenceProvider,
      };
    });

  for (const extraModel of mappedExtraModels) {
    const providerData = providerModelData.find(
      data => data.provider.slug === extraModel.provider.slug
    );
    if (providerData) {
      console.log(
        `Found existing ${extraModel.provider} provider from OpenRouter, adding extra model ${extraModel.model.slug}`
      );
      providerData.models.splice(0, 0, extraModel.model);
    }
  }

  // Filter out providers with no models
  const filteredProviderModelData = providerModelData.filter(data => data.models.length > 0);

  // Create simplified structure with providers containing their models directly
  const normalizedProviders: NormalizedProvider[] = filteredProviderModelData.map(data => {
    // Deduplicate models within each provider by slug
    const uniqueModelsMap = new Map<string, OpenRouterModel>();
    data.models.forEach(model => {
      uniqueModelsMap.set(normalizeModelId(model.slug), model);
    });
    const uniqueModels = Array.from(uniqueModelsMap.values());

    // Sort models by name
    uniqueModels.sort((a, b) => a.name.localeCompare(b.name));

    return {
      name: data.provider.name,
      displayName: data.provider.displayName,
      slug: data.provider.slug,
      dataPolicy: {
        training: data.provider.dataPolicy.training,
        retainsPrompts: data.provider.dataPolicy.retainsPrompts,
        canPublish: data.provider.dataPolicy.canPublish,
      },
      headquarters: data.provider.headquarters,
      datacenters: data.provider.datacenters,
      icon: data.provider.icon,
      models: uniqueModels, // Use deduplicated and sorted models
    };
  });

  const allProviders = [...normalizedProviders];

  // Auto-detect providers referenced by extra models that aren't already present
  const missingProviders = new Map(
    mappedExtraModels
      .map(m => m.provider)
      .filter(provider => !allProviders.some(p => p.slug === provider.slug))
      .map(provider => [provider.slug, provider])
  );

  for (const provider of missingProviders.values()) {
    const iconInitials = provider.slug.slice(0, 2).toUpperCase();
    allProviders.push({
      name: provider.name,
      displayName: provider.name,
      slug: provider.slug,
      dataPolicy: {
        training: provider.training,
        retainsPrompts: provider.retainsPrompts,
        canPublish: false,
      },
      headquarters: 'Unknown',
      datacenters: ['Global'],
      icon: {
        url: `https://placehold.co/100?text=${iconInitials}&font=roboto`,
        className: 'rounded-sm',
      },
      models: mappedExtraModels.filter(m => m.provider.slug === provider.slug).map(m => m.model),
    });
  }

  // Sort providers by name
  const sortedProviders = allProviders.sort((a, b) => a.name.localeCompare(b.name));

  // Calculate total models across all providers
  const totalModels = sortedProviders.reduce((sum, provider) => sum + provider.models.length, 0);

  const result: NormalizedOpenRouterResponse = {
    providers: sortedProviders,
    total_providers: sortedProviders.length,
    total_models: totalModels,
    generated_at: new Date().toISOString(),
  };

  return result;
}

const MODEL_METADATA_REDIS_TTL_SECONDS = 7 * 24 * 60 * 60;

async function mirrorToRedis(values: {
  providers: NormalizedOpenRouterResponse;
  openrouter: Record<string, StoredModel>;
  vercel: Record<string, StoredModel>;
  openrouterProviders: OpenRouterProvider[];
}): Promise<void> {
  const entries: [RedisKey, unknown][] = [
    [GATEWAY_METADATA_REDIS_KEYS.allProviders, values.providers],
    [GATEWAY_METADATA_REDIS_KEYS.openrouterModels, values.openrouter],
    [GATEWAY_METADATA_REDIS_KEYS.vercelModels, values.vercel],
    [GATEWAY_METADATA_REDIS_KEYS.openrouterModelIds, getLanguageModelIds(values.openrouter)],
    [GATEWAY_METADATA_REDIS_KEYS.vercelModelIds, getLanguageModelIds(values.vercel)],
  ];
  if (values.openrouterProviders) {
    entries.push([GATEWAY_METADATA_REDIS_KEYS.openrouterProviders, values.openrouterProviders]);
  }
  await Promise.all([
    ...entries.map(([key, value]) => {
      const serializedValue = JSON.stringify(value);
      if (
        key === GATEWAY_METADATA_REDIS_KEYS.openrouterModels ||
        key === GATEWAY_METADATA_REDIS_KEYS.vercelModels
      ) {
        return redisClient.set(key, serializedValue, { ex: MODEL_METADATA_REDIS_TTL_SECONDS });
      }
      return redisClient.set(key, serializedValue);
    }),
    mirrorVercelInferenceProvidersToRedis(values.vercel),
  ]);
}

/**
 * Apply a freshly-synced OpenRouter snapshot to the database and emit
 * per-org audit log entries describing how it affects each enterprise
 * organization's effective model availability.
 *
 * Extracted from `syncAndStoreProviders` so it can be tested without
 * mocking upstream HTTP calls: seed the DB with a prior snapshot row, call
 * this with a new synthetic snapshot, and assert on the resulting rows in
 * `organization_audit_logs`.
 *
 * Concurrency safety: a transaction-scoped Postgres advisory lock
 * (`pg_advisory_xact_lock`) is taken before the previous-snapshot read so
 * two overlapping sync runs cannot both observe the same "previous" row
 * and emit duplicate system audit logs for the same diff. The lock is
 * released automatically on commit/rollback.
 */
export async function applySnapshotChangesAndAudit(params: {
  providers: NormalizedOpenRouterResponse;
  openrouter_data: Record<string, StoredModel>;
  vercel_data: Record<string, StoredModel>;
}): Promise<{
  id: number;
  data: NormalizedOpenRouterResponse;
  previousSnapshot: NormalizedOpenRouterResponse | null;
}> {
  const { providers, openrouter_data, vercel_data } = params;

  const { row, previousSnapshot } = await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY}))`
    );

    const [previousSnapshotRow] = await tx
      .select({ data: modelsByProvider.data })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1);
    const previousSnapshot = previousSnapshotRow?.data ?? null;

    const results = await tx
      .insert(modelsByProvider)
      .values({
        data: providers,
        openrouter: openrouter_data,
        vercel: vercel_data,
      })
      .returning();
    await tx.delete(modelsByProvider).where(lt(modelsByProvider.id, results[0].id));
    return { row: results[0], previousSnapshot };
  });

  try {
    await logAutoModelChangesForAllOrgs(previousSnapshot, providers);
  } catch (err) {
    console.error('[sync-providers] auto-change audit logging failed', err);
    captureException(err, { tags: { component: 'sync-providers-auto-audit' } });
  }

  return { id: row.id, data: row.data, previousSnapshot };
}

export async function syncAndStoreProviders() {
  const startTime = performance.now();

  const openrouter_data = await fetchGatewayModels(PROVIDERS.OPENROUTER);
  const vercel_data = await fetchGatewayModels(PROVIDERS.VERCEL_AI_GATEWAY);

  const openrouterProviders = await fetchProviders();
  if (openrouterProviders.length < 10) {
    throw new Error(
      `Suspicious: total number of OpenRouter API providers is ${openrouterProviders.length} < 10`
    );
  }

  const providers = await syncProviders(openrouterProviders, vercel_data);

  if (providers.total_providers < 10) {
    throw new Error(`Suspicious: total number of providers is ${providers.total_providers} < 10`);
  }

  if (providers.total_models < 100) {
    throw new Error(`Suspicious: total number of models is ${providers.total_models} < 100`);
  }

  const result = await applySnapshotChangesAndAudit({
    providers,
    openrouter_data,
    vercel_data,
  });

  await mirrorToRedis({
    providers,
    openrouter: openrouter_data,
    vercel: vercel_data,
    openrouterProviders,
  });

  const direct_byok_model_counts = await syncDirectByokModels();
  console.log('[syncAndStoreProviders] direct-byok model counts:', direct_byok_model_counts);

  return {
    id: result.id,
    generated_at: result.data.generated_at,
    total_models: result.data.total_models,
    total_providers: result.data.total_providers,
    direct_byok_model_counts,
    time: performance.now() - startTime,
  };
}
