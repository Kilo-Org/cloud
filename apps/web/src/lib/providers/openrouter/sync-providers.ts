import pLimit from 'p-limit';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  getRawOpenRouterModels,
  normalizeModelId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import {
  convertFromKiloExclusiveModel,
  getInferenceProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { OpenRouterProvidersResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { fetchModelsForProvider } from '@/lib/providers/openrouter/fetch-provider-models';
import { ai_gateway_sync_providers_state, modelsByProvider } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { desc, eq, lt, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { logAutoModelChangesForAllOrgs } from '@/lib/organizations/auto-model-change-log';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { StoredModel, SyncProvidersRefreshFailures } from '@kilocode/db/schema-types';
import { EndpointsSchema, ModelsSchema } from '@kilocode/db/schema-types';
import { describeEntryFailure, fetchSyncJson } from '@/lib/providers/openrouter/sync-fetch';
import { syncDirectByokModels } from '@/lib/providers/direct-byok/sync-direct-byok';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import {
  applyFreeEndpointDataPolicy,
  getOpenRouterFreeEndpoints,
} from '@/lib/providers/openrouter/free-endpoint-data-policy';
import { injectExtraProviderModels } from '@/lib/providers/openrouter/inject-extra-provider-models';
import { withWorstProviderDataPolicy } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/model-data-policy';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { injectSupportedFimModels } from '@kilocode/web-shared/lib/ai-gateway/supported-fim-models';
import { injectVirtualModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import type { OpenRouterModel as CatalogModel } from '@kilocode/web-shared/lib/organizations/organization-types';

/**
 * Advisory lock key hashed from a stable identifier. Serializes concurrent
 * calls to `applySnapshotChangesAndAudit` so two overlapping syncs cannot
 * both read the same "previous" snapshot and emit duplicate system audit
 * logs for the same diff. Auto-releases on transaction commit/rollback.
 */
const SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY = 'sync-providers:snapshot';

/**
 * Upper bound on the share of per-model or per-provider requests that may be served from
 * the previous snapshot in one run. Beyond it the upstream is treated as broken and the run
 * fails, rather than publishing a snapshot that is mostly stale.
 */
export const MAX_REFRESH_FAILURE_RATIO = 0.1;

const MAX_REFRESH_FAILURE_ERROR_LENGTH = 300;
const MAX_SYNC_FAILURE_MESSAGE_LENGTH = 500;

/** A catalog entry that could not be refreshed in this run. `entry` is stable across runs. */
export type CatalogEntryFailure = { entry: string; error: string };

type PreviousSnapshot = {
  data: NormalizedOpenRouterResponse;
  openrouter: Record<string, StoredModel> | null;
  vercel: Record<string, StoredModel> | null;
};

function assertFewRefreshFailures(
  description: string,
  failures: CatalogEntryFailure[],
  total: number
) {
  const allowed = Math.max(1, Math.floor(total * MAX_REFRESH_FAILURE_RATIO));
  if (failures.length <= allowed) return;
  throw new Error(
    `${failures.length} of ${total} ${description} failed to refresh; first: ${failures[0]?.entry}: ${failures[0]?.error}`
  );
}

function warnAboutRefreshFailures(failures: CatalogEntryFailure[]) {
  if (failures.length === 0) return;
  console.warn(
    `[sync-providers] using previous data for ${failures.length} entries: ${failures
      .map(failure => `${failure.entry} (${failure.error})`)
      .join('; ')}`
  );
}

export async function fetchGatewayModels(
  gateway: Provider,
  modelsPath: string,
  getPreviousModels: () => Promise<Record<string, StoredModel> | null | undefined>
): Promise<{ models: Record<string, StoredModel>; failures: CatalogEntryFailure[] }> {
  const headers = {
    ...ATTRIBUTION_HEADERS,
    authorization: `Bearer ${gateway.apiKey}`,
  };

  const models = ModelsSchema.parse(
    await fetchSyncJson(`Fetching models from ${gateway.id}`, `${gateway.apiUrl}${modelsPath}`, {
      method: 'GET',
      headers,
    })
  );

  const limit = pLimit(8);
  const result: Record<string, StoredModel> = {};
  const modelsWithoutEndpoints: string[] = [];
  const failedModels: Array<{ id: string; failure: CatalogEntryFailure }> = [];
  await Promise.all(
    models.data.map(model =>
      limit(async () => {
        try {
          const body = await fetchSyncJson(
            `Fetching model endpoints for ${gateway.id}/${model.id}`,
            `${gateway.apiUrl}/models/${model.id}/endpoints`,
            { method: 'GET', headers },
            // Gateways list some models (e.g. Vercel's `*-batch` variants) that have no endpoints resource.
            { allowNotFound: true }
          );
          if (body === null) {
            modelsWithoutEndpoints.push(model.id);
            return;
          }
          const endpoints = EndpointsSchema.parse(body);
          const { reasoning, ...modelMetadata } = model;
          result[model.id] = {
            ...modelMetadata,
            ...(reasoning && {
              reasoning: {
                mandatory: reasoning.mandatory,
                ...(reasoning.supported_efforts && {
                  supported_efforts: reasoning.supported_efforts,
                }),
              },
            }),
            endpoints: endpoints.data.endpoints,
          };
        } catch (error) {
          failedModels.push({
            id: model.id,
            failure: {
              entry: `${gateway.id} endpoints for ${model.id}`,
              error: describeEntryFailure(error),
            },
          });
        }
      })
    )
  );

  if (modelsWithoutEndpoints.length > 0) {
    console.warn(
      `[fetchGatewayModels] skipped ${modelsWithoutEndpoints.length} ${gateway.id} models without endpoints: ${modelsWithoutEndpoints.sort().join(', ')}`
    );
  }

  const failures = failedModels.map(({ failure }) => failure);
  assertFewRefreshFailures(`${gateway.id} model endpoint requests`, failures, models.data.length);
  if (failedModels.length > 0) {
    const previousModels = (await getPreviousModels()) ?? {};
    for (const { id } of failedModels) {
      const previousModel = previousModels[id];
      if (previousModel) result[id] = previousModel;
    }
  }

  const count = Object.keys(result).length;
  if (count < 100) {
    throw new Error(`Suspicious: total number of ${gateway.id} models is ${count} < 100`);
  }
  console.debug(`[fetchGatewayModels] fetched ${count} models from ${gateway.id}`);

  return { models: result, failures };
}

async function fetchProviders(): Promise<OpenRouterProvider[]> {
  console.log('Fetching OpenRouter providers from frontend endpoint...');

  const rawData = await fetchSyncJson(
    'Fetching OpenRouter providers',
    'https://openrouter.ai/api/frontend/v1/all-providers',
    {
      method: 'GET',
      headers: ATTRIBUTION_HEADERS,
    }
  );
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

/**
 * Fetches each provider's model list. A provider whose request fails keeps its models from
 * the previous snapshot. Those already went through the injection and data-policy steps in
 * `syncProviders`, which skip or deduplicate models that are already present and only ever
 * worsen data policies, so running them again is safe.
 */
export async function fetchProviderModels(
  providers: OpenRouterProvider[],
  getPreviousProviders: () => Promise<NormalizedProvider[] | undefined>
): Promise<{
  providerModelData: Array<{ provider: OpenRouterProvider; models: OpenRouterModel[] }>;
  failures: CatalogEntryFailure[];
}> {
  // Limit concurrent requests to 3
  const limit = pLimit(3);
  let processedCount = 0;

  console.log('Fetching models for all providers...');

  const failures: CatalogEntryFailure[] = [];
  const results = await Promise.all(
    providers.map(provider =>
      limit(async () => {
        let models: OpenRouterModel[] | null;
        try {
          models = await fetchModelsForProvider(provider);
        } catch (error) {
          failures.push({
            entry: `models for provider ${provider.name}`,
            error: describeEntryFailure(error),
          });
          models = null;
        }

        processedCount++;
        if (processedCount % 10 === 0) {
          console.log(`Processed ${processedCount}/${providers.length} providers...`);
        }

        return { provider, models };
      })
    )
  );

  assertFewRefreshFailures('provider model requests', failures, providers.length);
  const previousProviders = failures.length > 0 ? ((await getPreviousProviders()) ?? []) : [];
  const providerModelData = results.map(({ provider, models }) => ({
    provider,
    models:
      models ??
      structuredClone(
        previousProviders.find(previous => previous.slug === provider.slug)?.models
      ) ??
      [],
  }));

  return { providerModelData, failures };
}

async function syncProviders(params: {
  providerModelData: Array<{ provider: OpenRouterProvider; models: OpenRouterModel[] }>;
  openRouterModels: Record<string, StoredModel>;
  openRouterCatalogModels: CatalogModel[];
  vercelModels: Record<string, StoredModel>;
}) {
  const { providerModelData, openRouterModels, openRouterCatalogModels, vercelModels } = params;
  const unavailableModelIds = await getUnavailableModelIds();
  const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(
    providerModelData,
    unavailableModelIds
  );

  injectExtraProviderModels(vercelModels, providerModelData);

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
            ...((!kfm.pricing || kfm.flags.includes('requires-data-collection')) &&
              !unavailableModelIds.has(kfm.public_id) && {
                data_policy: { training: true, retainsPrompts: true },
              }),
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
        `Found existing ${extraModel.provider.slug} provider from OpenRouter, adding extra model ${extraModel.model.slug}`
      );
      providerData.models.splice(0, 0, extraModel.model);
    }
  }

  injectSupportedFimModels(providerModelData);

  applyFreeEndpointDataPolicy({
    providerModelData,
    openRouterFreeEndpoints,
    kiloExclusiveModels,
    unavailableModelIds,
  });

  injectVirtualModels({
    providerModelData,
    catalogModels: openRouterCatalogModels,
    storedModels: openRouterModels,
    unavailableModelIds,
  });

  // Filter out providers with no models
  const filteredProviderModelData = providerModelData.filter(data => data.models.length > 0);

  // Create simplified structure with providers containing their models directly
  const normalizedProviders: NormalizedProvider[] = filteredProviderModelData.map(data => {
    // Deduplicate models within each provider by slug
    const uniqueModelsMap = new Map<string, OpenRouterModel>();
    data.models.forEach(model => {
      // A model may show a ZDR route even though the same provider also offers data-retaining routes.
      const normalizedModel = withWorstProviderDataPolicy(model, data.provider.dataPolicy);
      uniqueModelsMap.set(normalizeModelId(model.slug), normalizedModel);
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

/**
 * Carries each entry's first failure time across consecutive failing runs. Entries that
 * refreshed in this run are dropped.
 */
export function mergeRefreshFailures(
  previous: SyncProvidersRefreshFailures,
  failures: CatalogEntryFailure[],
  now: Date
): SyncProvidersRefreshFailures {
  return Object.fromEntries(
    failures.map(({ entry, error }) => [
      entry,
      {
        since: previous[entry]?.since ?? now.toISOString(),
        error: error.slice(0, MAX_REFRESH_FAILURE_ERROR_LENGTH),
      },
    ])
  );
}

/** Every entry has been refreshed at or after the returned time. */
export function getRefreshedThrough(failures: SyncProvidersRefreshFailures, now: Date): string {
  const failingSince = Object.values(failures)
    .map(failure => new Date(failure.since).getTime())
    .filter(Number.isFinite);
  return new Date(Math.min(now.getTime(), ...failingSince)).toISOString();
}

export async function recordSyncCompleted(failures: CatalogEntryFailure[]) {
  return db.transaction(async tx => {
    await tx.insert(ai_gateway_sync_providers_state).values({ id: 1 }).onConflictDoNothing();
    const [row] = await tx
      .select({ refreshFailures: ai_gateway_sync_providers_state.refresh_failures })
      .from(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1))
      .for('update');
    if (!row) throw new Error('Sync-providers state row is missing');

    const now = new Date();
    const refreshFailures = mergeRefreshFailures(row.refreshFailures, failures, now);
    const refreshedThrough = getRefreshedThrough(refreshFailures, now);
    await tx
      .update(ai_gateway_sync_providers_state)
      .set({ last_completed_at: refreshedThrough, refresh_failures: refreshFailures })
      .where(eq(ai_gateway_sync_providers_state.id, 1));
    return { completedAt: now.toISOString(), refreshedThrough };
  });
}

export async function recordSyncFailure(error: unknown) {
  const failedAt = new Date().toISOString();
  const message = (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_SYNC_FAILURE_MESSAGE_LENGTH
  );
  await db
    .insert(ai_gateway_sync_providers_state)
    .values({ id: 1, last_failed_at: failedAt, last_failure_message: message })
    .onConflictDoUpdate({
      target: ai_gateway_sync_providers_state.id,
      set: { last_failed_at: failedAt, last_failure_message: message },
    });
}

export async function syncAndStoreProviders() {
  try {
    return await syncAndStoreProvidersOnce();
  } catch (error) {
    try {
      await recordSyncFailure(error);
    } catch (recordError) {
      console.error('[sync-providers] recording sync failure failed', recordError);
    }
    throw error;
  }
}

async function syncAndStoreProvidersOnce() {
  const startTime = performance.now();

  let previousSnapshot: Promise<PreviousSnapshot | undefined> | undefined;
  const getPreviousSnapshot = () =>
    (previousSnapshot ??= db
      .select({
        data: modelsByProvider.data,
        openrouter: modelsByProvider.openrouter,
        vercel: modelsByProvider.vercel,
      })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1)
      .then(([row]) => row));

  // The default OpenRouter list only has text-output models; System One models output decisions.
  const openrouter = await fetchGatewayModels(
    OPENROUTER,
    '/models?output_modalities=all',
    async () => (await getPreviousSnapshot())?.openrouter
  );
  const vercel = await fetchGatewayModels(
    VERCEL_AI_GATEWAY,
    '/models',
    async () => (await getPreviousSnapshot())?.vercel
  );
  const openrouter_data = openrouter.models;
  const vercel_data = vercel.models;

  const openrouterProviders = await fetchProviders();
  if (openrouterProviders.length < 10) {
    throw new Error(
      `Suspicious: total number of OpenRouter API providers is ${openrouterProviders.length} < 10`
    );
  }

  const providerModels = await fetchProviderModels(
    openrouterProviders,
    async () => (await getPreviousSnapshot())?.data.providers
  );

  const openRouterCatalog = await getRawOpenRouterModels();

  const providers = await syncProviders({
    providerModelData: providerModels.providerModelData,
    openRouterModels: openrouter_data,
    openRouterCatalogModels: openRouterCatalog.data,
    vercelModels: vercel_data,
  });

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

  const direct_byok_model_counts = await syncDirectByokModels();
  console.log('[syncAndStoreProviders] direct-byok model counts:', direct_byok_model_counts);

  const refreshFailures = [...openrouter.failures, ...vercel.failures, ...providerModels.failures];
  warnAboutRefreshFailures(refreshFailures);
  const { completedAt, refreshedThrough } = await recordSyncCompleted(refreshFailures);

  return {
    id: result.id,
    generated_at: result.data.generated_at,
    completed_at: completedAt,
    refreshed_through: refreshedThrough,
    refresh_failure_count: refreshFailures.length,
    total_models: result.data.total_models,
    total_providers: result.data.total_providers,
    direct_byok_model_counts,
    time: performance.now() - startTime,
  };
}
