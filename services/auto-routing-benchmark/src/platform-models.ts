import {
  BenchmarkCatalogVariantsSchema,
  getReasoningVariantKeys,
  isBenchmarkEnrollmentBlocked,
  NON_ENROLLABLE_BENCHMARK_MODEL_REASON,
  type BenchmarkConfig,
  type CandidatePricing,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { exactPairKey } from './db';
import { logBlockedBenchmarkEnrollment } from './enrollment-block';
import type { ProfileFailure } from './profile-failure';
import type { RunModelEntry } from './run';

const CatalogTokenPriceSchema = z
  .union([z.string().trim().min(1), z.number()])
  .transform(value => Number(value))
  .pipe(z.number().nonnegative())
  .nullable()
  .catch(null);

export const BenchmarkModelCatalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().trim().min(1),
      alias_target: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      supported_parameters: z.array(z.string()).optional(),
      context_length: z.number().nullable().catch(null).optional(),
      max_completion_tokens: z.number().nullable().catch(null).optional(),
      top_provider: z
        .object({ max_completion_tokens: z.number().nullable().catch(null).optional() })
        .nullable()
        .catch(null)
        .optional(),
      opencode: z
        .object({
          variants: BenchmarkCatalogVariantsSchema.optional(),
          // The CLI's prompt and SDK choices for this model (see probe/family.ts).
          prompt: z.string().nullish(),
          ai_sdk_provider: z.string().nullish(),
        })
        .optional(),
      pricing: z
        .object({
          prompt: CatalogTokenPriceSchema.optional(),
          completion: CatalogTokenPriceSchema.optional(),
          input_cache_read: CatalogTokenPriceSchema.optional(),
        })
        .nullable()
        .catch(null)
        .optional(),
    })
  ),
});

export type CatalogModel = z.infer<typeof BenchmarkModelCatalogSchema>['data'][number];

export function catalogModelSupportsTools(model: CatalogModel): boolean {
  return model.supported_parameters?.includes('tools') ?? true;
}

/**
 * The CLI's output cap and completion fallback, mirrored from the kilo CLI:
 * `OUTPUT_TOKEN_MAX` in `packages/opencode/src/provider/transform.ts` and the
 * `maxOutputTokens` fallback in `packages/kilo-gateway/src/api/models.ts`.
 */
const CLI_OUTPUT_TOKEN_MAX = 32_000;

/**
 * Input tokens every benchmark request needs: the CLI harness prompt (system prompt
 * and tool definitions, about 16.6k tokens) plus a short case.
 */
export const MIN_BENCHMARK_INPUT_TOKENS = 20_000;

export const CATALOG_PAIR_UNAVAILABLE_REASON =
  'Model or variant is unavailable in the executable benchmark catalog.';
export const CATALOG_CONTEXT_TOO_SMALL_REASON = `Model context window leaves fewer than ${MIN_BENCHMARK_INPUT_TOKENS} input tokens after the CLI completion reservation.`;
export const CATALOG_NO_TOOL_SUPPORT_REASON =
  'Model does not support tool calls, which the benchmark CLI requires.';

/**
 * Input room after the completion budget the CLI reserves on every request, derived
 * the way the CLI derives it from the gateway catalog. Null when the window is unknown.
 */
export function catalogModelInputRoom(model: CatalogModel): number | null {
  if (model.context_length == null) return null;
  const output =
    model.top_provider?.max_completion_tokens ||
    model.max_completion_tokens ||
    Math.ceil(model.context_length * 0.2);
  return model.context_length - Math.min(output, CLI_OUTPUT_TOKEN_MAX);
}

export function catalogSupportsBenchmarkPair(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  pair: { model: string; variant: string | null }
): boolean {
  if (isBenchmarkEnrollmentBlocked(pair.model)) return false;
  const model = catalog.data.find(model => model.id === pair.model);
  if (!model || model.id.startsWith('~') || !catalogModelSupportsTools(model)) return false;
  const variants = getReasoningVariantKeys(model.opencode?.variants);
  return variants.length > 0 ? variants.includes(pair.variant ?? '') : pair.variant === null;
}

/**
 * Why the drain cannot benchmark this exact pair, or null when it can. Registration
 * admits a pair whose window is too small, so its profile fails here with that reason.
 */
