import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { PREFERRED_MODELS } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';

export const modelsRouter = createTRPCRouter({
  preferred: baseProcedure.query(() => [...PREFERRED_MODELS]),

  list: baseProcedure.query(async () => {
    const response = await getEnhancedOpenRouterModels();
    const preferredSet = new Set(PREFERRED_MODELS);

    return (response.data ?? []).map(model => ({
      id: model.id,
      name: model.name,
      supportsVision: model.architecture.input_modalities.includes('image'),
      isPreferred: preferredSet.has(model.id),
    }));
  }),
});
