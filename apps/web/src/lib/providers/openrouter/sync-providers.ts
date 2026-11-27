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
  type GatewayModelsSource,
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
import {
  modelsByProvider,
  ai_gateway_config,
  organization_new_models_baselines,
} from '@kilocode/db/schema';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { and, desc, eq, lt, notInArray } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  applyNewModelsPolicyForPublication,
  logAutoModelChangesForAllOrgs,
} from '@/lib/organizations/auto-model-change-log';
import { lockSnapshotPublication } from '@/lib/providers/openrouter/snapshot-lock';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  LatestAliasTargetsConfigSchema,
  VercelModelIdOverridesConfigSchema,
  type LatestAliasTarget,
  type VercelModelIdOverride,
} from '@kilocode/db/schema-types';
import {
  applyLatestAliasTargets,
  getLatestAliasTargets,
  readLatestAliasTargets,
  updateLatestAliasTargets,
  type LatestAliasTargets,
} from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
import {
  aliasTargetsIdentity,
  promoteAliasTargets,
  type AliasPromotionResult,
} from '@/lib/providers/openrouter/sync-alias-pins';
import { lockAliasPromotionWrite } from '@/lib/auto-routing-custom-routers';
import { recordSyncCompleted } from '@/lib/providers/openrouter/sync-providers-stale-alert';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import {
  applyFreeEndpointDataPolicy,
  getOpenRouterFreeEndpoints,
} from '@/lib/providers/openrouter/free-endpoint-data-policy';
import { injectVercelModels } from '@/lib/providers/openrouter/inject-vercel-models';
import { withWorstProviderDataPolicy } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/model-data-policy';
import { getModelDisplayPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import {
  getVercelModelIdOverrides,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { buildVercelModelIdOverrides } from '@/lib/providers/openrouter/vercel-model-id-overrides';
import { loadModelsDevCatalog } from '@/lib/providers/direct-byok/models-dev';
import { injectSupportedFimModels } from '@kilocode/web-shared/lib/ai-gateway/supported-fim-models';
import { injectVirtualModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import type { OpenRouterCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import {
  fetchCustomLlmsFromDatabase,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { buildPublicCustomLlmSnapshotModels } from '@/lib/providers/openrouter/public-custom-llm-snapshot';
import { injectDirectByokProviders } from '@/lib/providers/openrouter/inject-direct-byok-providers';

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
  source: GatewayModelsSource
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

/**
 * Stores the price Kilo shows for the listing, its undiscounted peak price, so consumers of the
 * snapshot never see a discounted or off-peak price.
 */
export function withDisplayPricing(model: OpenRouterModel): OpenRouterModel {
  if (!model.endpoint) return model;
  const pricing = getModelDisplayPricing(model.endpoint.pricing) ?? model.endpoint.pricing;
  return {
    ...model,
    endpoint: {
      ...model.endpoint,
      pricing: { prompt: pricing.prompt, completion: pricing.completion },
    },
  };
}

/** One provider with the models its own listing returned, before any snapshot-only injection. */
type ProviderModelData = Array<{ provider: OpenRouterProvider; models: OpenRouterModel[] }>;

/**
 * Fetches every provider's own model listing. This is the only network fan-out the sync performs,
 * and it depends on nothing about the alias targets, so a cycle that has to render the snapshot
 * twice fetches each provider once.
 */
export async function fetchProviderModelData(
  providers: readonly OpenRouterProvider[]
): Promise<ProviderModelData> {
  if (providers.length === 0) {
    throw new Error('No providers found in OpenRouter response');
  }

  // Limit concurrent requests to 3
  const limit = pLimit(3);
  let processedCount = 0;

  console.log('Fetching models for all providers...');

  return Promise.all(
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
}

/**
 * The snapshot the given alias targets produce. The injection helpers below rewrite the fan-out in
 * place, so every call works on its own copy: a refused promotion re-renders the snapshot from the
 * targets another run stored.
 */
export async function renderProviders(params: {
  providerModelData: ProviderModelData;
  openRouterModels: GatewayModelMap;
  openRouterCatalogModels: OpenRouterCatalogModel[];
  vercelModels: GatewayModelMap;
  vercelModelIdOverrides: VercelModelIdOverrides;
  customLlms: CustomLlm[];
}): Promise<NormalizedOpenRouterResponse> {
  const {
    openRouterModels,
    openRouterCatalogModels,
    vercelModels,
    vercelModelIdOverrides,
    customLlms,
  } = params;
  const providerModelData = structuredClone(params.providerModelData);
  const unavailableModelIds = await getUnavailableModelIds();
  const openRouterFreeEndpoints = getOpenRouterFreeEndpoints(
    providerModelData,
    unavailableModelIds
  );

  injectVercelModels({
    vercelModels,
    openRouterCatalogModels,
    openRouterModelIds: [
      ...Object.keys(openRouterModels),
      ...openRouterCatalogModels.map(model => model.id),
    ],
    providerModelData,
    vercelModelIdOverrides,
    updatedAt: new Date().toISOString(),
  });

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
      const normalizedModel = withDisplayPricing(
        withWorstProviderDataPolicy(model, data.provider.dataPolicy)
      );
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
  const sortedProviders = (await injectDirectByokProviders(allProviders, openRouterModels)).sort(
    (a, b) => a.name.localeCompare(b.name)
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

/** Read from the primary, since the stored targets carry pending switches across runs. */
async function generateLatestAliasTargets(
  openRouterModels: GatewayModelMap,
  openRouterCatalogModels: readonly OpenRouterCatalogModel[]
): Promise<{ previous: LatestAliasTargets; next: LatestAliasTarget[] } | null> {
  try {
    const previous = await readLatestAliasTargets(db);
    const next = updateLatestAliasTargets({
      previous,
      models: openRouterModels,
      createdAtMs: new Map(
        openRouterCatalogModels
          .filter(model => model.created > 0)
          .map(model => [model.id, model.created * 1000])
      ),
      nowMs: Date.now(),
    });
    return { previous, next };
  } catch (err) {
    console.error('[sync-providers] generating latest alias targets failed', err);
    captureException(err, { tags: { component: 'sync-providers-latest-alias-targets' } });
    return null;
  }
}

/**
 * Refuses a snapshot too small to be a real catalog. Every render is checked, so the snapshot the
 * sync stores is one the same guard accepted, including the snapshot a refused promotion renders.
 */
function assertPlausibleSnapshot(snapshot: NormalizedOpenRouterResponse) {
  if (snapshot.total_providers < 10) {
    throw new Error(`Suspicious: total number of providers is ${snapshot.total_providers} < 10`);
  }
  if (snapshot.total_models < 100) {
    throw new Error(`Suspicious: total number of models is ${snapshot.total_models} < 100`);
  }
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
 * (`lockSnapshotPublication`) is taken before the previous-snapshot read so
 * two overlapping sync runs cannot both observe the same "previous" row
 * and emit duplicate system audit logs for the same diff. The lock is
 * released automatically on commit/rollback.
 *
 * Organizations with the `disable_new_models` policy are reconciled in the same transaction, so
 * the snapshot that makes a model usable commits together with their deny lists. Snapshots their
 * baselines still point at, and the previous snapshot, are kept; see
 * `applyNewModelsPolicyForPublication`. The other
 * organizations' audit rows are written after the commit, on a best-effort basis.
 *
 * `aliasTargets` are the targets the snapshot was rendered from. A later promotion can commit
 * between that render and this write, so when given, the stored targets are compared under the
 * same lock and a mismatch stores nothing: the snapshot must never name an alias target the
 * database has replaced. The next sync cycle renders the newer targets.
 */
export async function applySnapshotChangesAndAudit(params: {
  providers: NormalizedOpenRouterResponse;
  aliasTargets?: readonly LatestAliasTarget[];
}): Promise<{
  id: number;
  data: NormalizedOpenRouterResponse;
  previousSnapshot: NormalizedOpenRouterResponse | null;
}> {
  const { providers, aliasTargets } = params;

  const { row, previousSnapshot, handledOrganizationIds } = await db.transaction(async tx => {
    await lockSnapshotPublication(tx);

    if (aliasTargets) {
      // A promotion takes the same key exclusively, so no promotion can commit between this
      // comparison and the insert. The snapshot can therefore never name a target the database has
      // already replaced.
      await lockAliasPromotionWrite(tx);
      const [configRow] = await tx
        .select({ config: ai_gateway_config.latest_alias_targets })
        .from(ai_gateway_config)
        .where(eq(ai_gateway_config.id, 1))
        .limit(1);
      const stored = configRow?.config
        ? LatestAliasTargetsConfigSchema.parse(configRow.config)
        : null;
      if (aliasTargetsIdentity(stored?.aliases ?? []) !== aliasTargetsIdentity(aliasTargets)) {
        throw new Error('stored alias targets moved while the snapshot was rendered');
      }
    }

    const [previousSnapshotRow] = await tx
      .select({ id: modelsByProvider.id, data: modelsByProvider.data })
      .from(modelsByProvider)
      .orderBy(desc(modelsByProvider.id))
      .limit(1);
    const previousSnapshot = previousSnapshotRow?.data ?? null;

    const results = await tx
      .insert(modelsByProvider)
      .values({ data: providers })
      .returning({ id: modelsByProvider.id, data: modelsByProvider.data });
    const { handledOrganizationIds } = await applyNewModelsPolicyForPublication(tx, {
      previousSnapshot,
      previousSnapshotId: previousSnapshotRow?.id ?? null,
      newSnapshot: providers,
      newSnapshotId: results[0].id,
    });
    // The previous snapshot is kept for one more cycle: a request that read an organization's
    // baseline just before this commit may still look it up.
    await tx
      .delete(modelsByProvider)
      .where(
        and(
          lt(modelsByProvider.id, previousSnapshotRow?.id ?? results[0].id),
          notInArray(
            modelsByProvider.id,
            tx
              .select({ id: organization_new_models_baselines.snapshot_id })
              .from(organization_new_models_baselines)
          )
        )
      );
    return { row: results[0], previousSnapshot, handledOrganizationIds };
  });

  try {
    await logAutoModelChangesForAllOrgs(previousSnapshot, providers, handledOrganizationIds);
  } catch (err) {
    console.error('[sync-providers] auto-change audit logging failed', err);
    captureException(err, { tags: { component: 'sync-providers-auto-audit' } });
  }

  return { id: row.id, data: row.data, previousSnapshot };
}

/**
 * The snapshot a cycle stores after its promotion attempt. A committed promotion keeps the
 * prospective snapshot it already validated. A refused one re-renders from the targets the
 * promotion observed under the exclusive lock, or, when it never took that lock, from the ones the
 * primary now holds: a target can only move under that lock or the fence this cycle failed to take,
 * so the snapshot never publishes a move no pool witnessed. `render` is the caller's fan-out-free
 * renderer, and its result passes the same plausibility check as the prospective snapshot.
 */
export async function resolveSnapshot(params: {
  prospective: NormalizedOpenRouterResponse;
  promotion: AliasPromotionResult;
  render: (targets: LatestAliasTargets) => Promise<NormalizedOpenRouterResponse>;
}): Promise<{ providers: NormalizedOpenRouterResponse; aliasTargets: LatestAliasTarget[] }> {
  if (params.promotion.written) {
    return { providers: params.prospective, aliasTargets: [...(params.promotion.targets ?? [])] };
  }
  console.warn(
    '[sync-providers] alias targets were not promoted; this cycle keeps the stored targets'
  );
  const targets = params.promotion.targets ?? [...(await readLatestAliasTargets(db)).values()];
  const rendered = await params.render(new Map(targets.map(entry => [entry.alias, entry])));
  assertPlausibleSnapshot(rendered);
  return { providers: rendered, aliasTargets: [...targets] };
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

  const generatedLatestAliasTargets = await generateLatestAliasTargets(
    openRouterModels,
    openRouterCatalog.data
  );

  const customLlms = await fetchCustomLlmsFromDatabase();

  // One network fan-out per cycle. A refused promotion re-renders its snapshot from the targets
  // another run stored, and that must not repeat hundreds of provider fetches.
  const providerModelData = await fetchProviderModelData(openrouterProviders);
  const buildProviders = (targets: LatestAliasTargets) =>
    renderProviders({
      providerModelData,
      openRouterModels: applyLatestAliasTargets(openRouterModels, targets),
      openRouterCatalogModels: openRouterCatalog.data,
      vercelModels,
      vercelModelIdOverrides,
      customLlms,
    });

  // The prospective snapshot, validated before anything is written, so a suspicious sync leaves the
  // stored alias targets and pins untouched.
  const prospectiveTargets: LatestAliasTargets = generatedLatestAliasTargets
    ? new Map(generatedLatestAliasTargets.next.map(entry => [entry.alias, entry]))
    : await getLatestAliasTargets();
  let providers = await buildProviders(prospectiveTargets);
  assertPlausibleSnapshot(providers);
  let snapshotTargets: readonly LatestAliasTarget[] | null = null;

  if (generatedLatestAliasTargets) {
    const promotion = await promoteAliasTargets(generatedLatestAliasTargets);
    const resolved = await resolveSnapshot({
      prospective: providers,
      promotion,
      render: buildProviders,
    });
    providers = resolved.providers;
    snapshotTargets = resolved.aliasTargets;
  }

  if (generatedVercelModelIdOverrides) {
    await storeVercelModelIdOverrides(generatedVercelModelIdOverrides);
  }
  const result = await applySnapshotChangesAndAudit(
    snapshotTargets ? { providers, aliasTargets: snapshotTargets } : { providers }
  );

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
