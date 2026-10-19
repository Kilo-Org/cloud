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
      inference_provider_ids: z.array(z.string()).optional(),
      supported_parameters: z.array(z.string()).optional(),
      opencode: z.object({ variants: BenchmarkCatalogVariantsSchema.optional() }).optional(),
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

type CatalogModel = z.infer<typeof BenchmarkModelCatalogSchema>['data'][number];

export function catalogModelSupportsTools(model: CatalogModel): boolean {
  return model.supported_parameters?.includes('tools') ?? true;
}

export function catalogSupportsBenchmarkPair(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  pair: { model: string; variant: string | null }
): boolean {
  const model = catalog.data.find(model => model.id === pair.model);
  if (!model || model.id.startsWith('~') || !catalogModelSupportsTools(model)) return false;
  const variants = getReasoningVariantKeys(model.opencode?.variants);
  return variants.length > 0 ? variants.includes(pair.variant ?? '') : pair.variant === null;
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

export function catalogModelProviders(
  catalog: z.infer<typeof BenchmarkModelCatalogSchema>,
  modelId: string
): string[] {
  const modelsById = new Map(catalog.data.map(model => [model.id, model]));
  return [...new Set(resolveCatalogModel(modelId, modelsById)?.inference_provider_ids ?? [])];
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
  if (!model) return null;
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
