import {
  BenchmarkCatalogVariantsSchema,
  getReasoningVariantKeys,
  type BenchmarkConfig,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { exactPairKey } from './db';
import type { RunModelEntry } from './run';

export const BenchmarkModelCatalogSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().trim().min(1),
      opencode: z.object({ variants: BenchmarkCatalogVariantsSchema.optional() }).optional(),
      pricing: z
        .object({
          prompt: z.string(),
          completion: z.string(),
          request: z.string().optional(),
        })
        .nullable()
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

export function catalogFallbackCaseCosts(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>
): Map<string, number> {
  const costs = new Map<string, number>();
  for (const model of catalog.data) {
    if (!model.pricing) continue;
    const prompt = Number(model.pricing.prompt);
    const completion = Number(model.pricing.completion);
    const request = Number(model.pricing.request ?? '0');
    if (![prompt, completion, request].every(price => Number.isFinite(price) && price >= 0)) {
      continue;
    }
    costs.set(model.id, 100_000 * prompt + 50_000 * completion + 32 * request);
  }
  return costs;
}
