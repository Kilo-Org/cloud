/**
 * Per-repository model selection.
 *
 * A Code Reviewer config carries a global `model_slug` / `thinking_effort` plus an
 * optional list of per-repository overrides (`repository_model_overrides`). This
 * helper resolves the *effective* model for a single review: an override applies
 * only when its `repo_full_name` exactly matches the review's repository; otherwise
 * the global model is used.
 *
 * Matching is on `repo_full_name` because that is the only repo identifier persisted
 * on the review row across every platform (numeric IDs are not on the row for GitHub
 * or Bitbucket). See `RepositoryModelOverrideSchema`.
 */

import type { CodeReviewAgentConfig, StoredModel } from '@kilocode/db/schema-types';
import { DIRECT_BYOK_PROVIDERS_META } from '@/lib/ai-gateway/providers/direct-byok/direct-byok-meta';
import { getOpenRouterModelsMetadataFromDatabase } from '@/lib/ai-gateway/providers/gateway-models-cache';

export type EffectiveModelSelection = {
  modelSlug: string;
  thinkingEffort: string | null;
  source: 'repository_override' | 'global';
};

/** Catalog entry used to pick a cheap same-vendor small model. */
export type CatalogModelPrice = {
  id: string;
  /** USD per input token; null when the catalog has no usable prompt price. */
  promptPrice: number | null;
};

const DIRECT_BYOK_VENDORS = new Set(Object.keys(DIRECT_BYOK_PROVIDERS_META));

export function modelVendorId(modelId: string): string | undefined {
  const vendor = modelId.split('/')[0]?.trim();
  return vendor || undefined;
}

export function isDirectByokVendor(vendor: string | undefined): boolean {
  return vendor != null && DIRECT_BYOK_VENDORS.has(vendor);
}

/**
 * Build catalog price rows from the OpenRouter `StoredModel` map.
 * Uses the cheapest endpoint prompt price per model.
 */
export function catalogPricesFromStoredModels(
  models: Record<string, StoredModel>
): CatalogModelPrice[] {
  return Object.values(models)
    .filter(model => (model.type ?? 'language') === 'language' && model.endpoints.length > 0)
    .map(model => {
      const prices = model.endpoints
        .map(endpoint =>
          endpoint.pricing?.prompt != null ? Number.parseFloat(endpoint.pricing.prompt) : Number.NaN
        )
        .filter(price => Number.isFinite(price) && price >= 0);
      return {
        id: model.id,
        promptPrice: prices.length > 0 ? Math.min(...prices) : null,
      };
    });
}

/**
 * Pick a cheap same-vendor model for Code Reviewer title/aux calls.
 *
 * - Prefer the lowest-priced same-vendor sibling that is strictly cheaper than the
 *   primary when the primary's price is known.
 * - When the primary has no catalog price, pick the cheapest same-vendor sibling.
 * - Direct-BYOK vendors with no cheaper sibling fall back to the primary (user's
 *   key) so aux calls do not fall through to kilo-auto/small → Gemma on Kilo credits.
 * - Managed vendors with no cheaper sibling leave small_model unset.
 */
export function resolveCheapSameVendorSmallModel(
  primaryModelId: string,
  catalog: readonly CatalogModelPrice[]
): string | undefined {
  const vendor = modelVendorId(primaryModelId);
  if (!vendor) return undefined;

  const primaryPrice = catalog.find(entry => entry.id === primaryModelId)?.promptPrice ?? undefined;

  const siblings = catalog.filter(
    entry =>
      entry.id !== primaryModelId &&
      modelVendorId(entry.id) === vendor &&
      entry.promptPrice != null &&
      Number.isFinite(entry.promptPrice)
  );

  const cheaper =
    primaryPrice != null && Number.isFinite(primaryPrice)
      ? siblings.filter(entry => (entry.promptPrice as number) < primaryPrice)
      : siblings;

  if (cheaper.length === 0) {
    return isDirectByokVendor(vendor) ? primaryModelId : undefined;
  }

  cheaper.sort((a, b) => {
    const priceDelta = (a.promptPrice as number) - (b.promptPrice as number);
    return priceDelta !== 0 ? priceDelta : a.id.localeCompare(b.id);
  });
  return cheaper[0]?.id;
}

/**
 * Resolve the Code Reviewer aux/title small model for a primary review model.
 * Soft-fails to BYOK-primary or unset when the gateway catalog cannot be loaded.
 */
export async function resolveReviewSmallModel(primaryModelId: string): Promise<string | undefined> {
  const vendor = modelVendorId(primaryModelId);
  try {
    const models = await getOpenRouterModelsMetadataFromDatabase();
    return resolveCheapSameVendorSmallModel(primaryModelId, catalogPricesFromStoredModels(models));
  } catch {
    return isDirectByokVendor(vendor) ? primaryModelId : undefined;
  }
}

/**
 * Resolve the effective model for a review's repository.
 *
 * @param config       The Code Reviewer agent config (global model + overrides).
 * @param repoFullName The review row's `repo_full_name` (e.g. "owner/repo"). Null/
 *                     empty falls back to the global model.
 * @param fallbackModel Model to use when the config has no global `model_slug`
 *                     (mirrors the existing `config.model_slug || DEFAULT_...` guard).
 */
export function resolveEffectiveModel(
  config: Pick<
    CodeReviewAgentConfig,
    'model_slug' | 'thinking_effort' | 'repository_model_overrides'
  >,
  repoFullName: string | null | undefined,
  fallbackModel: string
): EffectiveModelSelection {
  const globalSelection: EffectiveModelSelection = {
    modelSlug: config.model_slug || fallbackModel,
    thinkingEffort: config.thinking_effort ?? null,
    source: 'global',
  };

  if (!repoFullName) return globalSelection;

  const override = config.repository_model_overrides?.find(
    entry => entry.repo_full_name === repoFullName
  );

  // An override with a blank model_slug is treated as "no override" so a malformed
  // entry can never blank out the model — fall back to the global selection.
  if (!override || !override.model_slug) return globalSelection;

  return {
    modelSlug: override.model_slug,
    thinkingEffort: override.thinking_effort ?? null,
    source: 'repository_override',
  };
}
