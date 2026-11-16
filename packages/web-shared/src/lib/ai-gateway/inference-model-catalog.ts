import * as z from 'zod';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getEnhancedOpenRouterModels,
  getRawOpenRouterModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { legacyOpenRouterAliases } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-openrouter-model-ids';

const InferenceModelCatalogSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })).min(1),
});

const getInferenceModelIds = createCachedFetch<ReadonlySet<string> | null>(
  async () => {
    // Enhancement adds Auto models even to an empty upstream snapshot. Do not replace a
    // healthy admission snapshot with that partial catalog during a metadata outage.
    InferenceModelCatalogSchema.parse(await getRawOpenRouterModels());
    // Country restrictions are enforced independently when selecting a custom LLM route.
    const catalog = InferenceModelCatalogSchema.parse(
      await getEnhancedOpenRouterModels({ countryCode: null, fromDb: readDb })
    );
    return new Set(catalog.data.map(model => model.id.toLowerCase()));
  },
  60_000,
  null,
  { name: 'inferenceModelCatalog' }
);

/** Public catalog membership, plus the exact legacy aliases supported by inference. */
export async function inferenceModelCatalogAdmission(
  modelId: string
): Promise<'allowed' | 'unlisted' | 'unavailable'> {
  if (legacyOpenRouterAliases.has(modelId)) return 'allowed';
  const modelIds = await getInferenceModelIds();
  if (!modelIds) return 'unavailable';
  return modelIds.has(modelId) ? 'allowed' : 'unlisted';
}
