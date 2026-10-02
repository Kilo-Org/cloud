import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getPreferredModels } from '@/lib/ai-gateway/preferred-models';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';

export const modelsRouter = createTRPCRouter({
  preferred: baseProcedure.query(() => getPreferredModels()),

  list: baseProcedure.query(async () => {
    const [response, preferredModels] = await Promise.all([
      getEnhancedOpenRouterModels(),
      getPreferredModels(),
    ]);
    const preferredSet = new Set(preferredModels);

    return (response.data ?? []).map(model => ({
      id: model.id,
      name: model.name,
      supportsVision: model.architecture.input_modalities.includes('image'),
      isPreferred: preferredSet.has(model.id),
    }));
  }),
});