export function benchmarkPairUnavailability(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  pair: { model: string; variant: string | null }
): ProfileFailure | null {
  if (isBenchmarkEnrollmentBlocked(pair.model)) {
    return { failureClass: 'unsupported', reason: NON_ENROLLABLE_BENCHMARK_MODEL_REASON };
  }
  const model = catalog.data.find(model => model.id === pair.model);
  if (!model || model.id.startsWith('~')) {
    return { failureClass: 'catalog_absent', reason: CATALOG_PAIR_UNAVAILABLE_REASON };
  }
  if (!catalogModelSupportsTools(model)) {
    return { failureClass: 'catalog_absent', reason: CATALOG_NO_TOOL_SUPPORT_REASON };
  }
  if (!catalogSupportsBenchmarkPair(catalog, pair)) {
    const requested = (pair.variant ?? 'default').slice(0, 60);
    return {
      failureClass: 'catalog_absent',
      reason: `Variant ${requested} is not offered for this model in the executable benchmark catalog.`,
    };
  }
  const room = catalogModelInputRoom(model);
  return room !== null && room < MIN_BENCHMARK_INPUT_TOKENS
    ? { failureClass: 'context_too_small', reason: CATALOG_CONTEXT_TOO_SMALL_REASON }
    : null;
}

function resolveCatalogModel(
  modelId: string,
  modelsById: ReadonlyMap<string, CatalogModel>
): CatalogModel | undefined {
  const model = modelsById.get(modelId);
  return model?.id.startsWith('~') && model.alias_target
    ? (modelsById.get(model.alias_target) ?? model)
    : model;
}

/** Expand only current catalog-supported reasoning controls, never saved effort aliases. */
export function platformRegistryEntries(
  config: Pick<BenchmarkConfig, 'deciderModels'>,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>
): RunModelEntry[] {
  const modelsById = new Map(catalog.data.map(model => [model.id, model]));
  const entries: RunModelEntry[] = [];
  const seen = new Set<string>();
  for (const selected of config.deciderModels) {
    const selectedModel = modelsById.get(selected.id);
    const model = selectedModel?.id.startsWith('~')
      ? modelsById.get(selectedModel.alias_target ?? '')
      : selectedModel;
    if (!model || model.id.startsWith('~') || !catalogModelSupportsTools(model)) continue;
    // An explicit selection of a blocked model, or an alias retargeted onto one, enters
    // no run. It is logged once here, where the platform registry expands the pool.
    if (isBenchmarkEnrollmentBlocked(model.id)) {
      logBlockedBenchmarkEnrollment({ model: model.id, variant: null }, 'platform_registry');
      continue;
    }
    const variants = getReasoningVariantKeys(model.opencode?.variants);
    for (const variant of variants.length > 0 ? variants : [null]) {
      const key = exactPairKey(model.id, variant);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ model: model.id, variant });
    }
  }
  return entries;
}

/** The concrete catalog model behind `modelId` and its reasoning variants, or null when absent. */
export function catalogModelVariants(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  modelId: string
): { model: string; variants: (string | null)[] } | null {
  const model = resolveCatalogModel(modelId, new Map(catalog.data.map(m => [m.id, m])));
  if (!model || isBenchmarkEnrollmentBlocked(model.id)) return null;
  const variants = getReasoningVariantKeys(model.opencode?.variants);
  return { model: model.id, variants: variants.length > 0 ? variants : [null] };
}

export function catalogCandidatePrices(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>
): ReadonlyMap<string, CandidatePricing | null> {
  return new Map(
    catalog.data.map(model => {
      const pricing = model.pricing;
      return [
        model.id,
        pricing?.prompt != null && pricing.completion != null
          ? {
              promptUsdPerToken: pricing.prompt,
              completionUsdPerToken: pricing.completion,
              cacheReadUsdPerToken: pricing.input_cache_read ?? null,
            }
          : null,
      ];
    })
  );
}

/**
 * What a reply's tokens cost at the catalog's prices, for a reply that arrives without the
 * gateway's billed cost. Cached input is a subset of the reported input; usage the catalog
 * cannot price returns null instead of a made-up zero.
 */
export function catalogUsageCostUsd(
  model: CatalogModel,
  usage: {
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
  }
): number | null {
  const pricing = model.pricing;
  if (pricing?.prompt == null || pricing.completion == null) return null;
  if (usage.inputTokens == null && usage.outputTokens == null) return null;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  return (
    (input - cached) * pricing.prompt +
    cached * (pricing.input_cache_read ?? pricing.prompt) +
    (usage.outputTokens ?? 0) * pricing.completion
  );
}

export async function fetchBenchmarkModelCatalog(
  env: { KILO_WEB_API_BASE_URL: string },
  fetchImpl: typeof fetch = fetch
): Promise<z.infer<typeof BenchmarkModelCatalogSchema>> {
  const response = await fetchImpl(new URL('/api/openrouter/models', env.KILO_WEB_API_BASE_URL), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`benchmark model catalog failed: HTTP ${response.status}`);
  return BenchmarkModelCatalogSchema.parse(await response.json());
}
