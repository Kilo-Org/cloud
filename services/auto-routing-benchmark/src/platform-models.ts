import {
  BenchmarkCatalogVariantsSchema,
  getReasoningVariantKeys,
  type BenchmarkConfig,
  type CandidatePricing,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { exactPairKey } from './db';
import type { RunModelEntry } from './run';

const CatalogTokenPriceSchema = z
  .string()
  .trim()
  .min(1)
  .transform(value => Number(value))
  .pipe(z.number().nonnegative())
  .nullable()
  .catch(null);

export const BenchmarkModelCatalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().trim().min(1),
      opencode: z.object({ variants: BenchmarkCatalogVariantsSchema.optional() }).optional(),
      pricing: z
        .object({
          prompt: CatalogTokenPriceSchema.optional(),
          completion: CatalogTokenPriceSchema.optional(),
          input_cache_read: CatalogTokenPriceSchema.optional(),
        })
        .optional(),
    })
  ),
});

/** Expand only current catalog-supported reasoning controls, never saved effort aliases. */
export function platformRegistryEntries(
  config: Pick<BenchmarkConfig, 'deciderModels'>,
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>
): RunModelEntry[] {
  const modelsById = new Map(catalog.data.map(model => [model.id, model]));
  const entries: RunModelEntry[] = [];
  const seen = new Set<string>();
  for (const selected of config.deciderModels) {
    const model = modelsById.get(selected.id);
    if (!model)
      throw new Error(`selected benchmark model is missing from Kilo catalog: ${selected.id}`);
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

export async function fetchPlatformRegistryEntries(
  env: { KILO_WEB_API_BASE_URL: string },
  config: Pick<BenchmarkConfig, 'deciderModels'>,
  fetchImpl: typeof fetch = fetch
): Promise<RunModelEntry[]> {
  return platformRegistryEntries(config, await fetchBenchmarkModelCatalog(env, fetchImpl));
}
