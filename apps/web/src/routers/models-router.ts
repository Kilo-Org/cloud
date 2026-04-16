import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { preferredModels } from '@/lib/ai-gateway/models';
import { getEnhancedOpenRouterModels } from '@/lib/providers/openrouter';

const preferredSet = new Set(preferredModels);

export const modelsRouter = createTRPCRouter({
  list: baseProcedure.query(async () => {
    const response = await getEnhancedOpenRouterModels();

    return (response.data ?? []).map(model => ({
      id: model.id,
      name: model.name,
      supportsVision: model.architecture.input_modalities.includes('image'),
      isPreferred: preferredSet.has(model.id),
    }));
  }),
});
