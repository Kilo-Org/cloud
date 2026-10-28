import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { requestCountryCode } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';

export const modelsRouter = createTRPCRouter({
  preferred: baseProcedure.query(() => getPreferredModels()),

  customPricing: baseProcedure.query(() => getCustomPricingConfig()),

  list: baseProcedure.query(async ({ ctx }) => {
    const [response, preferredModels] = await Promise.all([
      getEnhancedOpenRouterModels({ countryCode: requestCountryCode(ctx.headersList) }),
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
