import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getPreferredModels } from '@/lib/ai-gateway/models';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getCurrentModelIds } from '@/lib/ai-gateway/providers/gateway-models-cache';

export const modelsRouter = createTRPCRouter({
  list: baseProcedure.query(async () => {
    const [response, currentModelIds] = await Promise.all([
      getEnhancedOpenRouterModels(),
      getCurrentModelIds(),
    ]);
    const preferredSet = new Set(getPreferredModels(currentModelIds));

    return (response.data ?? []).map(model => ({
      id: model.id,
      name: model.name,
      supportsVision: model.architecture.input_modalities.includes('image'),
      isPreferred: preferredSet.has(model.id),
    }));
  }),

  currentModelIds: baseProcedure.query(() => getCurrentModelIds()),
});
