import pLimit from 'p-limit';
import {
  normalizeModelId,
  openRouterModelsMetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import {
  assertMinimumCount,
  getMetadata,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import {
  formatModelIds,
  gatewayModelEndpointsSource,
  joinGatewayModelEndpoints,
  openRouterGatewayModelsSource,
  readStoredGatewayModels,
  vercelGatewayModelsSource,
  type GatewayModelList,
  type GatewayModelMap,
  type ListedGatewayModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { OpenRouterProvidersResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import { fetchModelsForProvider } from '@/lib/providers/openrouter/fetch-provider-models';
import { modelsByProvider, ai_gateway_config } from '@kilocode/db/schema';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { desc, lt, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import { logAutoModelChangesForAllOrgs } from '@/lib/organizations/auto-model-change-log';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  VercelModelIdOverridesConfigSchema,
  type VercelModelIdOverride,
} from '@kilocode/db/schema-types';
import { recordSyncCompleted } from '@/lib/providers/openrouter/sync-providers-stale-alert';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import {
  applyFreeEndpointDataPolicy,
  getOpenRouterFreeEndpoints,
} from '@/lib/providers/openrouter/free-endpoint-data-policy';
import {
  injectExtraProviderModels,
  injectVercelOnlyProviders,
} from '@/lib/providers/openrouter/inject-extra-provider-models';
import { withWorstProviderDataPolicy } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/model-data-policy';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import {
  getVercelModelIdOverrides,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { buildVercelModelIdOverrides } from '@/lib/providers/openrouter/vercel-model-id-overrides';
import { loadModelsDevCatalog } from '@/lib/providers/direct-byok/models-dev';
import { injectSupportedFimModels } from '@kilocode/web-shared/lib/ai-gateway/supported-fim-models';
import { injectVirtualModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import type { OpenRouterModel as CatalogModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  fetchCustomLlmsFromDatabase,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { buildPublicCustomLlmSnapshotModels } from '@/lib/providers/openrouter/public-custom-llm-snapshot';
import { injectDirectByokProviders } from '@/lib/providers/openrouter/inject-direct-byok-providers';

/**
 * Advisory lock key hashed from a stable identifier. Serializes concurrent
 * calls to `applySnapshotChangesAndAudit` so two overlapping syncs cannot
 * both read the same "previous" snapshot and emit duplicate system audit
 * logs for the same diff. Auto-releases on transaction commit/rollback.
 */
const SYNC_PROVIDERS_SNAPSHOT_LOCK_KEY = 'sync-providers:snapshot';

export const openRouterProvidersSource: MetadataSource<OpenRouterProvider[]> = {
  url: 'https://openrouter.ai/api/frontend/v1/all-providers',
  headers: () => ATTRIBUTION_HEADERS,
  parse: raw => {
    const parsed = OpenRouterProvidersResponse.parse(raw);
    const providers = Array.isArray(parsed) ? parsed : parsed.data;
    assertMinimumCount(openRouterProvidersSource.url, providers.length, 10);
    return providers;
  },
};

/**
 * Reads the stored list and every stored endpoints row in one query. A missing or unusable list or
 * endpoints row falls back to `getMetadata`, which fetches it upstream, so an upstream outage does
 * not fail the sync while the rows are stored.
 */
export async function fetchGatewayModels(
  gateway: Provider,
  source: MetadataSource<GatewayModelList>
): Promise<GatewayModelMap> {
  const stored = await readStoredGatewayModels(gateway, source, readDb).catch((error: unknown) => {
    console.warn(`[fetchGatewayModels] stored ${gateway.type} models are unusable`, error);
    return null;
  });
  const listedModels: ListedGatewayModel[] =
    stored ??
    (await getMetadata(source, readDb)).data.map(model => ({ model, endpoints: undefined }));

  const limit = pLimit(8);
  const withEndpoints = await Promise.all(
    listedModels.map(listed =>
      listed.endpoints !== undefined
        ? listed
        : limit(async () => ({
            model: listed.model,
            // Clearing here, before this task settles, stops the limiter from starting a queued model.
            endpoints: await getMetadata(
              gatewayModelEndpointsSource(gateway, listed.model.id),
              readDb
            ).catch((error: unknown) => {
              limit.clearQueue();
              throw error;
            }),
          }))
    )
  );

  const joined = joinGatewayModelEndpoints(gateway, withEndpoints);
  if (joined.withoutEndpointsResource.length > 0) {
    console.warn(
      `[fetchGatewayModels] skipped ${joined.withoutEndpointsResource.length} ${gateway.type} models without endpoints: ${formatModelIds(joined.withoutEndpointsResource)}`
    );
  }
  console.debug(
    `[fetchGatewayModels] fetched ${Object.keys(joined.models).length} models from ${gateway.type}`
  );

  return joined.models;
}

async function syncProviders(params: {
  providers: OpenRouterProvider[];
  openRouterModels: GatewayModelMap;
  openRouterCatalogModels: CatalogModel[];
  vercelModels: GatewayModelMap;
  vercelModelIdOverrides: VercelModelIdOverrides;
  customLlms: CustomLlm[];
}) {
  const {
    providers,
    openRouterModels,
    openRouterCatalogModels,
    vercelModels,
    vercelModelIdOverrides,
    customLlms,
  } = params;
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
  const unavailableModelIds = await getUnavailableModelIds();
  const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(
    providerModelData,
    unavailableModelIds
  );

  injectExtraProviderModels(vercelModels, providerModelData, vercelModelIdOverrides);
  injectVercelOnlyProviders(vercelModels, providerModelData, vercelModelIdOverrides);

  const mappedExtraModels = buildPublicCustomLlmSnapshotModels(
    customLlms,
    unavailableModelIds,
    new Date().toISOString()
  );

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
        termsOfServiceURL: data.provider.dataPolicy.termsOfServiceURL,
        privacyPolicyURL: data.provider.dataPolicy.privacyPolicyURL,
      },
      headquarters: data.provider.headquarters,
      datacenters: data.provider.datacenters,
      icon: data.provider.icon,
      models: uniqueModels, // Use deduplicated and sorted models
    };
  });

  const allProviders = [...normalizedProviders];

  // Synthesize providers referenced by extra models that aren't already present
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
  const sortedProviders = (await injectDirectByokProviders(allProviders)).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

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

async function generateVercelModelIdOverrides(
  openrouterModels: GatewayModelMap,
  vercelModels: GatewayModelMap
): Promise<VercelModelIdOverride[] | null> {
  try {
    return buildVercelModelIdOverrides({
      modelsDevCatalog: await loadModelsDevCatalog(),
      openrouterModelIds: new Set(Object.keys(openrouterModels)),
      vercelModelIds: new Set(Object.keys(vercelModels)),
    });
  } catch (err) {
    console.error('[sync-providers] generating Vercel model ID overrides failed', err);
    captureException(err, { tags: { component: 'sync-providers-vercel-model-id-overrides' } });
    return null;
  }
}

async function storeVercelModelIdOverrides(overrides: VercelModelIdOverride[]) {
  const value =
    overrides.length === 0 ? null : VercelModelIdOverridesConfigSchema.parse({ overrides });
  await db
    .insert(ai_gateway_config)
    .values({ id: 1, vercel_model_id_overrides: value })
    .onConflictDoUpdate({
      target: ai_gateway_config.id,
      set: { vercel_model_id_overrides: value },
    });
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
}): Promise<{
  id: number;
  data: NormalizedOpenRouterResponse;
  previousSnapshot: NormalizedOpenRouterResponse | null;
}> {
  const { providers } = params;

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
      .values({ data: providers })
      .returning({ id: modelsByProvider.id, data: modelsByProvider.data });
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

  const openRouterModels = await fetchGatewayModels(OPENROUTER, openRouterGatewayModelsSource);
  const vercelModels = await fetchGatewayModels(VERCEL_AI_GATEWAY, vercelGatewayModelsSource);

  const openrouterProviders = await getMetadata(openRouterProvidersSource, readDb);

  const openRouterCatalog = await getMetadata(openRouterModelsMetadataSource, readDb);

  const generatedVercelModelIdOverrides = await generateVercelModelIdOverrides(
    openRouterModels,
    vercelModels
  );
  const vercelModelIdOverrides: VercelModelIdOverrides = generatedVercelModelIdOverrides
    ? new Map(
        generatedVercelModelIdOverrides.map(override => [
          override.openrouter_model_id,
          override.vercel_model_id,
        ])
      )
    : await getVercelModelIdOverrides();

  const providers = await syncProviders({
    providers: openrouterProviders,
    openRouterModels,
    openRouterCatalogModels: openRouterCatalog.data,
    vercelModels,
    vercelModelIdOverrides,
    customLlms: await fetchCustomLlmsFromDatabase(),
  });

  if (providers.total_providers < 10) {
    throw new Error(`Suspicious: total number of providers is ${providers.total_providers} < 10`);
  }

  if (providers.total_models < 100) {
    throw new Error(`Suspicious: total number of models is ${providers.total_models} < 100`);
  }

  if (generatedVercelModelIdOverrides) {
    await storeVercelModelIdOverrides(generatedVercelModelIdOverrides);
  }

  const result = await applySnapshotChangesAndAudit({ providers });

  const completed_at = await recordSyncCompleted('providers');

  return {
    id: result.id,
    generated_at: result.data.generated_at,
    completed_at,
    total_models: result.data.total_models,
    total_providers: result.data.total_providers,
    time: performance.now() - startTime,
  };
}
