import { type StoredModel } from '@kilocode/db';
import type { CustomPricingConfig, PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { pickerExtraModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getPreferredProviderOrderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config';
import { getRawModelCatalog } from '@kilocode/web-shared/lib/ai-gateway/providers/raw-model-catalog';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  combineRates,
  pickerRequestPrice,
  requestTextBytes,
  type TextPricingRates,
} from './request-cost-limit';

/**
 * Room the request body leaves out: the gateway and the provider add chat
 * scaffolding and tool schemas, and no byte of the serialized request counts for
 * less than one token.
 */
const INPUT_TOKEN_ALLOWANCE = 2048;

type PricingSources = {
  models: Record<string, StoredModel>;
  catalog: OpenRouterModel[];
  preferredProviderOrderConfig: PreferredProviderOrderConfig;
  customPricingConfig: CustomPricingConfig;
};

/** Every price source is read through `readDb` and cached in process, so this adds no round trip. */
async function loadPricingSources(): Promise<PricingSources> {
  const [models, catalog, preferredProviderOrderConfig, customPricingConfig] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getRawModelCatalog(),
    getPreferredProviderOrderConfig(),
    getCustomPricingConfig(),
  ]);
  return { models, catalog, preferredProviderOrderConfig, customPricingConfig };
}

/** The worst rates a request may be billed at, including an alias target's own price. */
function worstRatesForModel(
  model: string,
  sources: PricingSources,
  inputTokenCeiling: number
): TextPricingRates {
  const requested = pickerRequestPrice(
    model,
    sources.models,
    sources.catalog,
    sources.preferredProviderOrderConfig,
    sources.customPricingConfig,
    inputTokenCeiling
  );
  const aliasTarget = model.startsWith('~') ? sources.models[model]?.alias_target?.slug : undefined;
  if (!aliasTarget) return requested;
  const target = pickerRequestPrice(
    aliasTarget,
    sources.models,
    sources.catalog,
    sources.preferredProviderOrderConfig,
    sources.customPricingConfig,
    inputTokenCeiling
  );
  return combineRates(requested, target);
}

/**
 * The largest output the model can produce, from the catalog entry that prices
 * the request. Null when the catalog states no ceiling, which leaves the request
 * unbounded.
 */
function catalogOutputTokenCeiling(model: string, sources: PricingSources): number | null {
  const extra = pickerExtraModel(model);
  const entry = extra ?? sources.catalog.find(candidate => candidate.id === model);
  const ceiling = entry?.top_provider?.max_completion_tokens;
  return typeof ceiling === 'number' && ceiling > 0 ? ceiling : null;
}

function microdollars(rates: TextPricingRates, inputTokens: number, outputTokens: number): number {
  const usd = inputTokens * rates.inputRate + outputTokens * rates.outputRate + rates.requestCost;
  return Math.max(0, Math.ceil(usd * 1_000_000));
}

export type TextSpendBoundInput = {
  /** The model the request is billed as, after alias and Auto resolution. */
  model: string;
  /** The parsed request body, read only for its size. */
  body: unknown;
  /** The output ceiling the request itself states, when it states one. */
  explicitOutputTokens: number | null;
  /** Requested choices, each of which carries its own output ceiling. */
  choices?: number | null;
};

/**
 * The most a text request can cost, in microdollars, at the prices the catalog
 * bills it at: the request's own tokens plus every output token it may generate.
 *
 * Null when the request cannot be bounded, which is the case when neither the
 * request nor the catalog states an output ceiling, or when no price source can
 * price the model. A caller must not hold spend it cannot bound.
 */
export async function textRequestSpendBound(input: TextSpendBoundInput): Promise<number | null> {
  try {
    const sources = await loadPricingSources();
    const inputTokenCeiling = requestTextBytes(input.body) + INPUT_TOKEN_ALLOWANCE;
    const rates = worstRatesForModel(input.model, sources, inputTokenCeiling);
    const requestedChoices = input.choices ?? 1;
    const choices =
      Number.isFinite(requestedChoices) && requestedChoices >= 1 ? Math.floor(requestedChoices) : 1;
    const outputCeiling =
      input.explicitOutputTokens && input.explicitOutputTokens > 0
        ? input.explicitOutputTokens
        : catalogOutputTokenCeiling(input.model, sources);
    if (outputCeiling === null) return null;
    return microdollars(rates, inputTokenCeiling, outputCeiling * choices);
  } catch {
    // An unpriceable model is an unbounded request, not a failed request.
    return null;
  }
}

/**
 * The most an embedding request can cost. Embeddings bill input tokens only, so
 * the request's serialized size times the model's input rate is the bound.
 * Null when the catalog cannot price the model.
 */
export async function embeddingRequestSpendBound(input: {
  model: string;
  body: unknown;
}): Promise<number | null> {
  try {
    const sources = await loadPricingSources();
    const inputTokenCeiling = requestTextBytes(input.body) + INPUT_TOKEN_ALLOWANCE;
    const rates = worstRatesForModel(input.model, sources, inputTokenCeiling);
    return microdollars(rates, inputTokenCeiling, 0);
  } catch {
    return null;
  }
}
